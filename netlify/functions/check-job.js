/**
 * Netlify Function: check-job
 *
 * POST /.netlify/functions/check-job
 * Body: { jobId, secret }
 *
 * jobId 解码后包含: token, segmentId, imageUrl, actionType, stage, recordId
 *
 * 根据 stage 自动推进:
 *   "segmenting" → 轮询分割 → mask处理 → undress → stage变为"generating"
 *   "generating" → 轮询undress → 返回最终结果
 *
 * 完成时自动更新作业记录(recordId)
 */
import crypto from 'crypto';
import { PNG } from 'pngjs';
import { getStore } from '@netlify/blobs';

const DEFAULT_SECRET = 'qq86775582';
const MYIMG = 'https://api.myimg.ai/api';

export default async function handler(req) {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Use POST' }, { status: 405 });
  }
  try {
    const { jobId, secret } = await req.json();
    if (secret !== DEFAULT_SECRET) return Response.json({ error: 'Invalid secret' }, { status: 401 });
    if (!jobId) return Response.json({ error: 'Missing jobId' }, { status: 400 });

    const state = decodeJob(jobId);
    console.log(`🔍 检查 job: stage=${state.stage}`);

    // ── 阶段1：等待分割 → mask处理 → undress ──
    if (state.stage === 'segmenting') {
      const segDone = await poll(state.token, state.segmentId, 8, 1500);
      if (!segDone) {
        return Response.json({ status: 'processing', stage: 'segmenting', hint: '分割中，请5秒后重试' });
      }

      const maskUrl = segDone.resultUrl;
      const colors = segDone.autoSelect || [];
      if (!colors.length) throw new Error('AI 未识别到可处理区域');
      console.log(`✅ 分割完成, ${colors.length}色`);

      const maskBuf = await download(maskUrl);
      const processed = processMask(maskBuf, colors);
      console.log(`✅ mask处理完成`);

      const maskNew = await upload(state.token, processed, 'image/png', state.actionType);
      console.log(`✅ mask上传`);

      const undressId = await undress(state.token, state.imageUrl, maskNew);
      console.log(`✅ undress ${undressId}`);

      const newJobId = encodeJob({ ...state, undressId, stage: 'generating' });
      return Response.json({ status: 'processing', stage: 'generating', jobId: newJobId, hint: '生成中，请10秒后重试' });
    }

    // ── 阶段2：等待生成 → 返回结果 ──
    if (state.stage === 'generating') {
      const genDone = await poll(state.token, state.undressId, 10, 2000);
      if (!genDone) {
        return Response.json({ status: 'processing', stage: 'generating', hint: '生成中，请10秒后重试' });
      }

      const resultUrl = genDone.resultUrl || genDone.imageUrl;
      console.log(`🎉 完成! ${resultUrl}`);

      // ── 更新作业记录 ──
      if (state.recordId) {
        try {
          const store = getStore('imgproc');
          const raw = await store.get('jobs', { consistency: 'strong' });
          const jobs = raw ? JSON.parse(raw) : [];
          const idx = jobs.findIndex(j => j.id === state.recordId);
          if (idx !== -1) {
            jobs[idx].status = 'done';
            jobs[idx].resultUrl = resultUrl;
            jobs[idx].completedAt = new Date().toISOString();
            await store.set('jobs', JSON.stringify(jobs));
            console.log(`📝 更新记录: ${state.recordId}`);
          }
        } catch (e) { console.warn('⚠️ 记录更新失败:', e.message); }
      }

      return Response.json({ success: true, resultUrl, status: 'done', hint: '处理完成!' });
    }

    return Response.json({ error: `Unknown stage: ${state.stage}` }, { status: 400 });

  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ═══ 编码/解码 ═══
function encodeJob(data) {
  const json = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', DEFAULT_SECRET).update(json).digest('base64url').slice(0, 16);
  return `${json}.${sig}`;
}

function decodeJob(jobId) {
  const [json, sig] = jobId.split('.');
  const expected = crypto.createHmac('sha256', DEFAULT_SECRET).update(json).digest('base64url').slice(0, 16);
  if (sig !== expected) throw new Error('Invalid jobId');
  return JSON.parse(Buffer.from(json, 'base64url').toString());
}

// ═══ 工具函数 ═══
async function download(url) {
  const r = await fetch(url);
  return Buffer.from(await r.arrayBuffer());
}

async function upload(token, buf, ct, at) {
  const pr = await fetch(`${MYIMG}/upload/presign?action_type=${at}&content_type=${encodeURIComponent(ct)}`, { method:'POST', headers:{Authorization:token} });
  const pd = await pr.json();
  const pu = pd.result?.presignUrl, iu = pd.result?.url;
  await fetch(pu, { method:'PUT', headers:{'Content-Type':ct}, body:buf });
  return iu;
}

async function undress(token, imageUrl, maskUrl) {
  const r = await fetch(`${MYIMG}/image/undress`, {
    method:'POST', headers:{Authorization:token, 'Content-Type':'application/json'},
    body: JSON.stringify({ imageUrl, maskUrl, breastSize:'large', bodyType:'chubby', advance:true, website:'myimg' })
  });
  const d = await r.json();
  if (!d.actionId) throw new Error('undress失败');
  return d.actionId;
}

async function poll(token, actionId, maxTries, interval) {
  for (let i = 0; i < maxTries; i++) {
    await new Promise(r => setTimeout(r, interval));
    const r = await fetch(`${MYIMG}/action/info?action_id=${actionId}&website=myimg`, { headers:{Authorization:token} });
    const d = await r.json();
    if (d.result?.response) return JSON.parse(d.result.response);
    if (d.result?.status === 'failed') throw new Error('处理失败');
    console.log(`  ⏳ 第${i+1}次: ${d.result?.status}`);
  }
  return null;
}

function processMask(buf, targetColors) {
  const png = PNG.sync.read(buf);
  const colorSet = new Set(targetColors.map(c => c.join(',')));
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (png.width * y + x) << 2;
      const key = `${png.data[idx]},${png.data[idx+1]},${png.data[idx+2]}`;
      if (colorSet.has(key)) {
        png.data[idx] = 255; png.data[idx+1] = 255; png.data[idx+2] = 255; png.data[idx+3] = 255;
      } else {
        png.data[idx+3] = 0;
      }
    }
  }
  return PNG.sync.write(png);
}
