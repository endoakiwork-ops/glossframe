import { Check } from "lucide-react";
import { LANGUAGES } from "../../shared/languages";
import { Sheet } from "./Sheet";

export function LanguagePicker({
  open,
  title,
  selected,
  exclude,
  onSelect,
  onClose,
}: {
  open: boolean;
  title: string;
  selected: string;
  exclude?: string;
  onSelect: (code: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} title={title} onClose={onClose}>
      <div className="stack-sm">
        {LANGUAGES.filter((lang) => lang.code !== exclude).map((lang) => {
          const active = lang.code === selected;
          return (
            <button
              key={lang.code}
              type="button"
              className="recent-item"
              onClick={() => {
                onSelect(lang.code);
                onClose();
              }}
              style={{
                borderColor: active ? "var(--teal-3)" : undefined,
                background: active ? "var(--teal-soft)" : undefined,
              }}
            >
              <span
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  display: "grid",
                  placeItems: "center",
                  background: active ? "var(--teal)" : "var(--surface-3)",
                  color: active ? "#fff" : "var(--muted)",
                  fontWeight: 800,
                  fontSize: 11,
                  flex: "0 0 auto",
                }}
              >
                {lang.code.slice(0, 2).toUpperCase()}
              </span>
              <span className="grow">
                <span style={{ display: "block", fontWeight: 700, fontSize: 14 }}>
                  {lang.label}
                </span>
                <span className="small muted">{lang.native}</span>
              </span>
              {active ? <Check size={18} color="var(--teal-3)" /> : null}
            </button>
          );
        })}
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>
        この一覧は Tesseract の OCR データが存在する言語だけに限定しています。
      </p>
    </Sheet>
  );
}
