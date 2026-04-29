const API_KEY = "sk-4T2kODyhgiJiEOQwca0qExxzqCLJM7gswYPn9SmWq6DChmc1";
const API_BASE = "https://elysiver.h-e.top/v1";

exports.handler = async (event) => {
  const imgId = event.queryStringParameters?.id;
  const model = event.queryStringParameters?.model || "grok-imagine-image-lite";

  if (!imgId) {
    return { statusCode: 400, body: "Missing image id" };
  }

  try {
    const resp = await fetch(
      `${API_BASE}/files/image?id=${imgId}&model=${model}`,
      {
        headers: {
          "Authorization": `Bearer ${API_KEY}`
        }
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      return {
        statusCode: resp.status,
        body: `Image fetch failed: ${resp.status} - ${text.substring(0,200)}`
      };
    }

    const contentType = resp.headers.get("content-type") || "image/png";
    const buffer = await resp.arrayBuffer();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*"
      },
      body: Buffer.from(buffer).toString("base64"),
      isBase64Encoded: true
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: `Proxy error: ${e.message}`
    };
  }
};
