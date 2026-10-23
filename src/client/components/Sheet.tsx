import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface SheetProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function Sheet({ open, title, onClose, children, footer, wide }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const timer = window.setTimeout(() => panelRef.current?.focus(), 40);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(timer);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "ダイアログ"}
        ref={panelRef}
        tabIndex={-1}
        style={wide ? { maxWidth: 720 } : undefined}
      >
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="閉じる">
            <X size={19} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-footer">{footer}</div> : null}
      </div>
    </>,
    document.body,
  );
}
