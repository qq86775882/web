/**
 * Netlify Function: start-job
 *
 * POST /.netlify/functions/start-job
 *
 * 方式1 (JSON): { imageUrl, secret, actionType? }
 * 方式2 (FormData): file, secret, actionType?
 *
 * secret 默认值: qq86775582
 * 管理后台可配置多个密钥: GET /admin.html
 */
import crypto from 'crypto';

const DEFAULT_SECRET = 'qq86775582';
const MYIMG = 'https://api.myimg.ai/api';

export default async function handler(req) {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Use POST' }, { status: 405 });
  }
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
      return Response.json({ error: 'Use Content-Type: application/json or multipart/form-data' }, { status: 400 });
    }

    if (secret !== DEFAULT_SECRET) return Response.json({ error: '密钥无效' }, { status: 401 });

    const token = await login();

    let myUrl;
    if (imageUrl) {
      const { buf, ct } = await download(imageUrl);
      myUrl = await upload(token, buf, ct, actionType);
    } else {
      myUrl = await upload(token, fileBuf, fileCt, actionType);
    }

    const segId = await segment(token, myUrl);
    const jobId = encodeJob({ token, segmentId: segId, imageUrl: myUrl, actionType, stage: 'segmenting' });

    return Response.json({ success: true, jobId, imageUrl: myUrl, hint: '轮询 POST /check-job' });

  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

function encodeJob(data) {
  const json = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', DEFAULT_SECRET).update(json).digest('base64url').slice(0, 16);
  return `${json}.${sig}`;
}

async function login() {
  const r = await fetch(`${MYIMG}/account/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'guest', device: { userAgent: 'API/1.0', lang: 'zh-CN', platform: 'Linux', screenWidth: 1920, screenHeight: 1080, screenColorDepth: 32, screenPixelDepth: 32, audioFingerprint: 124.04 }, website: 'myimg' })
  });
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
  if (!pu) throw new Error('获取预签名URL失败');
  await fetch(pu, { method: 'PUT', headers: { 'Content-Type': ct }, body: buf });
  return iu;
}

async function segment(token, imageUrl) {
  const r = await fetch(`${MYIMG}/image/segment`, {
    method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl, website: 'myimg' })
  });
  const d = await r.json();
  if (!d.actionId) throw new Error('分割请求失败');
  return d.actionId;
}
