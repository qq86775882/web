/**
 * Netlify Function: start-job
 *
 * POST /.netlify/functions/start-job
 *
 * 方式1 (JSON): { imageUrl, secret, actionType? }
 * 方式2 (FormData): file, secret, actionType?
 *
 * 完成: 登录 → 下载/上传 → 分割调用
 * 返回: { jobId }  (jobId 中编码了 token、segmentId、imageUrl、进度状态)
 */
import crypto from 'crypto';

const API_SECRET = process.env.API_SECRET || 'qq86775582';
const MYIMG = 'https://api.myimg.ai/api';

export default async function handler(req) {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Use POST' }, { status: 405 });
  }
  try {
    const contentType = req.headers.get('content-type') || '';
    
    let imageUrl, secret, actionType = 'image_undress', file, fileBuf, fileCt;
    
    // ── 方式1: JSON (带 imageUrl) ──
    if (contentType.includes('application/json')) {
      const body = await req.json();
      imageUrl = body.imageUrl;
      secret = body.secret;
      actionType = body.actionType || 'image_undress';
      
      if (secret !== API_SECRET) return Response.json({ error: 'Invalid secret' }, { status: 401 });
      if (!imageUrl) return Response.json({ error: 'Missing imageUrl (or use FormData to upload file)' }, { status: 400 });
      
      console.log(`📷 新任务 (URL): ${imageUrl}`);
    }
    // ── 方式2: FormData (直接上传文件) ──
    else if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      secret = form.get('secret');
      actionType = form.get('actionType') || 'image_undress';
      file = form.get('file');
      
      if (secret !== API_SECRET) return Response.json({ error: 'Invalid secret' }, { status: 401 });
      if (!file) return Response.json({ error: 'Missing file in FormData' }, { status: 400 });
      
      fileBuf = Buffer.from(await file.arrayBuffer());
      fileCt = file.type || 'image/jpeg';
      console.log(`📷 新任务 (文件): ${file.name} ${(fileBuf.length/1024).toFixed(1)}KB`);
    }
    else {
      return Response.json({ error: 'Use Content-Type: application/json or multipart/form-data' }, { status: 400 });
    }

    // ── 登录 ──
    const token = await login();
    console.log('✅ 登录');

    // ── 获取图片 URL ──
    let myUrl;
    if (imageUrl) {
      // 从 URL 下载后上传到 myimg
      const { buf, ct } = await download(imageUrl);
      console.log(`✅ 下载 ${(buf.length/1024).toFixed(1)}KB`);
      myUrl = await upload(token, buf, ct, actionType);
      console.log(`✅ 上传到 myimg`);
    } else {
      // 直接上传 FormData 中的文件
      myUrl = await upload(token, fileBuf, fileCt, actionType);
      console.log(`✅ 上传文件到 myimg`);
    }

    // ── 调用分割 ──
    const segId = await segment(token, myUrl);
    console.log(`✅ 分割请求 ${segId}`);

    // ── 编码 jobId ──
    const jobId = encodeJob({ token, segmentId: segId, imageUrl: myUrl, actionType, stage: 'segmenting' });
    console.log(`🎫 jobId: ${jobId.slice(0,30)}...`);

    return Response.json({ success: true, jobId, imageUrl: myUrl, hint: '轮询 POST /check-job' });

  } catch (e) {
    console.error('❌ 错误:', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ═══ 编码 jobId ═══
function encodeJob(data) {
  const json = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', API_SECRET).update(json).digest('base64url').slice(0, 16);
  return `${json}.${sig}`;
}

// ═══ API 调用 ═══
async function login() {
  const r = await fetch(`${MYIMG}/account/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform:'guest', device:{ userAgent:'API/1.0', lang:'zh-CN', platform:'Linux', screenWidth:1920, screenHeight:1080, screenColorDepth:32, screenPixelDepth:32, audioFingerprint:124.04 }, website:'myimg' })
  });
  const d = await r.json();
  if (!d.result?.token) throw new Error('登录失败: ' + (d.message || JSON.stringify(d)));
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
  if (!d.actionId) throw new Error('分割请求失败: ' + (d.message || JSON.stringify(d)));
  return d.actionId;
}