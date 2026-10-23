import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Loader2 } from "lucide-react";
import type { WordCard } from "../../shared/types";
import { api, errorMessage } from "../lib/api";
import { getLocalBlob, translationImageKey } from "../lib/localdb";
import { loadImageFile, prepareImageForSave } from "../lib/image";
import { useApp } from "../context/AppContext";
import { Sheet } from "./Sheet";

export interface WordDraft {
  term: string;
  baseForm?: string;
  partOfSpeech?: string;
  meaning: string;
  contextMeaning?: string;
  sourceText: string;
  translatedText: string;
  grammarNote?: string;
  sourceLang: string;
  targetLang: string;
  translationId?: string | null;
  imageKey?: string | null;
}

interface AddWordResponse {
  word: WordCard;
  merged: boolean;
  addedExample: boolean;
  imageKey: string | null;
}

export function WordbookForm({
  open,
  draft,
  onClose,
  onSaved,
}: {
  open: boolean;
  draft: WordDraft | null;
  onClose: () => void;
  onSaved?: (word: WordCard) => void;
}) {
  const { settings, toast } = useApp();
  const [term, setTerm] = useState("");
  const [baseForm, setBaseForm] = useState("");
  const [partOfSpeech, setPartOfSpeech] = useState("");
  const [meaning, setMeaning] = useState("");
  const [contextMeaning, setContextMeaning] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [grammarNote, setGrammarNote] = useState("");
  const [saveImage, setSaveImage] = useState(false);
  const [localImage, setLocalImage] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const previewRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open || !draft) return;
    setTerm(draft.term);
    setBaseForm(draft.baseForm ?? "");
    setPartOfSpeech(draft.partOfSpeech ?? "");
    setMeaning(draft.meaning);
    setContextMeaning(draft.contextMeaning ?? "");
    setSourceText(draft.sourceText);
    setTranslatedText(draft.translatedText);
    setGrammarNote(draft.grammarNote ?? "");
    setError("");
    setLocalImage(null);
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreviewUrl(null);

    let cancelled = false;
    const load = async () => {
      if (!draft.translationId) {
        setSaveImage(Boolean(settings?.saveImages && draft.imageKey));
        return;
      }
      const blob = await getLocalBlob(translationImageKey(draft.translationId));
      if (cancelled) return;
      if (blob) {
        const url = URL.createObjectURL(blob);
        previewRef.current = url;
        setPreviewUrl(url);
        setLocalImage(blob);
        setSaveImage(Boolean(settings?.saveImages));
      } else {
        setSaveImage(Boolean(settings?.saveImages && draft.imageKey));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, draft, settings?.saveImages]);

  useEffect(() => {
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, []);

  const canSaveImage = Boolean(localImage || draft?.imageKey);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    if (!term.trim() || !meaning.trim()) {
      setError("単語と意味を入力してください。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      let imagePayload: {
        dataBase64: string;
        contentType: "image/webp" | "image/jpeg" | "image/png";
        sha256: string;
        width: number;
        height: number;
      } | null = null;
      if (saveImage && localImage) {
        const loaded = await loadImageFile(localImage);
        const prepared = await prepareImageForSave(loaded.canvas);
        imagePayload = {
          dataBase64: prepared.dataBase64,
          contentType: prepared.contentType,
          sha256: prepared.sha256,
          width: prepared.width,
          height: prepared.height,
        };
      }
      const response = await api<AddWordResponse>("/api/words", {
        method: "POST",
        timeoutMs: 60_000,
        body: {
          term: term.trim(),
          baseForm: baseForm.trim(),
          partOfSpeech: partOfSpeech.trim(),
          meaning: meaning.trim(),
          contextMeaning: contextMeaning.trim(),
          sourceText: sourceText.trim(),
          translatedText: translatedText.trim(),
          grammarNote: grammarNote.trim(),
          sourceLang: draft.sourceLang,
          targetLang: draft.targetLang,
          translationId: draft.translationId ?? null,
          existingImageKey: saveImage && !localImage && draft.imageKey ? draft.imageKey : null,
          image: saveImage ? imagePayload : null,
        },
      });
      toast(
        response.merged
          ? response.addedExample
            ? "既存の単語カードに用例を追加しました。"
            : "この用例は既に登録されています。"
          : "単語帳に追加しました。",
        "success",
      );
      onSaved?.(response.word);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open={open}
      title="単語帳に追加"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            キャンセル
          </button>
          <button
            type="submit"
            form="word-add-form"
            className="btn btn-primary"
            disabled={saving}
          >
            {saving ? <Loader2 size={16} className="spin" /> : null}
            {saving ? "保存中" : "保存する"}
          </button>
        </>
      }
    >
      <form id="word-add-form" className="stack" onSubmit={submit}>
        {error ? <div className="form-error">{error}</div> : null}
        <div className="field">
          <label className="label" htmlFor="wd-term">
            単語・熟語
          </label>
          <input
            id="wd-term"
            className="input"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            maxLength={200}
            required
          />
        </div>
        <div className="row" style={{ alignItems: "flex-start", gap: 8 }}>
          <div className="field grow">
            <label className="label" htmlFor="wd-base">
              基本形
            </label>
            <input
              id="wd-base"
              className="input"
              value={baseForm}
              onChange={(event) => setBaseForm(event.target.value)}
              maxLength={200}
              placeholder="例: run out of"
            />
          </div>
          <div className="field grow">
            <label className="label" htmlFor="wd-pos">
              品詞
            </label>
            <input
              id="wd-pos"
              className="input"
              value={partOfSpeech}
              onChange={(event) => setPartOfSpeech(event.target.value)}
              maxLength={80}
              placeholder="例: 句動詞"
            />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="wd-meaning">
            意味 <span style={{ color: "var(--danger)" }}>*</span>
          </label>
          <textarea
            id="wd-meaning"
            className="textarea"
            style={{ minHeight: 70 }}
            value={meaning}
            onChange={(event) => setMeaning(event.target.value)}
            maxLength={1000}
            required
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="wd-context">
            この文章での意味
          </label>
          <textarea
            id="wd-context"
            className="textarea"
            style={{ minHeight: 62 }}
            value={contextMeaning}
            onChange={(event) => setContextMeaning(event.target.value)}
            maxLength={1000}
          />
        </div>
        <details className="card-soft" style={{ padding: "10px 13px" }}>
          <summary
            style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 700, color: "var(--muted)" }}
          >
            用例・文法メモを編集
          </summary>
          <div className="stack-sm" style={{ marginTop: 10 }}>
            <div className="field">
              <label className="label" htmlFor="wd-source">
                元の文章
              </label>
              <textarea
                id="wd-source"
                className="textarea"
                style={{ minHeight: 80 }}
                value={sourceText}
                onChange={(event) => setSourceText(event.target.value)}
                maxLength={6000}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="wd-translation">
                文章全体の翻訳
              </label>
              <textarea
                id="wd-translation"
                className="textarea"
                style={{ minHeight: 80 }}
                value={translatedText}
                onChange={(event) => setTranslatedText(event.target.value)}
                maxLength={6000}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="wd-grammar">
                文法・語法メモ
              </label>
              <textarea
                id="wd-grammar"
                className="textarea"
                style={{ minHeight: 62 }}
                value={grammarNote}
                onChange={(event) => setGrammarNote(event.target.value)}
                maxLength={2000}
              />
            </div>
          </div>
        </details>

        {canSaveImage ? (
          <div className="card-soft" style={{ padding: "10px 13px" }}>
            <div className="switch-row" style={{ padding: 0 }}>
              <div className="setting-text">
                <div className="setting-title">
                  <ImageIcon size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                  画像も一緒に保存
                </div>
                <div className="setting-desc">
                  同じ画像は重複保存せず、単語カードで共有します。
                </div>
              </div>
              <button
                type="button"
                className="switch"
                role="switch"
                aria-checked={saveImage}
                aria-label="画像も一緒に保存"
                onClick={() => setSaveImage((value) => !value)}
              />
            </div>
            {saveImage && previewUrl ? (
              <img
                src={previewUrl}
                alt="保存する画像のプレビュー"
                style={{
                  width: "100%",
                  maxHeight: 160,
                  objectFit: "contain",
                  borderRadius: 10,
                  marginTop: 10,
                  background: "var(--surface-2)",
                }}
              />
            ) : null}
          </div>
        ) : null}
      </form>
    </Sheet>
  );
}
