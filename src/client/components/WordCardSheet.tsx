import { useEffect, useState } from "react";
import { Check, Loader2, Pencil, RotateCcw, Sparkles, Trash2, Volume2 } from "lucide-react";
import type { AlternativeExampleItem, WordCard } from "../../shared/types";
import { formatNextReview, highlightSegments } from "../../shared/srs";
import { api, errorMessage } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useApp } from "../context/AppContext";
import { ImageZoomModal } from "./ImageZoomModal";
import { Sheet } from "./Sheet";

function HighlightedSentence({ text, term }: { text: string; term: string }) {
  const segments = highlightSegments(text, term);
  return (
    <>
      {segments.map((seg, idx) =>
        seg.highlight ? (
          <mark key={idx} className="wb-term-highlight">
            {seg.text}
          </mark>
        ) : (
          <span key={idx}>{seg.text}</span>
        ),
      )}
    </>
  );
}

export function WordCardSheet({
  wordId,
  onClose,
  onChanged,
}: {
  wordId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { toast, learnerLevel, speak, refreshStats } = useApp();
  const [word, setWord] = useState<WordCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [term, setTerm] = useState("");
  const [baseForm, setBaseForm] = useState("");
  const [partOfSpeech, setPartOfSpeech] = useState("");
  const [meaning, setMeaning] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [altExamples, setAltExamples] = useState<AlternativeExampleItem[]>([]);
  const [altLoading, setAltLoading] = useState(false);
  const [altError, setAltError] = useState("");
  const [zoomImageUrl, setZoomImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!wordId) return;
    let cancelled = false;
    setLoading(true);
    setEditing(false);
    setError("");
    setAltExamples([]);
    setAltError("");
    api<{ word: WordCard }>(`/api/words/${wordId}`)
      .then((data) => {
        if (cancelled) return;
        const w = data.word;
        setWord(w);
        setTerm(w.term);
        setBaseForm(w.baseForm ?? "");
        setPartOfSpeech(w.partOfSpeech ?? "");
        setMeaning(w.meaning);
        const firstEx = (w.examples ?? [])[0];
        setSourceText(firstEx?.sourceText ?? "");
        setTranslatedText(firstEx?.translatedText ?? "");
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [wordId]);

  async function save() {
    if (!word) return;
    if (!term.trim() || !meaning.trim()) {
      setError("単語と意味を入力してください。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const data = await api<{ word: WordCard }>(`/api/words/${word.id}`, {
        method: "PATCH",
        body: {
          term: term.trim(),
          baseForm: baseForm.trim(),
          partOfSpeech: partOfSpeech.trim(),
          meaning: meaning.trim(),
          sourceText: sourceText.trim(),
          translatedText: translatedText.trim(),
        },
      });
      setWord(data.word);
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!word) return;
    if (!window.confirm(`「${word.term}」を単語帳から削除しますか？\n用例と復習履歴も削除されます。`)) {
      return;
    }
    setSaving(true);
    try {
      await api(`/api/words/${word.id}`, { method: "DELETE" });
      onChanged();
      onClose();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setSaving(false);
    }
  }

  async function resetProgress() {
    if (!word) return;
    if (!window.confirm(`「${word.term}」の定着度をリセットしますか？\n理解・想起とも0回に戻り、復習対象になります。`)) {
      return;
    }
    setSaving(true);
    try {
      const data = await api<{ word: WordCard }>(`/api/words/${word.id}/reset-progress`, { method: "POST" });
      setWord(data.word);
      onChanged();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setSaving(false);
    }
  }

  async function loadAlternativeExamples() {
    if (!word || altLoading) return;
    setAltLoading(true);
    setAltError("");
    try {
      const res = await api<{ examples: AlternativeExampleItem[] }>(
        `/api/words/${word.id}/examples`,
        {
          method: "POST",
          body: { learnerLevel },
          timeoutMs: 60_000,
        },
      );
      setAltExamples(res.examples);
      void refreshStats();
    } catch (err) {
      setAltError(errorMessage(err));
    } finally {
      setAltLoading(false);
    }
  }

  const knownCount = word?.knownCount ?? word?.reviewCount ?? 0;
  const recallCount = word?.recallCount ?? 0;

  return (
    <>
      <Sheet open={Boolean(wordId)} title="単語の詳細" onClose={onClose}>
        {loading ? (
          <div className="center" style={{ padding: 28 }}>
            <Loader2 className="spin" style={{ color: "var(--teal)" }} />
          </div>
        ) : error && !word ? (
          <div className="form-error">{error}</div>
        ) : word ? (
          <div className="stack">
            {error ? <div className="form-error">{error}</div> : null}
            {editing ? (
              <div className="stack-sm">
                <div className="field">
                  <label className="label" htmlFor="edit-term">
                    単語・熟語（必須）
                  </label>
                  <input
                    id="edit-term"
                    className="input"
                    value={term}
                    onChange={(event) => setTerm(event.target.value)}
                    maxLength={200}
                  />
                </div>
                <div className="row" style={{ alignItems: "flex-start", gap: 8 }}>
                  <div className="field grow">
                    <label className="label" htmlFor="edit-base">
                      基本形
                    </label>
                    <input
                      id="edit-base"
                      className="input"
                      value={baseForm}
                      onChange={(event) => setBaseForm(event.target.value)}
                      maxLength={200}
                    />
                  </div>
                  <div className="field grow">
                    <label className="label" htmlFor="edit-pos">
                      品詞
                    </label>
                    <input
                      id="edit-pos"
                      className="input"
                      value={partOfSpeech}
                      onChange={(event) => setPartOfSpeech(event.target.value)}
                      maxLength={80}
                    />
                  </div>
                </div>
                <div className="field">
                  <label className="label" htmlFor="edit-meaning">
                    意味（必須）
                  </label>
                  <textarea
                    id="edit-meaning"
                    className="textarea"
                    style={{ minHeight: 68 }}
                    value={meaning}
                    onChange={(event) => setMeaning(event.target.value)}
                    maxLength={1000}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="edit-source">
                    例文（任意）
                  </label>
                  <textarea
                    id="edit-source"
                    className="textarea"
                    style={{ minHeight: 64 }}
                    value={sourceText}
                    onChange={(event) => setSourceText(event.target.value)}
                    maxLength={2000}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="edit-trans">
                    例文の和訳（任意）
                  </label>
                  <textarea
                    id="edit-trans"
                    className="textarea"
                    style={{ minHeight: 56 }}
                    value={translatedText}
                    onChange={(event) => setTranslatedText(event.target.value)}
                    maxLength={2000}
                  />
                </div>
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-primary grow"
                    onClick={() => void save()}
                    disabled={saving}
                  >
                    {saving ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
                    保存する
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setEditing(false)}
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div>
                  <div className="row between">
                    <div className="row" style={{ gap: 8, minWidth: 0 }}>
                      <strong
                        style={{
                          fontSize: 26,
                          fontWeight: 700,
                          lineHeight: 1.2,
                          overflowWrap: "anywhere",
                        }}
                      >
                        {word.term}
                      </strong>
                      <button
                        type="button"
                        className="btn-icon"
                        style={{ width: 32, height: 32, minHeight: 32 }}
                        onClick={() => void speak(word.term, word.sourceLang)}
                        aria-label="単語を発音"
                      >
                        <Volume2 size={16} />
                      </button>
                    </div>
                    <button
                      type="button"
                      className="btn-icon"
                      onClick={() => setEditing(true)}
                      aria-label="編集"
                    >
                      <Pencil size={15} />
                    </button>
                  </div>
                  <div className="row wrap" style={{ marginTop: 6, gap: 6 }}>
                    {word.partOfSpeech ? <span className="badge">{word.partOfSpeech}</span> : null}
                    {word.baseForm && word.baseForm !== word.term ? (
                      <span className="badge">基本形: {word.baseForm}</span>
                    ) : null}
                    {word.origin === "manual" ? (
                      <span className="badge">手入力</span>
                    ) : word.origin === "ai" ? (
                      <span className="badge">AI出題</span>
                    ) : null}
                    {word.mastered ? (
                      <span className="badge done">
                        <Check size={11} /> 習得済み
                      </span>
                    ) : (
                      <span className="badge due">
                        {formatNextReview(word.nextReviewAt, Date.now())}
                      </span>
                    )}
                  </div>
                </div>

                <div className="card card-pad">
                  <div className="label">意味</div>
                  <p style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.55, marginTop: 4 }}>
                    {word.meaning}
                  </p>
                </div>

                <div className="stack-sm">
                  <div className="between">
                    <div className="label">例文 ({word.examples?.length ?? 0})</div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void loadAlternativeExamples()}
                      disabled={altLoading}
                    >
                      {altLoading ? (
                        <Loader2 size={13} className="spin" />
                      ) : (
                        <Sparkles size={13} />
                      )}
                      別の例文をAIで生成
                    </button>
                  </div>

                  {(word.examples ?? []).map((example) => (
                    <div key={example.id} className="wb-example card card-pad stack-sm">
                      <div className="between" style={{ alignItems: "flex-start" }}>
                        <p style={{ fontSize: 15, lineHeight: 1.65 }}>
                          <HighlightedSentence text={example.sourceText} term={word.term} />
                        </p>
                        <button
                          type="button"
                          className="btn-icon"
                          style={{ width: 28, height: 28, minHeight: 28, flexShrink: 0 }}
                          onClick={() => void speak(example.sourceText, word.sourceLang)}
                          aria-label="例文を読み上げ"
                        >
                          <Volume2 size={14} />
                        </button>
                      </div>
                      {example.translatedText ? (
                        <p className="small muted">{example.translatedText}</p>
                      ) : null}
                      {example.contextMeaning ? (
                        <div className="hint-box">文脈での意味: {example.contextMeaning}</div>
                      ) : null}
                      {example.grammarNote ? (
                        <p className="small muted">{example.grammarNote}</p>
                      ) : null}
                      {example.imageKey ? (
                        <button
                          type="button"
                          className="wb-image"
                          onClick={() => setZoomImageUrl(`/api/images/${example.imageKey}`)}
                        >
                          <img
                            src={`/api/images/${example.imageKey}`}
                            alt="用例の画像"
                            loading="lazy"
                          />
                          <span>タップで画像を拡大</span>
                        </button>
                      ) : null}
                    </div>
                  ))}

                  {!word.examples?.length ? (
                    <p className="small muted">
                      例文はまだ登録されていません。右上の編集または「別の例文をAIで生成」から確認できます。
                    </p>
                  ) : null}

                  {altError ? <div className="form-error">{altError}</div> : null}

                  {altExamples.length > 0 ? (
                    <div className="stack-sm" style={{ marginTop: 6 }}>
                      <div className="small muted" style={{ fontWeight: 600 }}>
                        AIが生成した別の例文
                      </div>
                      {altExamples.map((ex, idx) => (
                        <div key={idx} className="card-soft card-pad stack-sm">
                          <div className="between" style={{ alignItems: "flex-start" }}>
                            <p style={{ fontSize: 14, lineHeight: 1.6 }}>
                              <HighlightedSentence text={ex.sourceText} term={word.term} />
                            </p>
                            <button
                              type="button"
                              className="btn-icon"
                              style={{ width: 26, height: 26, minHeight: 26 }}
                              onClick={() => void speak(ex.sourceText, word.sourceLang)}
                              aria-label="例文を読み上げ"
                            >
                              <Volume2 size={13} />
                            </button>
                          </div>
                          <p className="small muted">{ex.translatedText}</p>
                          {ex.note ? <p className="small muted">{ex.note}</p> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="wb-progress-detail">
                  <div className="label" style={{ marginBottom: 6 }}>
                    定着度（理解・想起ともに2回達成で習得済み）
                  </div>
                  <div>
                    <span>理解（英→日・文脈）</span>
                    <span>{Math.min(2, knownCount)} / 2</span>
                  </div>
                  <progress max={2} value={Math.min(2, knownCount)} />
                  <div>
                    <span>想起（日→英）</span>
                    <span>{Math.min(2, recallCount)} / 2</span>
                  </div>
                  <progress max={2} value={Math.min(2, recallCount)} />
                  <small style={{ display: "block", marginTop: 10 }}>
                    各トラックは日本時間で1日1回まで加算されます。間違えても下がりません。
                  </small>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ marginTop: 10 }}
                    onClick={() => void resetProgress()}
                    disabled={saving || (knownCount === 0 && recallCount === 0 && !word.mastered)}
                  >
                    <RotateCcw size={14} /> 定着度をリセット
                  </button>
                  <small style={{ display: "block", marginTop: 4 }}>
                    登録: {formatDateTime(word.createdAt)}
                    {word.lastReviewedAt ? ` · 最終復習: ${formatDateTime(word.lastReviewedAt)}` : ""}
                  </small>
                </div>

                <button
                  type="button"
                  className="btn btn-danger btn-block"
                  onClick={() => void remove()}
                  disabled={saving}
                >
                  <Trash2 size={15} /> この単語を削除
                </button>
              </>
            )}
          </div>
        ) : null}
      </Sheet>

      <ImageZoomModal
        src={zoomImageUrl}
        alt="用例画像の拡大表示"
        onClose={() => setZoomImageUrl(null)}
      />
    </>
  );
}
