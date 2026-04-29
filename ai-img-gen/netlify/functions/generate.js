const API_KEY = "sk-4T2kODyhgiJiEOQwca0qExxzqCLJM7gswYPn9SmWq6DChmc1";
const API_BASE = "https://elysiver.h-e.top/v1";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const { prompt, model } = JSON.parse(event.body);
  if (!prompt) {
    return { statusCode: 400, body: JSON.stringify({ error: "请输入提示词" }) };
  }

  const imgModel = model || "grok-imagine-image-lite";

  try {
    const resp = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: imgModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 800
      })
    });

    const text = await resp.text();

    // Check if Cloudflare blocked
    if (text.includes("403") && text.includes("Forbidden")) {
      return {
        statusCode: 200,
        body: JSON.stringify({ error: "图片生成接口被限制(Cloudflare)，请尝试其他模型" })
      };
    }

    const data = JSON.parse(text);

    if (data.error) {
      return {
        statusCode: 200,
        body: JSON.stringify({ error: data.error.message || "API 错误" })
      };
    }

    const content = data.choices?.[0]?.message?.content || "";
    
    // Try to extract image ID from markdown ![image](url)
    const imgMatch = content.match(/!\[.*?\]\(.*?[?&]id=([a-f0-9-]+)/);
    if (imgMatch) {
      const imgId = imgMatch[1];
      // Use our own proxy to fetch the image
      const proxyUrl = `/.netlify/functions/img-proxy?id=${imgId}&model=${imgModel}`;
      return {
        statusCode: 200,
        body: JSON.stringify({ 
          imageUrl: proxyUrl,
          model: data.model,
          usage: data.usage
        })
      };
    }

    // Also try full URL match
    const fullMatch = content.match(/!\[.*?\]\((.*?)\)/);
    if (fullMatch) {
      return {
        statusCode: 200,
        body: JSON.stringify({ 
          imageUrl: "/.netlify/functions/img-proxy?raw=" + encodeURIComponent(fullMatch[1]),
          model: data.model,
          usage: data.usage
        })
      };
    }

    // Maybe it's direct image URL
    if (content.startsWith("http")) {
      return {
        statusCode: 200,
        body: JSON.stringify({ imageUrl: content })
      };
    }

    // Return raw content
    return {
      statusCode: 200,
      body: JSON.stringify({ markdown: content, model: data.model })
    };

  } catch (e) {
    return {
      statusCode: 200,
      body: JSON.stringify({ error: `请求失败: ${e.message}` })
    };
  }
};
