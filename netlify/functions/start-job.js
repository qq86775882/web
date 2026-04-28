/**
 * Netlify Function: start-job
 *
 * POST /.netlify/functions/start-job
 * Body: FormData { file, secret } 或 JSON { imageUrl, secret }
 *
 * secret 从后台管理生成，不同用户独立配额。
 * 配额用完禁止处理。
 */
import crypto from 'crypto';

const MYIMG = 'https://api.myimg.ai/api';
const JOB_SECRET = 'job-secret-key-v1';

// 懒加载 Blobs
let _store = null;
async function getStore() {
  if (_store) return _store;
  const { getStore } = await import('@netlify/blobs');
  _store = getStore('imgproc');
  return _store;
}

export default async function handler(req) {
  if (req.method !== 'POST') return Response.json({ error: 'Use POST' }, { status: 405 });
  try {
    const contentType = req.headers.get('content-type') || '';
    let imageUrl, secret, actionType = 'image_undress', fileBuf, fileCt;

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
      return Response.json({ error: 'Use JSON or FormData' }, { status: 400 });
    }

    if (!secret) return Response.json({ error: '请提供 secret 密钥' }, { status: 401 });

    // ── 验证密钥 + 检查配额 ──
    let keyInfo = null;
    try {
      const store = await getStore();
      const raw = await store.get('keys', { consistency: 'strong' });
      if (!raw) return Response.json({ error: '密钥系统未初始化，请先登录后台生成密钥' }, { status: 500 });
      const keys = JSON.parse(raw);
      const match = keys.find(k => k.key === secret && k.enabled);
      if (!match) return Response.json({ error: '密钥无效或已禁用' }, { status: 401 });
      if (match.used >= match.quota) return Response.json({ error: '配额已用完', quota: match.quota, remaining: 0 }, { status: 403 });
      keyInfo = match;
    } catch (e) {
      // Blobs 不可用时的备用密钥
      if (secret !== 'qq86775582') return Response.json({ error: '密钥无效' }, { status: 401 });
      keyInfo = { id: 'default', quota: 9999, used: 0 };
    }

    // ── 登录 myimg ──
    const token = await login();

    // ── 上传图片 ──
    let myUrl;
    if (imageUrl) {
      const { buf, ct } = await download(imageUrl);
      myUrl = await upload(token, buf, ct, actionType);
    } else {
      myUrl = await upload(token, fileBuf, fileCt, actionType);
    }

    // ── 扣配额 + 记录作业 ──
    const recordId = 'j' + Date.now();
    try {
      const store = await getStore();
      // 扣配额
      const rawK = await store.get('keys', { consistency: 'strong' });
      const keys = JSON.parse(rawK);
      const ki = keys.findIndex(k => k.id === keyInfo.id);
      if (ki !== -1) keys[ki].used = (keys[ki].used || 0) + 1;
      await store.set('keys', JSON.stringify(keys));
      keyInfo.used = keys[ki].used;
      // 记录作业
      const rawJ = await store.get('jobs', { consistency: 'strong' });
      const jobs = rawJ ? JSON.parse(rawJ) : [];
      jobs.push({ id: recordId, imageUrl: myUrl, resultUrl: null, status: 'processing', keyId: keyInfo.id, createdAt: new Date().toISOString() });
      await store.set('jobs', JSON.stringify(jobs));
    } catch (e) { console.warn('记录失败:', e.message); }

    // ── 分割 ──
    const segId = await segment(token, myUrl);

    // ── 编码 jobId ──
    const jobId = encodeJob({ token, segmentId: segId, imageUrl: myUrl, actionType, stage: 'segmenting', recordId });

    return Response.json({
      success: true, jobId, imageUrl: myUrl,
      quota: { quota: keyInfo.quota, remaining: keyInfo.quota - keyInfo.used },
      hint: '轮询 POST /check-job'
    });

  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

function encodeJob(d) {
  const j = Buffer.from(JSON.stringify(d)).toString('base64url');
  return `${j}.${crypto.createHmac('sha256', JOB_SECRET).update(j).digest('base64url').slice(0, 16)}`;
}

async function login() {
  const r = await fetch(`${MYIMG}/account/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'guest', device: { userAgent: 'API/1.0', lang: 'zh-CN', platform: 'Linux', screenWidth: 1920, screenHeight: 1080, screenColorDepth: 32, screenPixelDepth: 32, audioFingerprint: 124.04 }, website: 'myimg' }) });
  const d = await r.json();
  if (!d.result?.token) throw new Error('登录失败');
  return d.result.token;
}
async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下载失败 ${r.status}`);
  return { buf: Buffer.from(await r.arrayBuffer()), ct: r.headers.get('content-type') || 'image/jpeg' };
}
async function upload(token, buf, ct, at) {
  const pr = await fetch(`${MYIMG}/upload/presign?action_type=${at}&content_type=${encodeURIComponent(ct)}`, { method: 'POST', headers: { Authorization: token } });
  const pd = await pr.json();
  const pu = pd.result?.presignUrl, iu = pd.result?.url;
  if (!pu) throw new Error('预签名失败');
  await fetch(pu, { method: 'PUT', headers: { 'Content-Type': ct }, body: buf });
  return iu;
}
async function segment(token, imageUrl) {
  const r = await fetch(`${MYIMG}/image/segment`, { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify({ imageUrl, website: 'myimg' }) });
  const d = await r.json();
  if (!d.actionId) throw new Error('分割失败');
  return d.actionId;
}