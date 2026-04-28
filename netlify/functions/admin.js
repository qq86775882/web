/**
 * Netlify Function: admin
 *
 * 管理接口: 密钥管理 + 作业记录 + 统计
 * 所有接口需要 Bearer token 验证
 */
import crypto from 'crypto';

const ADMIN_USER = 'admin';
const ADMIN_PASS = '123456';
const TOKEN_SECRET = 'admin-secret-key-v2';

// 懒加载 Blobs
let _store = null;
async function store() {
  if (_store) return _store;
  const { getStore } = await import('@netlify/blobs');
  _store = getStore('imgproc');
  return _store;
}

// Token
function signToken(u) {
  const payload = `${u}:${Date.now() + 86400000}`;
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  const raw = `${payload}:${sig}`;
  // base64 → base64url
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function verifyToken(t) {
  try {
    // base64url → base64
    const b64 = t.replace(/-/g, '+').replace(/_/g, '/');
    const raw = Buffer.from(b64, 'base64').toString();
    const parts = raw.split(':');
    const sig = parts.pop();
    const payload = parts.join(':');
    if (sig !== crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex')) return null;
    const [u, exp] = payload.split(':');
    if (Date.now() > parseInt(exp)) return null;
    return u;
  } catch (e) { console.error('verifyToken error:', e); return null; }
}

export default async function handler(req) {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || '';
  let body = {};
  try { if (req.method === 'POST') body = await req.json(); } catch {}

  // ── 登录接口 ──
  if (action === 'login') {
    if (body.username !== ADMIN_USER || body.password !== ADMIN_PASS) return Response.json({ error: '账号或密码错误' }, { status: 401 });
    return Response.json({ ok: true, token: signToken(ADMIN_USER), username: ADMIN_USER });
  }

  // ── 需要验证的接口 ──
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!verifyToken(token)) return Response.json({ error: '请先登录' }, { status: 401 });

  try {
    const s = await store();
    switch (action) {
      case 'listKeys': return listKeys(s);
      case 'addKey': return addKey(s, body);
      case 'updateKey': return updateKey(s, body);
      case 'deleteKey': return deleteKey(s, body);
      case 'listJobs': return listJobs(s, url);
      case 'stats': return stats(s);
      case 'clearJobs': return clearJobs(s);
      default: return Response.json({ ok: true, message: 'Admin API', actions: ['login','listKeys','addKey','updateKey','deleteKey','listJobs','stats','clearJobs'] });
    }
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

async function listKeys(s) {
  const raw = await s.get('keys', { consistency: 'strong' });
  return Response.json({ ok: true, keys: raw ? JSON.parse(raw) : [] });
}
async function addKey(s, body) {
  if (!body.key) return Response.json({ error: '缺少 key' }, { status: 400 });
  const raw = await s.get('keys', { consistency: 'strong' });
  const keys = raw ? JSON.parse(raw) : [];
  const id = 'k' + Date.now();
  keys.push({ id, key: body.key, label: body.label || '', quota: body.quota || 100, used: 0, enabled: true, createdAt: new Date().toISOString() });
  await s.set('keys', JSON.stringify(keys));
  return Response.json({ ok: true, key: keys[keys.length - 1] });
}
async function updateKey(s, body) {
  if (!body.id) return Response.json({ error: '缺少 id' }, { status: 400 });
  const raw = await s.get('keys', { consistency: 'strong' });
  const keys = raw ? JSON.parse(raw) : [];
  const idx = keys.findIndex(k => k.id === body.id);
  if (idx === -1) return Response.json({ error: '不存在' }, { status: 404 });
  if (body.key) keys[idx].key = body.key;
  if (body.label !== undefined) keys[idx].label = body.label;
  if (body.quota !== undefined) keys[idx].quota = body.quota;
  if (body.enabled !== undefined) keys[idx].enabled = body.enabled;
  if (body.resetUsed) keys[idx].used = 0;
  await s.set('keys', JSON.stringify(keys));
  return Response.json({ ok: true, key: keys[idx] });
}
async function deleteKey(s, body) {
  if (!body.id) return Response.json({ error: '缺少 id' }, { status: 400 });
  const raw = await s.get('keys', { consistency: 'strong' });
  let keys = raw ? JSON.parse(raw) : [];
  keys = keys.filter(k => k.id !== body.id);
  await s.set('keys', JSON.stringify(keys));
  return Response.json({ ok: true });
}
async function listJobs(s, url) {
  const page = parseInt(url.searchParams.get('page') || '1');
  const raw = await s.get('jobs', { consistency: 'strong' });
  let jobs = raw ? JSON.parse(raw) : [];
  jobs.sort((a, b) => b.createdAt?.localeCompare(a.createdAt) || 0);
  const list = jobs.slice((page - 1) * 20, page * 20);
  return Response.json({ ok: true, jobs: list, pagination: { page, size: 20, total: jobs.length } });
}
async function stats(s) {
  const [rk, rj] = await Promise.all([s.get('keys', { consistency: 'strong' }), s.get('jobs', { consistency: 'strong' })]);
  const keys = rk ? JSON.parse(rk) : [];
  const jobs = rj ? JSON.parse(rj) : [];
  return Response.json({ ok: true, stats: {
    totalKeys: keys.length, enabledKeys: keys.filter(k => k.enabled).length,
    totalQuota: keys.reduce((s, k) => s + k.quota, 0),
    totalUsed: keys.reduce((s, k) => s + k.used, 0),
    totalJobs: jobs.length, doneJobs: jobs.filter(j => j.status === 'done').length,
    processingJobs: jobs.filter(j => j.status === 'processing').length
  }});
}
async function clearJobs(s) {
  await s.set('jobs', '[]');
  return Response.json({ ok: true });
}