/**
 * Netlify Function: check-job
 *
 * POST /.netlify/functions/check-job
 * Body: { jobId, secret }
 *
 * 根据 stage 自动推进: segmenting → generating → done
 * 完成时自动调 admin API 更新作业记录
 */
import crypto from 'crypto';
import { PNG } from 'pngjs';

const MYIMG = 'https://api.myimg.ai/api';

export default async function handler(req) {
  if (req.method !== 'POST') return Response.json({ error: 'Use POST' }, { status: 405 });
  try {
    const { jobId } = await req.json();
    if (!jobId) return Response.json({ error: 'Missing jobId' }, { status: 400 });

    const state = decodeJob(jobId);

    if (state.stage === 'segmenting') {
      const done = await poll(state.token, state.segmentId, 8, 1500);
      if (!done) return Response.json({ status: 'processing', stage: 'segmenting', hint: '分割中，请5秒后重试' });

      const colors = done.autoSelect || [];
      if (!colors.length) throw new Error('未识别到可处理区域');

      const maskBuf = await download(done.resultUrl);
      const processed = processMask(maskBuf, colors);
      const maskNew = await upload(state.token, processed, 'image/png', state.actionType);
      const undressId = await undress(state.token, state.imageUrl, maskNew);

      return Response.json({
        status: 'processing', stage: 'generating',
        jobId: encodeJob({ ...state, undressId, stage: 'generating' }),
        hint: '生成中，请10秒后重试'
      });
    }

    if (state.stage === 'generating') {
      const done = await poll(state.token, state.undressId, 10, 2000);
      if (!done) return Response.json({ status: 'processing', stage: 'generating', hint: '生成中，请10秒后重试' });

      const resultUrl = done.resultUrl || done.imageUrl;

      // ── 更新作业记录 ──
      if (state.recordId) {
        try {
          const selfUrl = req.url.replace(/\/check-job.*/, '/admin?action=completeJob');
          await fetch(selfUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recordId: state.recordId, resultUrl })
          });
        } catch (e) { console.warn('⚠️ 记录更新失败:', e.message); }
      }

      return Response.json({ success: true, resultUrl, status: 'done', hint: '处理完成!' });
    }

    return Response.json({ error: `Unknown stage: ${state.stage}` }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

function encodeJob(d) {
  const j = Buffer.from(JSON.stringify(d)).toString('base64url');
  return `${j}.${crypto.createHmac('sha256', 'start-job-secret').update(j).digest('base64url').slice(0, 16)}`;
}
function decodeJob(id) {
  const [j, s] = id.split('.');
  if (s !== crypto.createHmac('sha256', 'start-job-secret').update(j).digest('base64url').slice(0, 16)) throw new Error('Invalid jobId');
  return JSON.parse(Buffer.from(j, 'base64url').toString());
}

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
async function poll(token, aid, max, iv) {
  for (let i = 0; i < max; i++) {
    await new Promise(r => setTimeout(r, iv));
    const d = await (await fetch(`${MYIMG}/action/info?action_id=${aid}&website=myimg`, { headers: { Authorization: token } })).json();
    if (d.result?.response) return JSON.parse(d.result.response);
    if (d.result?.status === 'failed') throw new Error('处理失败');
  }
  return null;
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
