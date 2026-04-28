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
import { getStore } from '@netlify/blobs';

const DEFAULT_SECRET = 'qq86775582';
const MYIMG = 'https://api.myimg.ai/api';

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
      console.log(`📷 新任务 (URL): ${imageUrl}`);
    } else if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      secret = form.get('secret'); actionType = form.get('actionType') || 'image_undress';
      const file = form.get('file');
      if (!file) return Response.json({ error: 'Missing file' }, { status: 400 });
      fileBuf = Buffer.from(await file.arrayBuffer());
      fileCt = file.type || 'image/jpeg';
      console.log(`📷 新任务 (文件): ${file.name} ${(fileBuf.length/1024).toFixed(1)}KB`);
    } else {
      return Response.json({ error: 'Use Content-Type: application/json or multipart/form-data' }, { status: 400 });
    }

    // ── 验证密钥(支持多密钥轮换) ──
    let usedKeyId = null;
    let keyOK = (secret === DEFAULT_SECRET); // 默认密钥

    try {
      const store = getStore('imgproc');
      const raw = await store.get('keys', { consistency: 'strong' });
      if (raw) {
        const keys = JSON.parse(raw).filter(k => k.enabled);
        for (const k of keys) {
          if (k.key === secret && k.used < k.quota) {
            keyOK = true; usedKeyId = k.id; break;
          }
        }
        if (!keyOK && keys.length > 0) {
          // 用户没匹配到，自动轮换第一个可用的
          const available = keys.find(k => k.used < k.quota);
          if (available) {
            secret = available.key;
            keyOK = true; usedKeyId = available.id;
            console.log(`🔄 自动轮换到密钥: ${available.label || available.id}`);
          }
        }
      }
    } catch (e) { /* Blobs 不可用时回退到默认密钥 */ }

    if (!keyOK) return Response.json({ error: '密钥无效或配额已用完' }, { status: 401 });

    // ── 登录 ──
    const token = await login();
    console.log('✅ 登录');

    // ── 上传 ──
    let myUrl;
    if (imageUrl) {
      const { buf, ct } = await download(imageUrl);
      console.log(`✅ 下载 ${(buf.length/1024).toFixed(1)}KB`);
      myUrl = await upload(token, buf, ct, actionType);
    } else {
      myUrl = await upload(token, fileBuf, fileCt, actionType);
    }
    console.log(`✅ 上传到 myimg`);

    // ── 分割 ──
    const segId = await segment(token, myUrl);
    console.log(`✅ 分割请求 ${segId}`);

    // ── 记录作业 + 扣减配额 ──
    const jobRecordId = 'j' + Date.now();
    try {
      const store = getStore('imgproc');
      // 扣配额
      if (usedKeyId) {
        const rawK = await store.get('keys', { consistency: 'strong' });
        const keys = JSON.parse(rawK);
        const ki = keys.findIndex(k => k.id === usedKeyId);
        if (ki !== -1) keys[ki].used = (keys[ki].used || 0) + 1;
        await store.set('keys', JSON.stringify(keys));
      }
      // 记录作业
      const rawJ = await store.get('jobs', { consistency: 'strong' });
      const jobs = rawJ ? JSON.parse(rawJ) : [];
      jobs.push({
        id: jobRecordId,
        imageUrl: myUrl,
        resultUrl: null,
        status: 'processing',
        keyId: usedKeyId || 'default',
        createdAt: new Date().toISOString(),
        completedAt: null
      });
      await store.set('jobs', JSON.stringify(jobs));
      console.log(`📝 作业记录: ${jobRecordId}`);
    } catch (e) { console.warn('⚠️ 记录失败:', e.message); }

    // ── 编码 jobId ──
    const jobId = encodeJob({ token, segmentId: segId, imageUrl: myUrl, actionType, stage: 'segmenting', recordId: jobRecordId });

    return Response.json({ success: true, jobId, imageUrl: myUrl, hint: '轮询 POST /check-job' });

  } catch (e) {
    console.error('❌ 错误:', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ═══ 编码 ═══
function encodeJob(data) {
  const json = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', DEFAULT_SECRET).update(json).digest('base64url').slice(0, 16);
  return `${json}.${sig}`;
}

// ═══ API 调用 ═══
async function login() {
  const r = await fetch(`${MYIMG}/account/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform:'guest', device:{ userAgent:'API/1.0', lang:'zh-CN', platform:'Linux', screenWidth:1920, screenHeight:1080, screenColorDepth:32, screenPixelDepth:32, audioFingerprint:124.04 }, website:'myimg' })
  });
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
  if (!pu) throw new Error('获取预签名URL失败');
  await fetch(pu, { method:'PUT', headers:{'Content-Type':ct}, body:buf });
  return iu;
}

async function segment(token, imageUrl) {
  const r = await fetch(`${MYIMG}/image/segment`, {
    method:'POST', headers:{Authorization:token, 'Content-Type':'application/json'},
    body: JSON.stringify({ imageUrl, website:'myimg' })
  });
  const d = await r.json();
  if (!d.actionId) throw new Error('分割请求失败');
  return d.actionId;
}
