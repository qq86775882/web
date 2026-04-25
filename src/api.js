/**
 * myimg.ai API 封装
 * 所有请求通过 Vite 代理转发（/api → https://api.myimg.ai/api）
 */

const BASE = '/api';

// --- 通用请求头 ---
function headers(token) {
  const h = { 'Accept': '*/*', 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = token;
  return h;
}

// --- 登录 ---
export async function accountLogin() {
  const res = await fetch(`${BASE}/account/login`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      platform: 'guest',
      device: {
        userAgent: navigator.userAgent,
        lang: 'zh-CN',
        platform: 'Win32',
        screenWidth: screen.width,
        screenHeight: screen.height,
        screenColorDepth: 32,
        screenPixelDepth: 32,
        audioFingerprint: 124.04347527516074,
      },
      website: 'myimg',
    }),
  });
  const data = await res.json();
  if (data.result?.token) return data.result.token;
  throw new Error('登录失败');
}

// --- 上传文件（通过 Netlify Function 代理，解决预签名URL的 CORS 问题）---
export async function uploadFile(token, file, actionType = 'image_undress') {
  const form = new FormData();
  form.append('file', file);
  form.append('token', token);
  form.append('actionType', actionType);

  const res = await fetch('/.netlify/functions/upload-proxy', {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (data.imageUrl) return data.imageUrl;
  throw new Error(data.error || '上传失败');
}

// --- 图片分割 ---
export async function imageSegment(token, imageUrl) {
  const res = await fetch(`${BASE}/image/segment`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ imageUrl, website: 'myimg' }),
  });
  const data = await res.json();
  if (data.actionId) return data.actionId;
  throw new Error('分割失败');
}

// --- 查询 action 状态 ---
export async function actionInfo(token, actionId) {
  const res = await fetch(
    `${BASE}/action/info?action_id=${actionId}&website=myimg`,
    { headers: headers(token) }
  );
  return res.json();
}

// --- AI 生成 ---
export async function imageUndress(token, imageUrl, maskUrl) {
  const res = await fetch(`${BASE}/image/undress`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      imageUrl,
      maskUrl,
      breastSize: 'large',
      bodyType: 'chubby',
      advance: true,
      website: 'myimg',
    }),
  });
  const data = await res.json();
  if (data.actionId) return data.actionId;
  throw new Error('生成失败');
}

// --- 轮询直到 action 完成 ---
export async function pollUntilDone(token, actionId, onProgress) {
  while (true) {
    const info = await actionInfo(token, actionId);
    const response = info.result?.response;
    if (response) return JSON.parse(response);
    if (onProgress) onProgress(info);
    await new Promise(r => setTimeout(r, 1500));
  }
}
