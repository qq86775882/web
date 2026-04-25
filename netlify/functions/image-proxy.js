/**
 * Netlify Function: image-proxy
 * 代理下载 myimg.ai 的图片，解决 CORS 问题
 * 用法: /image-proxy?url=https://files.myimg.ai/xxx.jpeg
 */
export default async function handler(req) {
  const url = new URL(req.url).searchParams.get('url');
  if (!url) {
    return new Response('Missing url parameter', { status: 400 });
  }

  try {
    const imageRes = await fetch(url);
    if (!imageRes.ok) {
      return new Response('Image fetch failed', { status: 502 });
    }

    const buffer = await imageRes.arrayBuffer();
    const contentType = imageRes.headers.get('content-type') || 'image/jpeg';

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (e) {
    return new Response(`Proxy error: ${e.message}`, { status: 500 });
  }
}
