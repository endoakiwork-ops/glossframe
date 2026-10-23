import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  BookMarked,
  Check,
  Loader2,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import type { WordCard, WordCompletionResult } from "../../shared/types";
import { formatNextReview, normalizeTerm } from "../../shared/srs";
import { api, errorMessage } from "../lib/api";
import { snippet } from "../lib/format";
import {
  loadPausedSessions,
  modeLabel,
  type PausedReviewSession,
} from "../lib/reviewSessions";
import { useApp } from "../context/AppContext";
import { EmptyState } from "../components/EmptyState";
import { Sheet } from "../components/Sheet";
import { WordCardSheet } from "../components/WordCardSheet";

type Filter = "all" | "due" | "waiting" | "mastered";
type SortOrder = "created" | "term" | "due" | "progress";

const TABS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "すべて" },
  { value: "due", label: "復習対象" },
  { value: "waiting", label: "復習待ち" },
  { value: "mastered", label: "習得済み" },
];

export function WordbookPage() {
  const navigate = useNavigate();
  const { settings, stats, refreshStats, learnerLevel, toast } = useApp();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortOrder>("created");
  const [items, setItems] = useState<WordCard[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pausedSessions, setPausedSessions] = useState<PausedReviewSession[]>(() =>
    loadPausedSessions(),
  );
  const requestId = useRef(0);

  // Manual word entry state
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTerm, setManualTerm] = useState("");
  const [manualMeaning, setManualMeaning] = useState("");
  const [manualSource, setManualSource] = useState("");
  const [manualTranslation, setManualTranslation] = useState("");
  const [manualBaseForm, setManualBaseForm] = useState("");
  const [manualPos, setManualPos] = useState("");
  const [manualNote, setManualNote] = useState("");
  const [manualExampleOpen, setManualExampleOpen] = useState(false);
  const [manualAiBusy, setManualAiBusy] = useState(false);
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState("");
  const [manualAiStatus, setManualAiStatus] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(q.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    void refreshStats();
    setPausedSessions(loadPausedSessions());
  }, [refreshStats]);

  const load = useCallback(
    async (nextOffset: number, append: boolean) => {
      const current = ++requestId.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({
          filter,
          sort,
          limit: "40",
          offset: String(nextOffset),
        });
        if (query) params.set("q", query);
        const data = await api<{
          items: WordCard[];
          total: number;
          hasMore: boolean;
          nextOffset: number;
        }>(`/api/words?${params.toString()}`);
        if (current !== requestId.current) return;
        setItems((previous) => (append ? [...previous, ...data.items] : data.items));
        setTotal(data.total);
        setHasMore(data.hasMore);
        setOffset(data.nextOffset);
      } catch (err) {
        if (current === requestId.current) setError(errorMessage(err));
      } finally {
        if (current === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [filter, query, sort],
  );

  useEffect(() => {
    void load(0, false);
  }, [load, refreshKey]);

  const dueCount = stats?.dueWords ?? 0;
  const totalWords = stats?.words ?? total;

  function onChanged() {
    setRefreshKey((value) => value + 1);
    void refreshStats();
  }

  function openManualModal() {
    setManualTerm("");
    setManualMeaning("");
    setManualSource("");
    setManualTranslation("");
    setManualBaseForm("");
    setManualPos("");
    setManualNote("");
    setManualExampleOpen(false);
    setManualError("");
    setManualAiStatus("");
    setManualOpen(true);
  }

  async function runManualAiComplete() {
    const term = manualTerm.trim();
    if (!term) {
      setManualError("補完する英単語または熟語を先に入力してください。");
      return;
    }
    setManualAiBusy(true);
    setManualError("");
    setManualAiStatus("AIで不足項目を補完しています…");
    try {
      const res = await api<WordCompletionResult>("/api/words/complete", {
        method: "POST",
        body: {
          term,
          meaning: manualMeaning.trim(),
          sourceText: manualSource.trim(),
          translatedText: manualTranslation.trim(),
          sourceLang: settings?.sourceLang ?? "en",
          targetLang: settings?.targetLang ?? "ja",
          learnerLevel,
        },
        timeoutMs: 60_000,
      });
      // Never overwrite fields already entered by the user
      if (!manualMeaning.trim() && res.meaning) {
        setManualMeaning(current => current.trim() ? current : res.meaning);
      }
      if (!manualSource.trim() && res.sourceText) {
        setManualSource(current => current.trim() ? current : res.sourceText);
        setManualExampleOpen(true);
      }
      if (!manualTranslation.trim() && res.translatedText) {
        setManualTranslation(current => current.trim() ? current : res.translatedText);
        setManualExampleOpen(true);
      }
      if (res.baseForm) setManualBaseForm(res.baseForm);
      if (res.partOfSpeech) setManualPos(res.partOfSpeech);
      if (res.grammarNote) setManualNote(res.grammarNote);
      setManualAiStatus("入力済みの項目を保持したまま、不足項目を補完しました。");
      void refreshStats();
    } catch (err) {
      setManualAiStatus("");
      setManualError(errorMessage(err));
    } finally {
      setManualAiBusy(false);
    }
  }

  async function submitManualWord(event: React.FormEvent) {
    event.preventDefault();
    const term = manualTerm.trim();
    const meaning = manualMeaning.trim();
    if (!term) {
      setManualError("英単語・熟語を入力してください。");
      return;
    }
    if (!meaning) {
      setManualError("意味を入力してください。");
      return;
    }

    const norm = normalizeTerm(term);
    const localDup = items.find(
      (w) => normalizeTerm(w.term) === norm && w.meaning.trim() === meaning,
    );
    if (localDup && !manualSource.trim()) {
      setManualError("同じ単語・意味が既に登録されています。");
      return;
    }

    setManualSaving(true);
    setManualError("");
    try {
      await api<{ word: WordCard }>("/api/words", {
        method: "POST",
        body: {
          term,
          baseForm: manualBaseForm.trim() || term,
          partOfSpeech: manualPos.trim(),
          meaning,
          contextMeaning: "",
          sourceText: manualSource.trim(),
          translatedText: manualTranslation.trim(),
          grammarNote: manualNote.trim(),
          sourceLang: settings?.sourceLang ?? "en",
          targetLang: settings?.targetLang ?? "ja",
          origin: "manual",
          image: null,
          existingImageKey: null,
        },
      });
      setManualOpen(false);
      onChanged();
    } catch (err) {
      setManualError(errorMessage(err));
    } finally {
      setManualSaving(false);
    }
  }

  const latestPaused = pausedSessions[0] ?? null;

  return (
    <div className="stack fade-in">
      <div className="wb-quick-actions">
        <button
          type="button"
          className="wb-review-shortcut"
          onClick={() => navigate("/review")}
        >
          <span>復習を始める</span>
          <strong>
            {dueCount > 0 ? dueCount : totalWords}
            <small>{dueCount > 0 ? "語が対象" : "語を復習"}</small>
          </strong>
          <span className="wb-shortcut-arrow">→</span>
        </button>

        <button
          type="button"
          className="wb-ai-shortcut"
          onClick={() => navigate("/review?source=ai")}
        >
          <span>AI出題で力試し</span>
          <small>単語帳を基準に4択生成</small>
          <span className="wb-shortcut-arrow">→</span>
        </button>
      </div>

      {latestPaused ? (
        <button
          type="button"
          className="wb-resume"
          onClick={() => navigate(`/review?resume=${encodeURIComponent(latestPaused.id)}`)}
        >
          中断中の{latestPaused.source === "ai" ? "AI出題" : "復習"}（{modeLabel(latestPaused.mode)} ·{" "}
          {latestPaused.index + 1}/{latestPaused.questions.length}問）を再開 →
        </button>
      ) : null}

      <div className="wb-section-heading wb-collection-heading">
        <h3>登録した言葉</h3>
        <button type="button" className="wb-text" onClick={openManualModal}>
          <Plus size={13} style={{ verticalAlign: "-2px", marginRight: 2 }} />
          手入力で追加
        </button>
      </div>

      <div>
        <div className="wb-search">
          <Search size={16} color="var(--muted)" />
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="単語・意味で検索"
            aria-label="単語帳を検索"
          />
        </div>

        <div className="wb-toolbar">
          <div className="wb-filters" role="tablist" aria-label="単語帳の絞り込み">
            {TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={filter === tab.value}
                className={`wb-chip${filter === tab.value ? " active" : ""}`}
                onClick={() => setFilter(tab.value)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="wb-sort">
            <small>{total}語</small>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as SortOrder)}
              aria-label="並び替え"
            >
              <option value="created">登録順</option>
              <option value="term">名前順</option>
              <option value="due">復習順</option>
              <option value="progress">定着度順</option>
            </select>
          </div>
        </div>
      </div>

      {error ? <div className="form-error">{error}</div> : null}

      {loading ? (
        <div className="card card-pad center">
          <Loader2 className="spin" style={{ color: "var(--teal)" }} />
          <p className="small muted" style={{ marginTop: 8 }}>
            単語帳を読み込んでいます…
          </p>
        </div>
      ) : items.length ? (
        <>
          <div className="wb-list">
            {items.map((word) => {
              const due =
                !word.mastered && (word.nextReviewAt == null || word.nextReviewAt <= Date.now());
              const knownCount = Math.min(2, word.knownCount ?? word.reviewCount ?? 0);
              const recallCount = Math.min(2, word.recallCount ?? 0);
              return (
                <button
                  key={word.id}
                  type="button"
                  className="wb-word-row"
                  onClick={() => setOpenId(word.id)}
                >
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <strong>{word.term}</strong>
                    <span className="wb-row-meaning">{snippet(word.meaning, 80)}</span>
                    <span className="wb-dots">
                      <i className={knownCount >= 1 ? "on" : ""} />
                      <i className={knownCount >= 2 ? "on" : ""} />
                      <i className={recallCount >= 1 ? "on" : ""} />
                      <i className={recallCount >= 2 ? "on" : ""} />
                      <small>
                        理解 {knownCount}/2 · 想起 {recallCount}/2
                      </small>
                    </span>
                  </span>
                  <span className="wb-row-end">
                    <span className={`wb-badge${word.mastered ? " strong" : ""}`}>
                      {word.mastered ? (
                        <>
                          <Check size={10} style={{ verticalAlign: "-1px", marginRight: 2 }} />
                          習得済み
                        </>
                      ) : due ? (
                        "復習対象"
                      ) : (
                        formatNextReview(word.nextReviewAt)
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {hasMore ? (
            <div className="load-more">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void load(offset, true)}
                disabled={loadingMore}
              >
                {loadingMore ? <Loader2 size={14} className="spin" /> : null}
                もっと見る
              </button>
            </div>
          ) : null}
        </>
      ) : query ? (
        <EmptyState
          icon={<Search size={20} />}
          title="見つかりませんでした"
          description={`「${query}」に一致する単語はありません。`}
          action={
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setQ("")}>
              検索をクリア
            </button>
          }
        />
      ) : filter === "all" ? (
        <EmptyState
          icon={<BookMarked size={20} />}
          title="単語帳はまだ空です"
          description="翻訳結果の単語をタップするか、「手入力で追加」から語句を登録できます。"
          action={
            <div className="row" style={{ justifyContent: "center", gap: 8 }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={openManualModal}>
                手入力で追加
              </button>
              <Link to="/" className="btn btn-secondary btn-sm">
                カメラで翻訳
              </Link>
            </div>
          }
        />
      ) : (
        <EmptyState
          icon={<BookMarked size={20} />}
          title={
            filter === "due"
              ? "復習対象はありません"
              : filter === "waiting"
                ? "復習待ちはありません"
                : "習得済みの単語はありません"
          }
          description="別のフィルターに切り替えるか、全登録語の復習をお試しください。"
        />
      )}

      <Sheet
        open={manualOpen}
        title="単語を手入力で追加"
        onClose={() => setManualOpen(false)}
      >
        <form className="wb-manual wb-edit" onSubmit={(e) => void submitManualWord(e)}>
          {manualError ? <div className="form-error">{manualError}</div> : null}

          <label>
            <span>英単語・熟語（必須）</span>
            <input
              value={manualTerm}
              onChange={(e) => setManualTerm(e.target.value)}
              placeholder="例: take for granted"
              maxLength={200}
              required
            />
          </label>

          <label>
            <span>意味（必須）</span>
            <input
              value={manualMeaning}
              onChange={(e) => setManualMeaning(e.target.value)}
              placeholder="例: 当たり前のことと思う"
              maxLength={1000}
              required
            />
          </label>

          <div className="wb-ai-fill">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void runManualAiComplete()}
              disabled={manualAiBusy || !manualTerm.trim()}
            >
              {manualAiBusy ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Sparkles size={14} />
              )}
              AIで例文・未入力項目を補完
            </button>
            <small>既に入力した意味や例文は上書きせず、空欄だけを補完します。</small>
            {manualAiStatus ? (
              <p id="wbAiStatus" className="small muted">
                {manualAiStatus}
              </p>
            ) : null}
          </div>

          <details
            open={manualExampleOpen}
            onToggle={(e) => setManualExampleOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>例文を追加する（任意）</summary>
            <div className="stack-sm">
              <label>
                <span>例文（英語）</span>
                <textarea
                  rows={2}
                  value={manualSource}
                  onChange={(e) => setManualSource(e.target.value)}
                  placeholder="例: We often take clean water for granted."
                  maxLength={2000}
                />
              </label>
              <label>
                <span>例文の和訳</span>
                <textarea
                  rows={2}
                  value={manualTranslation}
                  onChange={(e) => setManualTranslation(e.target.value)}
                  placeholder="例: 私たちはきれいな水を当たり前と思いがちだ。"
                  maxLength={2000}
                />
              </label>
            </div>
          </details>

          <div className="row" style={{ marginTop: 6 }}>
            <button
              type="submit"
              className="btn btn-primary grow"
              disabled={manualSaving}
            >
              {manualSaving ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
              単語帳に保存
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setManualOpen(false)}
            >
              キャンセル
            </button>
          </div>
        </form>
      </Sheet>

      <WordCardSheet
        wordId={openId}
        onClose={() => setOpenId(null)}
        onChanged={onChanged}
      />
    </div>
  );
}
