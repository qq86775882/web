/**
 * Netlify Function: process-image
 * 图片处理统一 API 接口（服务端模式）
 * 
 * 功能：
 *   - 自动获取 myimg.ai token（使用 guest 登录）
 *   - 上传图片到预签名 URL
 *   - 调用图像处理 API
 *   - 轮询返回结果
 * 
 * 用法:
 *   POST /.netlify/functions/process-image
 *   Headers: { Authorization: "Bearer YOUR_SECRET_KEY" }
 *   Body: JSON { image_url, action_type, ...options }
 * 
 * 支持的 action_type:
 *   - image_segment: 图片分割
 *   - image_undress: AI 生成
 *   - upload_only: 仅上传不处理
 */

// ⚠️ 请将此密钥设置到 Netlify Environment Variable: PROCESS_IMAGE_SECRET
const SECRET_KEY = process.env.PROCESS_IMAGE_SECRET || 'default_secret_key_for_testing';

export default async function handler(req) {
  // --- CORS 配置 ---
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  // 处理预检请求
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  // 只允许 POST
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
  }

  try {
    // --- 1. 验证密钥 ---
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ') || authHeader.replace('Bearer ', '') !== SECRET_KEY) {
      return Response.json(
        { error: 'Unauthorized - Invalid or missing API key' },
        { status: 401, headers }
      );
    }

    // --- 2. 解析请求体 ---
    const body = await req.json();
    const { image_url, mask_url, action_type = 'upload_only', options = {} } = body;

    if (!image_url && action_type !== 'upload_only') {
      return Response.json({ error: 'Missing image_url' }, { status: 400, headers });
    }

    console.log(`Processing request: ${action_type} for ${image_url?.substring(0, 50)}...`);

    // --- 3. 登录获取 token ---
    let token;
    try {
      const loginRes = await fetch('https://api.myimg.ai/api/account/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'guest',
          device: {
            userAgent: 'NetlifyFunction/1.0',
            lang: 'zh-CN',
            platform: 'Linux',
            screenWidth: 1920,
            screenHeight: 1080,
            screenColorDepth: 32,
            screenPixelDepth: 32,
            audioFingerprint: 0,
          },
          website: 'myimg',
        }),
      });

      const loginData = await loginRes.json();
      if (!loginData.result?.token) {
        throw new Error('Login failed: ' + JSON.stringify(loginData));
      }
      token = loginData.result.token;
      console.log('✅ Login successful, token received');
    } catch (e) {
      return Response.json({ error: `Login failed: ${e.message}` }, { status: 500, headers });
    }

    // --- 4. 根据动作类型处理 ---
    let result;

    if (action_type === 'upload_only') {
      // 仅上传测试模式
      result = { message: 'Upload only mode - no action taken' };
    } else if (action_type === 'image_segment') {
      // 图片分割
      result = await handleSegment(token, image_url);
    } else if (action_type === 'image_undress') {
      // AI 生成（脱衣处理）
      result = await handleUndress(token, image_url, mask_url, options);
    } else {
      return Response.json({ error: `Unknown action_type: ${action_type}` }, { status: 400, headers });
    }

    return Response.json({ success: true, result }, { status: 200, headers });

  } catch (e) {
    console.error('Error:', e);
    return Response.json({ error: e.message }, { status: 500, headers });
  }
}

// ==================== 辅助函数 ====================

async function handleSegment(token, imageUrl) {
  // 发起分割请求
  const res = await fetch('https://api.myimg.ai/api/image/segment', {
    method: 'POST',
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ imageUrl, website: 'myimg' }),
  });

  const data = await res.json();
  if (!data.actionId) {
    throw new Error('Segment failed: ' + JSON.stringify(data));
  }

  const actionId = data.actionId;
  console.log('📋 Segment action_id:', actionId);

  // 轮询等待完成
  return await pollAction(token, actionId);
}

async function handleUndress(token, imageUrl, maskUrl, options = {}) {
  // 先进行图片分割（获取 mask）
  let segmentResult;
  if (!maskUrl) {
    console.log('🔍 Starting segmentation to get mask...');
    segmentResult = await handleSegment(token, imageUrl);
    maskUrl = segmentResult.mask_url || segmentResult.result?.mask_url;
  }

  // 发起 undress 请求
  const res = await fetch('https://api.myimg.ai/api/image/undress', {
    method: 'POST',
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      imageUrl,
      maskUrl: maskUrl || '',
      breastSize: options.breastSize || 'large',
      bodyType: options.bodyType || 'chubby',
      advance: true,
      website: 'myimg',
    }),
  });

  const data = await res.json();
  if (!data.actionId) {
    throw new Error('Undress failed: ' + JSON.stringify(data));
  }

  const actionId = data.actionId;
  console.log('✨ Undress action_id:', actionId);

  // 轮询等待完成
  return await pollAction(token, actionId);
}

async function pollAction(token, actionId, maxPolls = 60) {
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 2000)); // 每 2 秒查询一次

    const res = await fetch(
      `https://api.myimg.ai/api/action/info?action_id=${actionId}&website=myimg`,
      { headers: { 'Authorization': token } }
    );

    const data = await res.json();
    const status = data.result?.status;

    console.log(`📊 Poll ${i + 1}: status = ${status}`);

    if (status === 'done' || data.result?.response) {
      console.log('✅ Action completed!');
      return {
        status: 'done',
        response: data.result?.response,
        action_id: actionId,
      };
    }

    if (status === 'failed' || status === 'error') {
      throw new Error(`Action failed: ${JSON.stringify(data)}`);
    }
  }

  throw new Error('Timeout: action did not complete within polling limit');
}
