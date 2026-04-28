/**
 * Netlify Function: admin
 * 后台管理 API + 密钥验证
 *
 * 公开接口（无需登录）:
 *   POST ?action=login        { username, password }
 *   POST ?action=verifyKey    { key, imageUrl? }  → start-job 调用
 *   POST ?action=completeJob  { recordId, resultUrl }  → check-job 调用
 *
 * 管理接口（需要 Bearer token）:
 *   GET  ?action=listKeys / listJobs / stats
 *   POST ?action=addKey / updateKey / deleteKey / clearJobs
 */
import crypto from 'crypto';

// ═══ 管理账号 ═══
const ADMIN_USER = 'admin';
const ADMIN_PASS = '123456';
const TOKEN_SECRET = 'imgproc-admin-secret-key';

// ═══ 懒加载 Blobs ═══
let _store = null;
async function store() {
  if (_store) return _store;
  const { getStore } = await import('@netlify/blobs');
  _store = getStore('imgproc');
  return _store;
}

// ═══ Token ═══
function signToken(username) {
  const payload = `${username}:${Date.now() + 86400000}`; // 24h
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}
function verifyToken(token) {
  try {
    const raw = Buffer.from(token, 'base64url').toString();
    const parts = raw.split(':');
    const sig = parts.pop();
    const payload = parts.join(':');
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
    if (sig !== expected) return null;
    const [username, expires] = payload.split(':');
    if (Date.now() > parseInt(expires)) return null;
    return username;
  } catch { return null; }
}

// ═══ 主路由 ═══
export default async function handler(req) {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || '';
  let body = {};
  try { if (req.method === 'POST') body = await req.json(); } catch {}

  try {
    // ── 公开接口 ──
    if (action === 'login')  return doLogin(body);
    if (action === 'verifyKey') return doVerifyKey(body);
    if (action === 'completeJob') return doCompleteJob(body);

    // ── 需要登录的管理接口 ──
    const auth = req.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!verifyToken(token)) return Response.json({ error: '请先登录' }, { status: 401 });

    switch (action) {
      case 'listKeys':   return doListKeys();
      case 'addKey':     return doAddKey(body);
      case 'updateKey':  return doUpdateKey(body);
      case 'deleteKey':  return doDeleteKey(body);
      case 'listJobs':   return doListJobs(url);
      case 'stats':      return doStats();
      case 'clearJobs':  return doClearJobs();
      default: return Response.json({ error: '未知操作' }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ═══ 公开接口 ═══

async function doLogin(body) {
  if (body.username !== ADMIN_USER || body.password !== ADMIN_PASS) {
    return Response.json({ error: '账号或密码错误' }, { status: 401 });
  }
  return Response.json({ ok: true, token: signToken(ADMIN_USER), username: ADMIN_USER });
}

async function doVerifyKey(body) {
  if (!body.key) return Response.json({ error: '缺少 key' }, { status: 400 });

  const s = await store();
  const raw = await s.get('keys', { consistency: 'strong' });
  const keys = raw ? JSON.parse(raw) : [];
  const match = keys.find(k => k.key === body.key && k.enabled);

  if (!match) return Response.json({ error: '密钥无效或已禁用' }, { status: 401 });
  if (match.used >= match.quota) return Response.json({ error: '配额已用完' }, { status: 403 });

  // 扣配额
  match.used++;
  await s.set('keys', JSON.stringify(keys));

  // 记录作业
  let recordId = null;
  if (body.imageUrl) {
    const rawJ = await s.get('jobs', { consistency: 'strong' });
    const jobs = rawJ ? JSON.parse(rawJ) : [];
    recordId = 'j' + Date.now();
    jobs.push({
      id: recordId, imageUrl: body.imageUrl, resultUrl: null,
      status: 'processing', keyId: match.id,
      createdAt: new Date().toISOString(), completedAt: null
    });
    await s.set('jobs', JSON.stringify(jobs));
  }

  return Response.json({ ok: true, keyId: match.id, recordId, label: match.label });
}

async function doCompleteJob(body) {
  if (!body.recordId) return Response.json({ ok: true });
  const s = await store();
  const raw = await s.get('jobs', { consistency: 'strong' });
  const jobs = raw ? JSON.parse(raw) : [];
  const idx = jobs.findIndex(j => j.id === body.recordId);
  if (idx !== -1) {
    jobs[idx].status = 'done';
    jobs[idx].resultUrl = body.resultUrl;
    jobs[idx].completedAt = new Date().toISOString();
    await s.set('jobs', JSON.stringify(jobs));
  }
  return Response.json({ ok: true });
}

// ═══ 管理接口 ═══

async function doListKeys() {
  const s = await store();
  const raw = await s.get('keys', { consistency: 'strong' });
  return Response.json({ ok: true, keys: raw ? JSON.parse(raw) : [] });
}
async function doAddKey(body) {
  if (!body.key) return Response.json({ error: '缺少 key' }, { status: 400 });
  const s = await store();
  const raw = await s.get('keys', { consistency: 'strong' });
  const keys = raw ? JSON.parse(raw) : [];
  const id = 'k' + Date.now();
  keys.push({ id, key: body.key, label: body.label || '', quota: body.quota || 100, used: 0, enabled: true, createdAt: new Date().toISOString() });
  await s.set('keys', JSON.stringify(keys));
  return Response.json({ ok: true, key: keys[keys.length - 1] });
}
async function doUpdateKey(body) {
  if (!body.id) return Response.json({ error: '缺少 id' }, { status: 400 });
  const s = await store();
  const raw = await s.get('keys', { consistency: 'strong' });
  const keys = raw ? JSON.parse(raw) : [];
  const idx = keys.findIndex(k => k.id === body.id);
  if (idx === -1) return Response.json({ error: '不存在' }, { status: 404 });
  if (body.key !== undefined) keys[idx].key = body.key;
  if (body.label !== undefined) keys[idx].label = body.label;
  if (body.quota !== undefined) keys[idx].quota = body.quota;
  if (body.enabled !== undefined) keys[idx].enabled = body.enabled;
  if (body.resetUsed) keys[idx].used = 0;
  await s.set('keys', JSON.stringify(keys));
  return Response.json({ ok: true, key: keys[idx] });
}
async function doDeleteKey(body) {
  if (!body.id) return Response.json({ error: '缺少 id' }, { status: 400 });
  const s = await store();
  const raw = await s.get('keys', { consistency: 'strong' });
  let keys = raw ? JSON.parse(raw) : [];
  keys = keys.filter(k => k.id !== body.id);
  await s.set('keys', JSON.stringify(keys));
  return Response.json({ ok: true });
}
async function doListJobs(url) {
  const s = await store();
  const raw = await s.get('jobs', { consistency: 'strong' });
  const jobs = raw ? JSON.parse(raw) : [];
  jobs.sort((a, b) => b.createdAt?.localeCompare(a.createdAt) || 0);
  const page = parseInt(url.searchParams.get('page') || '1');
  const size = 20;
  const list = jobs.slice((page - 1) * size, page * size);
  return Response.json({ ok: true, jobs: list, pagination: { page, size, total: jobs.length } });
}
async function doStats() {
  const s = await store();
  const [rk, rj] = await Promise.all([s.get('keys', { consistency: 'strong' }), s.get('jobs', { consistency: 'strong' })]);
  const keys = rk ? JSON.parse(rk) : [];
  const jobs = rj ? JSON.parse(rj) : [];
  return Response.json({
    ok: true,
    stats: {
      totalKeys: keys.length, enabledKeys: keys.filter(k => k.enabled).length,
      totalQuota: keys.reduce((s, k) => s + k.quota, 0),
      totalUsed: keys.reduce((s, k) => s + k.used, 0),
      totalJobs: jobs.length, doneJobs: jobs.filter(j => j.status === 'done').length,
      processingJobs: jobs.filter(j => j.status === 'processing').length,
      failedJobs: jobs.filter(j => j.status === 'failed').length,
    }
  });
}
async function doClearJobs() {
  await (await store()).set('jobs', '[]');
  return Response.json({ ok: true });
}
