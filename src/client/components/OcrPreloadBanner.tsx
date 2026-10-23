import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Download, Loader2, RotateCcw } from "lucide-react";
import { formatBytes, useOcrPreload } from "../context/OcrPreloadContext";

export function OcrPreloadBanner() {
  const { state, startPreload } = useOcrPreload();
  const [showReady, setShowReady] = useState(false);
  // Only a real model download is worth announcing. When the models are
  // already cached, checking and start-up finish silently.
  const downloadedRef = useRef(false);
  if (state.phase === "downloading") downloadedRef.current = true;

  useEffect(() => {
    if (state.phase === "ready" && downloadedRef.current) {
      downloadedRef.current = false;
      setShowReady(true);
      const timer = setTimeout(() => setShowReady(false), 3000);
      return () => clearTimeout(timer);
    }
    setShowReady(false);
  }, [state.phase]);

  if (state.phase === "idle") return null;
  if ((state.phase === "checking" || state.phase === "initializing") && !downloadedRef.current) {
    return null;
  }
  if (state.phase === "ready" && !showReady) return null;

  const percent =
    state.totalBytes > 0
      ? Math.min(100, Math.round((state.loadedBytes / state.totalBytes) * 100))
      : 0;

  return (
    <div className="ocr-preload-banner" role="status" aria-live="polite">
      {state.phase === "checking" ? (
        <div className="ocr-preload-content">
          <Loader2 size={15} className="spin" />
          <span className="ocr-preload-text">文字読み取りの準備を確認中…</span>
        </div>
      ) : null}

      {state.phase === "downloading" ? (
        <div className="ocr-preload-content downloading">
          <div className="ocr-preload-row">
            <span className="ocr-preload-label">
              <Download size={14} />
              文字読み取りの準備中（初回は約24 MB）
            </span>
            <span className="ocr-preload-bytes">
              {formatBytes(state.loadedBytes)} / {formatBytes(state.totalBytes)}
            </span>
          </div>
          <div className="ocr-preload-progress-track">
            <div
              className="ocr-preload-progress-bar"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      ) : null}

      {state.phase === "initializing" ? (
        <div className="ocr-preload-content">
          <Loader2 size={15} className="spin" />
          <span className="ocr-preload-text">文字読み取りを起動中…</span>
        </div>
      ) : null}

      {state.phase === "ready" && showReady ? (
        <div className="ocr-preload-content ready">
          <CheckCircle2 size={15} className="text-success" />
          <span className="ocr-preload-text">文字読み取りの準備が完了しました</span>
        </div>
      ) : null}

      {state.phase === "error" ? (
        <div className="ocr-preload-content error">
          <div className="ocr-preload-row">
            <span className="ocr-preload-label text-error">
              <AlertCircle size={15} />
              文字読み取りの準備に失敗しました
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={() => void startPreload(true)}
            >
              <RotateCcw size={12} /> 再試行
            </button>
          </div>
          {state.error ? <div className="ocr-preload-error-text">{state.error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
