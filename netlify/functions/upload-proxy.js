/**
 * Netlify Function: upload-proxy
 * 代理上传到 myimg.ai 预签名 URL，解决浏览器 CORS preflight 问题
 * 用法: POST multipart/form-data { file, token, actionType }
 * 返回: { imageUrl }
 */
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const form = await req.formData();
    const file = form.get('file');
    const token = form.get('token');
    const actionType = form.get('actionType') || 'image_undress';

    if (!file || !token) {
      return Response.json({ error: 'Missing file or token' }, { status: 400 });
    }

    // 1. 获取预签名 URL
    const presignRes = await fetch(
      `https://api.myimg.ai/api/upload/presign?action_type=${actionType}&content_type=${encodeURIComponent(file.type)}`,
      {
        method: 'POST',
        headers: {
          'Authorization': token,
          'Accept': '*/*',
          'Content-Type': 'application/json',
        },
      }
    );
    const presignData = await presignRes.json();
    const uploadUrl = presignData.result?.presignUrl;
    const imageUrl = presignData.result?.url;
    if (!uploadUrl) {
      return Response.json({ error: 'Failed to get presigned URL' }, { status: 500 });
    }

    // 2. 上传文件到预签名 URL（服务端无 CORS 限制）
    const fileBuffer = await file.arrayBuffer();
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': file.type,
      },
      body: fileBuffer,
    });

    if (!uploadRes.ok) {
      return Response.json({
        error: `Upload failed: ${uploadRes.status}`,
      }, { status: 500 });
    }

    return Response.json({ imageUrl });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
