/**
 * Netlify Function: check-job
 *
 * POST /.netlify/functions/check-job
 * Body: { jobId }
 *
 * 每次调用只做一次轮询，快速返回状态。
 * 客户端持续调用直到 done。支持多任务异步并行。
 */
import crypto from 'crypto';
import { PNG } from 'pngjs';

const MYIMG = 'https://api.myimg.ai/api';
const JOB_SECRET = 'job-secret-key-v1';

export default async function handler(req) {
  if (req.method !== 'POST') return Response.json({ error: 'Use POST' }, { status: 405 });
  try {
    const { jobId } = await req.json();
    if (!jobId) return Response.json({ error: 'Missing jobId' }, { status: 400 });

    const state = decodeJob(jobId);

    // ── 阶段1: 检查分割是否完成 ──
    if (state.stage === 'segmenting') {
      const segResult = await pollOnce(state.token, state.segmentId);
      if (!segResult) return Response.json({ status: 'processing', stage: 'segmenting', hint: '分割中...' });
      if (segResult === 'failed') return Response.json({ error: '分割失败' }, { status: 500 });

      // 分割完成 → 处理 mask → 调 undress
      const colors = segResult.autoSelect || [];
      if (!colors.length) return Response.json({ error: '未识别到可处理区域' }, { status: 400 });

      const maskBuf = await download(segResult.resultUrl);
      const processed = processMask(maskBuf, colors);
      const maskNew = await upload(state.token, processed, 'image/png', state.actionType);
      const undressId = await undress(state.token, state.imageUrl, maskNew);

      return Response.json({
        status: 'processing', stage: 'generating',
        jobId: encodeJob({ ...state, undressId, stage: 'generating' }),
        hint: '正在生成...'
      });
    }

    // ── 阶段2: 检查生成是否完成 ──
    if (state.stage === 'generating') {
      const genResult = await pollOnce(state.token, state.undressId);
      if (!genResult) return Response.json({ status: 'processing', stage: 'generating', hint: '生成中...' });
      if (genResult === 'failed') return Response.json({ error: '生成失败' }, { status: 500 });

      const resultUrl = genResult.resultUrl || genResult.imageUrl;

      // 更新记录
      if (state.recordId) {
        try {
          const selfUrl = req.url.replace(/\/check-job.*/, '/admin?action=completeJob');
          await fetch(selfUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recordId: state.recordId, resultUrl }) });
        } catch (e) {}
      }

      return Response.json({ success: true, resultUrl, status: 'done', hint: '完成!' });
    }

    return Response.json({ error: `Unknown stage: ${state.stage}` }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ═══ 编码 ═══
function encodeJob(d) {
  const j = Buffer.from(JSON.stringify(d)).toString('base64url');
  return `${j}.${crypto.createHmac('sha256', JOB_SECRET).update(j).digest('base64url').slice(0, 16)}`;
}
function decodeJob(id) {
  const [j, s] = id.split('.');
  if (s !== crypto.createHmac('sha256', JOB_SECRET).update(j).digest('base64url').slice(0, 16)) throw new Error('Invalid jobId');
  return JSON.parse(Buffer.from(j, 'base64url').toString());
}

// ═══ 单次轮询 ═══
async function pollOnce(token, actionId) {
  const d = await (await fetch(`${MYIMG}/action/info?action_id=${actionId}&website=myimg`, { headers: { Authorization: token } })).json();
  if (d.result?.response) return JSON.parse(d.result.response);
  if (d.result?.status === 'failed') return 'failed';
  return null; // still processing
}

// ═══ 工具 ═══
async function download(url) { return Buffer.from(await (await fetch(url)).arrayBuffer()); }
async function upload(token, buf, ct, at) {
  const p = await (await fetch(`${MYIMG}/upload/presign?action_type=${at}&content_type=${encodeURIComponent(ct)}`, { method: 'POST', headers: { Authorization: token } })).json();
  await fetch(p.result.presignUrl, { method: 'PUT', headers: { 'Content-Type': ct }, body: buf });
  return p.result.url;
}
async function undress(token, iu, mu) {
  const r = await (await fetch(`${MYIMG}/image/undress`, { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify({ imageUrl: iu, maskUrl: mu, breastSize: 'large', bodyType: 'chubby', advance: true, website: 'myimg' }) })).json();
  if (!r.actionId) throw new Error('undress失败');
  return r.actionId;
}
function processMask(buf, colors) {
  const png = PNG.sync.read(buf);
  const cs = new Set(colors.map(c => c.join(',')));
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const i = (png.width * y + x) << 2;
    cs.has(`${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`)
      ? (png.data[i] = 255, png.data[i + 1] = 255, png.data[i + 2] = 255, png.data[i + 3] = 255)
      : (png.data[i + 3] = 0);
  }
  return PNG.sync.write(png);
}
