import { useState, useCallback } from 'react';
import {
  accountLogin,
  uploadFile,
  imageSegment,
  pollUntilDone,
  imageUndress,
} from './api';
import { processMaskImage } from './maskProcessor';
import './App.css';

const STEPS = {
  IDLE: 'idle',
  LOGGING: '登录中…',
  UPLOADING: '上传图片…',
  SegmentING: 'AI 分割中…',
  PROCESSING_MASK: '处理掩码…',
  MASK_UPLOADING: '上传掩码…',
  Generating: 'AI 生成中…',
  DONE: 'done',
  ERROR: 'error',
};

export default function App() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [step, setStep] = useState(STEPS.IDLE);
  const [resultUrl, setResultUrl] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [progress, setProgress] = useState('');
  const [mode, setMode] = useState('file');  // 'file' | 'url'

  const handleFile = useCallback((f) => {
    if (!f.type.startsWith('image/')) {
      setErrorMsg('请选择图片文件');
      return;
    }
    setFile(f);
    setResultUrl(null);
    setErrorMsg('');
    const reader = new FileReader();
    reader.onload = (e) => setPreview(e.target.result);
    reader.readAsDataURL(f);
  }, []);

  const handleUrl = useCallback(async (url) => {
    setErrorMsg('');
    setResultUrl(null);
    try {
      setStep('加载URL图片…');
      // 通过 image-proxy 下载（避免 CORS）
      const proxyUrl = `/.netlify/functions/image-proxy?url=${encodeURIComponent(url)}`;
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error('URL 图片下载失败');

      const blob = await res.blob();
      const contentType = res.headers.get('Content-Type') || 'image/jpeg';

      // 提取文件名
      const urlObj = new URL(url);
      let name = urlObj.pathname.split('/').pop() || 'image.jpg';

      const f = new File([blob], name, { type: contentType });
      setFile(f);
      setPreview(url);  // 直接使用原 URL 做预览
      setStep(STEPS.IDLE);
    } catch (e) {
      setErrorMsg('图片链接无效或无法访问');
      setStep(STEPS.IDLE);
    }
  }, []);

  const doProcess = useCallback(async () => {
    if (!file) return;
    setErrorMsg('');
    setResultUrl(null);

    try {
      setStep(STEPS.LOGGING);
      const token = await accountLogin();

      setStep(STEPS.UPLOADING);
      const imageUrl = await uploadFile(token, file);

      setStep(STEPS.SegmentING);
      const segmentId = await imageSegment(token, imageUrl);
      setProgress('等待分割结果…');
      const segmentResult = await pollUntilDone(token, segmentId, (info) => {
        if (info.result?.status) setProgress(`分割状态: ${info.result.status}`);
      });

      setStep(STEPS.PROCESSING_MASK);
      const maskUrl = segmentResult.resultUrl;
      const colors = segmentResult.autoSelect || [];
      if (!colors.length) throw new Error('AI 未识别到可处理区域');
      const maskBlob = await processMaskImage(maskUrl, colors);

      setStep(STEPS.MASK_UPLOADING);
      const processedMaskUrl = await uploadFile(
        token,
        new File([maskBlob], 'mask.png', { type: 'image/png' }),
        'image_undress'
      );

      setStep(STEPS.Generating);
      const undressId = await imageUndress(token, imageUrl, processedMaskUrl);
      setProgress('等待生成结果…');
      const undressResult = await pollUntilDone(token, undressId, (info) => {
        if (info.result?.status) setProgress(`生成状态: ${info.result.status}`);
      });

      if (undressResult.resultUrl) {
        setResultUrl(undressResult.resultUrl);
        setStep(STEPS.DONE);
      } else {
        throw new Error('未返回结果URL');
      }
    } catch (e) {
      setErrorMsg(e.message || '未知错误');
      setStep(STEPS.ERROR);
    }
  }, [file]);

  const loading = ![STEPS.IDLE, STEPS.DONE, STEPS.ERROR].includes(step);

  return (
    <div className="app">
      <div className="card">
        <h1>🎨 图片处理工具</h1>
        <p className="subtitle">纯前端运行 · 支持文件上传和链接</p>

        {/* 模式切换 */}
        <div className="mode-tabs">
          <button
            className={`mode-tab ${mode === 'file' ? 'active' : ''}`}
            onClick={() => { setMode('file'); setFile(null); setPreview(null); }}
            disabled={loading}
          >📁 本地上传</button>
          <button
            className={`mode-tab ${mode === 'url' ? 'active' : ''}`}
            onClick={() => { setMode('url'); setFile(null); setPreview(null); }}
            disabled={loading}
          >🔗 图片链接</button>
        </div>

        {/* 文件模式 */}
        {mode === 'file' && (
          <UploadArea onFile={handleFile} disabled={loading} />
        )}

        {/* URL 模式 */}
        {mode === 'url' && (
          <UrlInput onUrl={handleUrl} disabled={loading} />
        )}

        {/* 预览 */}
        {preview && <ImagePreview src={preview} label="预览图片" />}

        {/* 按钮 */}
        <button
          className="btn-primary"
          disabled={!file || loading}
          onClick={doProcess}
        >
          {loading ? '处理中…' : '开始处理'}
        </button>

        {/* 进度 */}
        {loading && (
          <div className="loading-box">
            <div className="spinner" />
            <p>{step}</p>
            {progress && <p className="progress-text">{progress}</p>}
          </div>
        )}

        {/* 错误 */}
        {step === STEPS.ERROR && errorMsg && (
          <div className="error-box">{errorMsg}</div>
        )}

        {/* 结果 */}
        {step === STEPS.DONE && resultUrl && (
          <div className="result-box">
            <p className="result-label">✅ 处理完成</p>
            <img
              src={`/.netlify/functions/image-proxy?url=${encodeURIComponent(resultUrl)}`}
              alt="结果"
            />
            <a
              className="btn-secondary"
              href={resultUrl}
              target="_blank"
              rel="noopener noreferrer"
              download
            >
              📥 下载结果
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

// --- 子组件 ---

function UploadArea({ onFile, disabled }) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <label
      className={`upload-area ${dragOver ? 'dragover' : ''} ${disabled ? 'disabled' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
    >
      <span className="upload-icon">📤</span>
      <span className="upload-text">点击或拖拽上传图片</span>
      <span className="upload-hint">支持 JPG、PNG 格式</span>
      <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files[0]; if (f) onFile(f); }} disabled={disabled} />
    </label>
  );
}

function UrlInput({ onUrl, disabled }) {
  const [value, setValue] = useState('');

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) onUrl(trimmed);
  };

  return (
    <div className="url-input-area">
      <input
        className="url-field"
        type="text"
        placeholder="粘贴图片链接，如 https://example.com/photo.jpg"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        disabled={disabled}
      />
      <button className="url-btn" onClick={submit} disabled={disabled || !value.trim()}>
        加载
      </button>
    </div>
  );
}

function ImagePreview({ src, label }) {
  return (
    <div className="preview-box">
      <p className="preview-label">{label}</p>
      <img src={src} alt={label} referrerPolicy="no-referrer" />
    </div>
  );
}
