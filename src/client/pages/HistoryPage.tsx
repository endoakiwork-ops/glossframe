import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Camera,
  Clock3,
  Loader2,
  Search,
  Trash2,
} from "lucide-react";
import type { TranslationRecord } from "../../shared/types";
import { languageLabel } from "../../shared/languages";
import { api, errorMessage } from "../lib/api";
import { formatDateTime, snippet } from "../lib/format";
import { deleteLocalBlob, translationImageKey } from "../lib/localdb";
import { useApp } from "../context/AppContext";
import { EmptyState } from "../components/EmptyState";

export function HistoryPage() {
  const { toast, refreshStats } = useApp();
  const [items, setItems] = useState<TranslationRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(q.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [q]);

  const load = useCallback(
    async (nextOffset: number, append: boolean) => {
      const current = ++requestId.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError("");
      try {
        const data = await api<{
          items: TranslationRecord[];
          total: number;
          hasMore: boolean;
          nextOffset: number;
        }>(
          `/api/translations?limit=30&offset=${nextOffset}${
            query ? `&q=${encodeURIComponent(query)}` : ""
          }`,
        );
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
    [query],
  );

  useEffect(() => {
    void load(0, false);
  }, [load]);

  async function remove(item: TranslationRecord) {
    setDeleting(item.id);
    try {
      await api(`/api/translations/${item.id}`, { method: "DELETE" });
      await deleteLocalBlob(translationImageKey(item.id));
      setItems((previous) => previous.filter((entry) => entry.id !== item.id));
      setTotal((value) => Math.max(0, value - 1));
      void refreshStats();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="stack fade-in">
      <div className="page-head">
        <div>
          <h1 className="title-lg">翻訳履歴</h1>
          <p className="subtitle">{total} 件の翻訳（新しい順に最大100件まで保存・単語帳には影響しません）</p>
        </div>
        <Link to="/" className="btn btn-secondary btn-sm">
          <Camera size={14} /> 撮影
        </Link>
      </div>

      <div className="search-row">
        <div className="search-input">
          <Search size={16} />
          <input
            className="input"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="原文・訳文を検索"
            aria-label="翻訳履歴を検索"
          />
        </div>
      </div>

      {error ? <div className="form-error">{error}</div> : null}

      {loading ? (
        <div className="card card-pad center">
          <Loader2 className="spin" style={{ color: "var(--teal-3)" }} />
          <p className="small muted" style={{ marginTop: 8 }}>
            履歴を読み込んでいます…
          </p>
        </div>
      ) : items.length ? (
        <>
          <div className="history-list">
            {items.map((item) => (
              <div key={item.id} className="history-item">
                <Link
                  to={`/result/${item.id}`}
                  style={{
                    display: "flex",
                    gap: 12,
                    flex: 1,
                    minWidth: 0,
                    color: "inherit",
                  }}
                >
                  {item.imageKey ? (
                    <img
                      className="history-thumb"
                      src={`/api/images/${item.imageKey}`}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <span className="history-thumb" style={{ display: "grid", placeItems: "center" }}>
                      <Clock3 size={20} color="var(--muted-2)" />
                    </span>
                  )}
                  <span className="history-body">
                    <span className="history-meta">
                      <span className="lang">
                        {languageLabel(item.sourceLang)} → {languageLabel(item.targetLang)}
                      </span>
                      <span>·</span>
                      <span>{formatDateTime(item.createdAt)}</span>
                    </span>
                    <span className="history-source">{snippet(item.sourceText, 110)}</span>
                    <span className="history-translation">
                      {snippet(item.translatedText, 110)}
                    </span>
                  </span>
                </Link>
                <button
                  type="button"
                  className="btn-icon"
                  style={{ alignSelf: "flex-start", width: 34, height: 34, minHeight: 34 }}
                  onClick={() => void remove(item)}
                  disabled={deleting === item.id}
                  aria-label="この履歴を削除"
                >
                  {deleting === item.id ? (
                    <Loader2 size={15} className="spin" />
                  ) : (
                    <Trash2 size={15} />
                  )}
                </button>
              </div>
            ))}
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
          icon={<Search size={22} />}
          title="見つかりませんでした"
          description={`「${query}」を含む翻訳履歴はありません。別の言葉で検索してください。`}
          action={
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setQ("")}>
              検索をクリア
            </button>
          }
        />
      ) : (
        <EmptyState
          icon={<Camera size={22} />}
          title="まだ履歴がありません"
          description="画像を撮影して翻訳すると、原文・訳文・文法解説がここに保存されます。"
          action={
            <Link to="/" className="btn btn-primary btn-sm">
              最初の翻訳をはじめる
            </Link>
          }
        />
      )}
    </div>
  );
}
