import { CheckCircle2, Info, X, AlertTriangle } from "lucide-react";
import { useApp } from "../context/AppContext";

export function ToastViewport() {
  const { toasts, dismissToast } = useApp();
  if (!toasts.length) return null;
  return (
    <div className="toast-wrap" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          <span style={{ marginTop: 1, flex: "0 0 auto" }}>
            {toast.kind === "success" ? (
              <CheckCircle2 size={16} />
            ) : toast.kind === "error" ? (
              <AlertTriangle size={16} />
            ) : (
              <Info size={16} />
            )}
          </span>
          <span className="grow">{toast.message}</span>
          <button
            type="button"
            className="btn-icon"
            style={{ width: 22, height: 22, minHeight: 22, color: "inherit" }}
            onClick={() => dismissToast(toast.id)}
            aria-label="閉じる"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
