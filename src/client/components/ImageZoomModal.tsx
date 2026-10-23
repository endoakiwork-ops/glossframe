import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useApp } from "../context/AppContext";
import { QuotaBattery, useAiQuota } from "./AiUsageSheet";

export function ImageZoomModal({
  src,
  alt,
  onClose,
}: {
  src: string | null;
  alt?: string;
  onClose: () => void;
}) {
  const { setUsageOpen } = useApp();
  const quota = useAiQuota();

  useEffect(() => {
    if (!src) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src, onClose]);

  if (!src) return null;

  return createPortal(
    <div
      className="zoom-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={alt || "画像を拡大表示"}
      onClick={onClose}
    >
      <div className="zoom-topbar" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="wb-quota zoom-quota-btn"
          onClick={() => setUsageOpen(true)}
          aria-label="AI利用状況を開く"
        >
          AI枠
          <QuotaBattery ratio={quota.ratio} status={quota.status} known={quota.used !== null} />
        </button>
        <button
          type="button"
          className="btn-icon zoom-close-btn"
          onClick={onClose}
          aria-label="拡大画像を閉じる"
        >
          <X size={20} />
        </button>
      </div>
      <img
        className="zoom-image"
        src={src}
        alt={alt || "拡大画像"}
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
