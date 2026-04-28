/**
 * Netlify Function: admin
 * 后台管理 API
 *
 * 密钥管理: ?action=listKeys|addKey|updateKey|deleteKey
 * 作业管理: ?action=listJobs|stats
 *
 * 所有操作需要 adminSecret 验证
 */
import { getStore } from '@netlify/blobs';

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'qq86775582';

export default async function handler(req) {
  const store = getStore('imgproc');
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || '';

  let body = {};
  try { if (req.method === 'POST') body = await req.json(); } catch (e) {}

  const secret = body.adminSecret || url.searchParams.get('adminSecret') || '';

  // ── 公开接口（无需验证） ──
  if (action === 'stats' && secret === ADMIN_SECRET) {
    return stats(store);
  }

  // ── 需要验证的接口 ──
  if (secret !== ADMIN_SECRET) {
    return Response.json({ error: '无权限，请提供 adminSecret' }, { status: 401 });
  }

  try {
    switch (action) {
      case 'listKeys':   return listKeys(store);
      case 'addKey':     return addKey(store, body);
      case 'updateKey':  return updateKey(store, body);
      case 'deleteKey':  return deleteKey(store, body);
      case 'listJobs':   return listJobs(store, url);
      case 'stats':      return stats(store);
      case 'clearJobs':  return clearJobs(store);
      default:
        return Response.json({
          ok: true,
          message: 'Admin API',
          actions: ['listKeys','addKey','updateKey','deleteKey','listJobs','stats','clearJobs']
        });
    }
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ═══ 密钥管理 ═══

async function listKeys(store) {
  const raw = await store.get('keys', { consistency: 'strong' });
  const keys = raw ? JSON.parse(raw) : [];
  return Response.json({ ok: true, keys });
}

async function addKey(store, body) {
  const raw = await store.get('keys', { consistency: 'strong' });
  const keys = raw ? JSON.parse(raw) : [];

  if (!body.key) return Response.json({ error: '缺少 key' }, { status: 400 });

  const id = 'k' + Date.now();
  keys.push({
    id,
    key: body.key,
    label: body.label || '',
    quota: body.quota || 100,
    used: 0,
    enabled: body.enabled !== false,
    createdAt: new Date().toISOString()
  });

  await store.set('keys', JSON.stringify(keys));
  return Response.json({ ok: true, key: keys[keys.length - 1] });
}

async function updateKey(store, body) {
  if (!body.id) return Response.json({ error: '缺少 id' }, { status: 400 });

  const raw = await store.get('keys', { consistency: 'strong' });
  const keys = raw ? JSON.parse(raw) : [];

  const idx = keys.findIndex(k => k.id === body.id);
  if (idx === -1) return Response.json({ error: '密钥不存在' }, { status: 404 });

  if (body.key !== undefined) keys[idx].key = body.key;
  if (body.label !== undefined) keys[idx].label = body.label;
  if (body.quota !== undefined) keys[idx].quota = body.quota;
  if (body.enabled !== undefined) keys[idx].enabled = body.enabled;
  if (body.resetUsed) keys[idx].used = 0;

  await store.set('keys', JSON.stringify(keys));
  return Response.json({ ok: true, key: keys[idx] });
}

async function deleteKey(store, body) {
  if (!body.id) return Response.json({ error: '缺少 id' }, { status: 400 });

  const raw = await store.get('keys', { consistency: 'strong' });
  let keys = raw ? JSON.parse(raw) : [];

  keys = keys.filter(k => k.id !== body.id);
  await store.set('keys', JSON.stringify(keys));
  return Response.json({ ok: true, deleted: body.id });
}

// ═══ 作业管理 ═══

async function listJobs(store, url) {
  const page = parseInt(url.searchParams.get('page') || '1');
  const size = parseInt(url.searchParams.get('size') || '20');

  const raw = await store.get('jobs', { consistency: 'strong' });
  let jobs = raw ? JSON.parse(raw) : [];

  // 倒序（最新的在前）
  jobs.sort((a, b) => b.createdAt?.localeCompare(a.createdAt) || 0);

  const total = jobs.length;
  const start = (page - 1) * size;
  const list = jobs.slice(start, start + size);

  return Response.json({
    ok: true,
    jobs: list,
    pagination: { page, size, total, pages: Math.ceil(total / size) }
  });
}

async function stats(store) {
  const rawKeys = await store.get('keys', { consistency: 'strong' });
  const rawJobs = await store.get('jobs', { consistency: 'strong' });

  const keys = rawKeys ? JSON.parse(rawKeys) : [];
  const jobs = rawJobs ? JSON.parse(rawJobs) : [];

  const doneJobs = jobs.filter(j => j.status === 'done');

  return Response.json({
    ok: true,
    stats: {
      totalKeys: keys.length,
      enabledKeys: keys.filter(k => k.enabled).length,
      totalQuota: keys.reduce((s, k) => s + k.quota, 0),
      totalUsed: keys.reduce((s, k) => s + k.used, 0),
      totalJobs: jobs.length,
      doneJobs: doneJobs.length,
      processingJobs: jobs.filter(j => j.status === 'processing').length,
      failedJobs: jobs.filter(j => j.status === 'failed').length,
    }
  });
}

async function clearJobs(store) {
  await store.set('jobs', '[]');
  return Response.json({ ok: true, message: '已清空作业记录' });
}
