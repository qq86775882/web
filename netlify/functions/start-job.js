/**
 * Netlify Function: start-job
 *
 * POST /.netlify/functions/start-job
 *
 * 方式1 (JSON): { imageUrl, secret, actionType? }
 * 方式2 (FormData): file, secret, actionType?
 *
 * 完成: 登录 → 下载/上传 → 分割调用
 * 返回: { jobId }
 */
import crypto from 'crypto';

const DEFAULT_SECRET = process.env.API_SECRET || 'qq86775582';
const MYIMG = 'https://api.myimg.ai/api';

// 懒加载 Blobs store（避免冷启动时阻塞）
let _store = null;
async function getBlobStore() {
  if (_store) return _store;
  try {
    const { getStore } = await import('@netlify/blobs');
    _store = getStore('imgproc');
  } catch (e) {
    _store = null; // Blobs 不可用，回退到无记录模式
  }
  return _store;
}

// 密钥验证（支持 Blobs 多密钥 + 回退到默认密钥）
async function verifySecret(secret) {
  // 默认密钥始终有效
  if (secret === DEFAULT_SECRET) return { ok: true, keyId: 'default' };

  // 尝试从 Blobs 读取密钥列表
  const store = await getBlobStore();
  if (!store) return { ok: false, error: '密钥无效' };

  try {
    const raw = await store.get('keys', { consistency: 'strong' });
    if (!raw) return { ok: false, error: '密钥无效' };
    const keys = JSON.parse(raw).filter(k => k.enabled);
    const match = keys.find(k => k.key === secret && k.used < k.quota);
    if (match) return { ok: true, keyId: match.id };
    const any = keys.find(k => k.used < k.quota);
    if (any) return { ok: true, keyId: any.id, rotated: any.key };
    return { ok: false, error: '所有密钥配额已用完' };
  } catch (e) {
    return { ok: false, error: '密钥验证失败' };
  }
}

async function recordJob(keyId, imageUrl) {
  const store = await getBlobStore();
  if (!store) return null;
  try {
    const id = 'j' + Date.now();
    // 扣配额
    if (keyId !== 'default') {
      const rawK = await store.get('keys', { consistency: 'strong' });
      if (rawK) {
        const keys = JSON.parse(rawK);
        const ki = keys.findIndex(k => k.id === keyId);
        if (ki !== -1) { keys[ki].used = (keys[ki].used || 0) + 1; }
        await store.set('keys', JSON.stringify(keys));
      }
    }
    // 记录作业
    const rawJ = await store.get('jobs', { consistency: 'strong' });
    const jobs = rawJ ? JSON.parse(rawJ) : [];
    jobs.push({ id, imageUrl, resultUrl: null, status: 'processing', keyId, createdAt: new Date().toISOString(), completedAt: null });
    await store.set('jobs', JSON.stringify(jobs));
    return id;
  } catch (e) {
    console.warn('⚠️ 记录失败:', e.message);
    return null;
  }
}

// ═══ 主函数 ═══
export default async function handler(req) {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Use POST' }, { status: 405 });
  }
  try {
    const contentType = req.headers.get('content-type') || '';
    let imageUrl, secret, actionType = 'image_undress', fileBuf, fileCt;

    // ── 解析请求 ──
    if (contentType.includes('application/json')) {
      const body = await req.json();
      imageUrl = body.imageUrl; secret = body.secret;
      actionType = body.actionType || 'image_undress';
      if (!imageUrl) return Response.json({ error: 'Missing imageUrl' }, { status: 400 });
    } else if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      secret = form.get('secret'); actionType = form.get('actionType') || 'image_undress';
      const file = form.get('file');
      if (!file) return Response.json({ error: 'Missing file' }, { status: 400 });
      fileBuf = Buffer.from(await file.arrayBuffer());
      fileCt = file.type || 'image/jpeg';
    } else {
      return Response.json({ error: 'Use Content-Type: application/json or multipart/form-data' }, { status: 400 });
    }

    // ── 密钥验证 ──
    const auth = await verifySecret(secret || '');
    if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
    if (auth.rotated) { secret = auth.rotated; console.log('🔄 密钥轮换'); }

    // ── 登录 ──
    const token = await login();

    // ── 上传 ──
    let myUrl;
    if (imageUrl) {
      const { buf, ct } = await download(imageUrl);
      myUrl = await upload(token, buf, ct, actionType);
    } else {
      myUrl = await upload(token, fileBuf, fileCt, actionType);
    }

    // ── 分割 ──
    const segId = await segment(token, myUrl);

    // ── 记录作业 ──
    const recordId = await recordJob(auth.keyId, myUrl);

    // ── 编码 jobId ──
    const jobId = encodeJob({ token, segmentId: segId, imageUrl: myUrl, actionType, stage: 'segmenting', recordId });

    return Response.json({ success: true, jobId, imageUrl: myUrl, hint: '轮询 POST /check-job' });

  } catch (e) {
    console.error('❌', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ═══ 编码 ═══
function encodeJob(data) {
  const json = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', DEFAULT_SECRET).update(json).digest('base64url').slice(0, 16);
  return `${json}.${sig}`;
}

// ═══ API ═══
async function login() {
  const r = await fetch(`${MYIMG}/account/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ platform:'guest', device:{ userAgent:'API/1.0', lang:'zh-CN', platform:'Linux', screenWidth:1920, screenHeight:1080, screenColorDepth:32, screenPixelDepth:32, audioFingerprint:124.04 }, website:'myimg' }) });
  const d = await r.json();
  if (!d.result?.token) throw new Error('登录失败');
  return d.result.token;
}
async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下载失败 ${r.status}`);
  return { buf: Buffer.from(await r.arrayBuffer()), ct: r.headers.get('content-type')||'image/jpeg' };
}
async function upload(token, buf, ct, at) {
  const pr = await fetch(`${MYIMG}/upload/presign?action_type=${at}&content_type=${encodeURIComponent(ct)}`, { method:'POST', headers:{Authorization:token} });
  const pd = await pr.json();
  const pu = pd.result?.presignUrl, iu = pd.result?.url;
  if (!pu) throw new Error('预签名失败');
  await fetch(pu, { method:'PUT', headers:{'Content-Type':ct}, body:buf });
  return iu;
}
async function segment(token, imageUrl) {
  const r = await fetch(`${MYIMG}/image/segment`, { method:'POST', headers:{Authorization:token, 'Content-Type':'application/json'}, body: JSON.stringify({ imageUrl, website:'myimg' }) });
  const d = await r.json();
  if (!d.actionId) throw new Error('分割失败');
  return d.actionId;
}
