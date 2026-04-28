/**
 * Netlify Function: start-job
 *
 * POST /.netlify/functions/start-job
 * Body: { imageUrl, secret, actionType? }
 *
 * 完成: 登录 → 下载 → 上传 → 分割调用
 * 返回: { jobId }  (jobId 中编码了 token、segmentId、imageUrl、进度状态)
 */
import crypto from 'crypto';

const API_SECRET = process.env.API_SECRET || 'default-secret-CHANGE-ME';
const MYIMG = 'https://api.myimg.ai/api';

export default async function handler(req) {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Use POST' }, { status: 405 });
  }
  try {
    const { imageUrl, secret, actionType = 'image_undress' } = await req.json();
    if (secret !== API_SECRET) return Response.json({ error: 'Invalid secret' }, { status: 401 });
    if (!imageUrl) return Response.json({ error: 'Missing imageUrl' }, { status: 400 });

    console.log(`📷 新任务: ${imageUrl}`);

    const token = await login();
    console.log('✅ 登录');

    const { buf, ct } = await download(imageUrl);
    console.log(`✅ 下载 ${(buf.length/1024).toFixed(1)}KB`);

    const myUrl = await upload(token, buf, ct, actionType);
    console.log(`✅ 上传`);

    const segId = await segment(token, myUrl);
    console.log(`✅ 分割请求 ${segId}`);

    // 编码 jobId: { token, segmentId, imageUrl, actionType, stage }
    const jobId = encodeJob({ token, segmentId: segId, imageUrl: myUrl, actionType, stage: 'segmenting' });
    console.log(`🎫 jobId: ${jobId.slice(0,20)}...`);

    return Response.json({ success: true, jobId, hint: '轮询 POST /check-job' });

  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ═══ 编码/解码 ═══
function encodeJob(data) {
  const json = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', API_SECRET).update(json).digest('base64url').slice(0, 16);
  return `${json}.${sig}`;
}

function decodeJob(jobId) {
  const [json, sig] = jobId.split('.');
  const expected = crypto.createHmac('sha256', API_SECRET).update(json).digest('base64url').slice(0, 16);
  if (sig !== expected) throw new Error('Invalid jobId signature');
  return JSON.parse(Buffer.from(json, 'base64url').toString());
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
  await fetch(pu, { method:'PUT', headers:{'Content-Type':ct}, body:buf });
  return iu;
}

async function segment(token, imageUrl) {
  const r = await fetch(`${MYIMG}/image/segment`, {
    method:'POST', headers:{Authorization:token, 'Content-Type':'application/json'},
    body: JSON.stringify({ imageUrl, website:'myimg' })
  });
  const d = await r.json();
  if (!d.actionId) throw new Error('分割失败');
  return d.actionId;
}
