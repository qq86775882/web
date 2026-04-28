## ✅ 一步到位方案完成！(✧ω✧)

---

### 📂 最终 Function 结构

| 文件 | 作用 | 调用方式 |
|------|------|----------|
| `start-job.js` | 登录 → 下载 → 上传 → 分割调用 | **一次性发起** |
| `check-job.js` | 自动推进全流程 → 返回结果 | **轮询直到完成** |
| `image-proxy.js` | 图片代理（原有） | 前端使用 |
| `upload-proxy.js` | 上传代理（原有） | 前端使用 |

---

### 🚀 Agent 使用方式（2 条 curl）

#### 1️⃣ 发起任务
```bash
curl -X POST https://tupianchuli.netlify.app/.netlify/functions/start-job \
  -H "Content-Type: application/json" \
  -d '{"imageUrl":"你的图片URL","secret":"default-secret-CHANGE-ME"}'
```
返回：`{ "jobId": "eyJ0b2tlbiI6..." }`

#### 2️⃣ 轮询结果（每隔 10 秒调用一次）
```bash
curl -X POST https://tupianchuli.netlify.app/.netlify/functions/check-job \
  -H "Content-Type: application/json" \
  -d '{"jobId":"eyJ0b2tlbiI6...","secret":"default-secret-CHANGE-ME"}'
```
- 如果返回 `{ "status": "processing", "step": 1/2 }` → 等 10 秒再试
- 如果返回 `{ "success": true, "resultUrl": "https://..." }` → **完成！**

---

### 🔧 需要推送的文件

```bash
cd /root/.qwenpaw/workspaces/default/web-repo
git add .
git commit -m "feat: 一步到位API - start-job + check-job"
git push origin main
```

推送后 Netlify 自动部署，立即可用！(｡•̀ᴗ-)✧

---

### 💡 密钥安全建议

部署后去 Netlify 后台设置环境变量：
- `API_SECRET` = 你自己的密钥（替换 `default-secret-CHANGE-ME`）