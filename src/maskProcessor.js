/**
 * Canvas 掩码处理器
 * 替代 Python PIL 的像素操作：
 *   - 将指定颜色替换为白色
 *   - 其他区域设为透明
 *   - 导出为 PNG Blob
 */

/**
 * 将掩码图片中的指定颜色替换为白色，其余透明，返回 PNG Blob
 * @param {string} maskUrl - 掩码图片原始 URL（files.myimg.ai）
 * @param {number[][]} targetColors - 目标颜色列表
 * @returns {Promise<Blob>} PNG 格式的 Blob
 */
export async function processMaskImage(maskUrl, targetColors) {
  // 1. 通过 Netlify 函数代理加载图片（解决 CORS）
  const proxyUrl = `/.netlify/functions/image-proxy?url=${encodeURIComponent(maskUrl)}`;
  const img = await loadImage(proxyUrl);

  // 2. 绘制到 canvas
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  // 3. 获取像素数据
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;

  // 4. 构建颜色查找 Set（加速）
  const colorSet = new Set(targetColors.map(c => c.join(',')));

  // 5. 逐像素处理
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const key = `${r},${g},${b}`;

    if (colorSet.has(key)) {
      // 目标颜色 → 白色不透明
      pixels[i] = 255;
      pixels[i + 1] = 255;
      pixels[i + 2] = 255;
      pixels[i + 3] = 255;
    } else {
      // 其他 → 完全透明
      pixels[i + 3] = 0;
    }
  }

  // 6. 写回 canvas
  ctx.putImageData(imageData, 0, 0);

  // 7. 导出为 PNG Blob
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败: ' + url));
    img.src = url;
  });
}
