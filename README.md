# Web 图像处理项目

基于 Vite + React 的前端项目，已部署到 Netlify。

## 🌐 访问地址

- **生产环境**: https://tupianchuli.netlify.app

---

## 🔧 API 接口（服务端模式）

新增了 `process-image` API，可以直接通过 HTTP 调用图片处理功能。

### 环境变量配置（必需）

在 Netlify 后台设置以下环境变量：

```
PROCESS_IMAGE_SECRET=your_secure_secret_key_here
```

### API 端点

```
POST https://tupianchuli.netlify.app/.netlify/functions/process-image
```

### 请求头

```json
{
  "Authorization": "Bearer YOUR_SECRET_KEY",
  "Content-Type": "application/json"
}
```

### 请求体

```json
{
  "action_type": "image_segment | image_undress | upload_only",
  "image_url": "https://example.com/image.jpg",
  "mask_url": "https://example.com/mask.png",  // 可选，image_undress 时使用
  "options": {
    "breastSize": "large | medium | small",
    "bodyType": "chubby | slim | athletic"
  }
}
```

### 示例：图片分割

```bash
curl -X POST "https://tupianchuli.netlify.app/.netlify/functions/process-image" \
  -H "Authorization: Bearer YOUR_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action_type": "image_segment",
    "image_url": "https://example.com/photo.jpg"
  }'
```

**响应示例：**
```json
{
  "success": true,
  "result": {
    "status": "done",
    "response": "{\"mask_url\":\"https://...\",\"segmented_url\":\"https://...\"}",
    "action_id": "abc123..."
  }
}
```

### 示例：AI 生成（脱衣处理）

```bash
curl -X POST "https://tupianchuli.netlify.app/.netlify/functions/process-image" \
  -H "Authorization: Bearer YOUR_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action_type": "image_undress",
    "image_url": "https://example.com/photo.jpg",
    "options": {
      "breastSize": "large",
      "bodyType": "chubby"
    }
  }'
```

### 支持的 action_type

| 类型 | 说明 | 必需参数 |
|------|------|----------|
| `upload_only` | 仅上传测试，不处理 | 无 |
| `image_segment` | 图片分割 | `image_url` |
| `image_undress` | AI 生成（需先分割） | `image_url` |

---

## 🏗️ 项目结构

```
web/
├── src/                     # 前端源代码
│   ├── App.jsx             # 主组件
│   ├── main.jsx            # 入口
│   ├── api.js              # API 封装
│   └── maskProcessor.js    # Canvas 遮罩处理
├── netlify/
│   └── functions/          # Serverless Functions
│       ├── process-image.js  # ⭐ 新增：统一 API
│       ├── image-proxy.js    # 图片代理（CORS 解决）
│       └── upload-proxy.js   # 上传代理（CORS 解决）
├── dist/                   # 构建输出
├── package.json
└── netlify.toml
```

---

## 📦 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 预览构建结果
npm run preview
```

---

## 🚀 部署

修改代码后推送到 GitHub，Netlify 会自动重新构建：

```bash
git add .
git commit -m "feat: 添加新功能"
git push origin main
```

等待约 1-2 分钟，部署完成后即可访问新页面。

---

## ⚠️ 注意事项

1. **密钥安全**: `PROCESS_IMAGE_SECRET` 必须设置，且不要在代码中硬编码
2. **API 速率限制**: myimg.ai 可能有频率限制，请勿频繁调用
3. **超时时间**: 单次处理最多等待 2 分钟（60 轮询 × 2 秒间隔）
