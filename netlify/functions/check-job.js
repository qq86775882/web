/**
 * Netlify Function: check-job
 *
 * POST /.netlify/functions/check-job
 * Body: { jobId, secret }
 *
 * 根据 stage 自动推进: segmenting → generating → done
 * 完成时自动更新 Blobs 作业记录
 */
import crypto from 'crypto';
import { PNG } from 'pngjs';

const DEFAULT_SECRET = process.env.API_SECRET || 'qq86775582';
const MYIMG = 'https://api.myimg.ai/api';

let _store = null;
async function getBlobStore() {
  if (_store) return _store;
  try {
    const { getStore } = await import('@netlify/blobs');
    _store = getStore('imgproc');
  } catch (e) { _store = null; }
  return _store;
}

async function updateJobRecord(recordId, resultUrl) {
  if (!recordId) return;
  const store = await getBlobStore();
  if (!store) return;
  try {
    const raw = await store.get('jobs', { consistency: 'strong' });
    const jobs = raw ? JSON.parse(raw) : [];
    const idx = jobs.findIndex(j => j.id === recordId);
    if (idx !== -1) {
      jobs[idx].status = 'done';
      jobs[idx].resultUrl = resultUrl;
      jobs[idx].completedAt = new Date().toISOString();
      await store.set('jobs', JSON.stringify(jobs));
    }
  } catch (e) { console.warn('⚠️ 更新失败:', e.message); }
}

export default async function handler(req) {
  if (req.method !== 'POST') return Response.json({ error: 'Use POST' }, { status: 405 });
  try {
    const { jobId, secret } = await req.json();
    if (secret !== DEFAULT_SECRET) return Response.json({ error: 'Invalid secret' }, { status: 401 });
    if (!jobId) return Response.json({ error: 'Missing jobId' }, { status: 400 });

    const state = decodeJob(jobId);

    // ── 阶段1: segmenting → mask → undress ──
    if (state.stage === 'segmenting') {
      const done = await poll(state.token, state.segmentId, 8, 1500);
      if (!done) return Response.json({ status: 'processing', stage: 'segmenting', hint: '分割中，请5秒后重试' });
      
      const colors = done.autoSelect || [];
      if (!colors.length) throw new Error('未识别到可处理区域');
      
      const maskBuf = await dl(done.resultUrl);
      const processed = processMask(maskBuf, colors);
      const maskNew = await up(state.token, processed, 'image/png', state.actionType);
      const undressId = await undress(state.token, state.imageUrl, maskNew);
      
      return Response.json({ status: 'processing', stage: 'generating', jobId: encodeJob({ ...state, undressId, stage: 'generating' }), hint: '生成中，请10秒后重试' });
    }

    // ── 阶段2: generating → done ──
    if (state.stage === 'generating') {
      const done = await poll(state.token, state.undressId, 10, 2000);
      if (!done) return Response.json({ status: 'processing', stage: 'generating', hint: '生成中，请10秒后重试' });
      
      const resultUrl = done.resultUrl || done.imageUrl;
      await updateJobRecord(state.recordId, resultUrl);
      return Response.json({ success: true, resultUrl, status: 'done', hint: '处理完成!' });
    }

    return Response.json({ error: `Unknown stage: ${state.stage}` }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

function encodeJob(d) {
  const j = Buffer.from(JSON.stringify(d)).toString('base64url');
  return `${j}.${crypto.createHmac('sha256', DEFAULT_SECRET).update(j).digest('base64url').slice(0,16)}`;
}
function decodeJob(id) {
  const [j,s] = id.split('.');
  if (s !== crypto.createHmac('sha256', DEFAULT_SECRET).update(j).digest('base64url').slice(0,16)) throw new Error('Invalid jobId');
  return JSON.parse(Buffer.from(j, 'base64url').toString());
}

async function dl(url) { return Buffer.from(await (await fetch(url)).arrayBuffer()); }
async function up(token, buf, ct, at) {
  const p = await (await fetch(`${MYIMG}/upload/presign?action_type=${at}&content_type=${encodeURIComponent(ct)}`, { method:'POST', headers:{Authorization:token} })).json();
  await fetch(p.result.presignUrl, { method:'PUT', headers:{'Content-Type':ct}, body:buf });
  return p.result.url;
}
async function undress(token, iu, mu) {
  const r = await (await fetch(`${MYIMG}/image/undress`, { method:'POST', headers:{Authorization:token, 'Content-Type':'application/json'}, body: JSON.stringify({ imageUrl:iu, maskUrl:mu, breastSize:'large', bodyType:'chubby', advance:true, website:'myimg' }) })).json();
  if (!r.actionId) throw new Error('undress失败');
  return r.actionId;
}
async function poll(token, aid, max, iv) {
  for (let i=0;i<max;i++) {
    await new Promise(r=>setTimeout(r,iv));
    const d = await (await fetch(`${MYIMG}/action/info?action_id=${aid}&website=myimg`, { headers:{Authorization:token} })).json();
    if (d.result?.response) return JSON.parse(d.result.response);
    if (d.result?.status==='failed') throw new Error('处理失败');
  }
  return null;
}
function processMask(buf, colors) {
  const png = PNG.sync.read(buf);
  const cs = new Set(colors.map(c=>c.join(',')));
  for (let y=0;y<png.height;y++) for (let x=0;x<png.width;x++) {
    const i=(png.width*y+x)<<2;
    cs.has(`${png.data[i]},${png.data[i+1]},${png.data[i+2]}`) ? (png.data[i]=255,png.data[i+1]=255,png.data[i+2]=255,png.data[i+3]=255) : (png.data[i+3]=0);
  }
  return PNG.sync.write(png);
}
