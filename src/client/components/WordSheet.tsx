import { useEffect, useMemo, useState } from "react";
import { BookPlus, Loader2, RefreshCw, Sparkles } from "lucide-react";
import type { SimilarExpression, WordCard, WordDetail } from "../../shared/types";
import { api, errorMessage } from "../lib/api";
import { useApp } from "../context/AppContext";
import { Sheet } from "./Sheet";
import { WordbookForm, type WordDraft } from "./WordbookForm";

interface LookupResponse extends WordDetail {
  cached: boolean;
}

interface SimilarResponse {
  expressions: SimilarExpression[];
  cached: boolean;
}

export interface WordSheetRequest {
  term: string;
  sentence: string;
  translation: string;
  sourceLang: string;
  targetLang: string;
  side: "source" | "translation";
  translationId?: string | null;
  imageKey?: string | null;
  grammarNote?: string;
}

export function WordSheet({
  request,
  onClose,
  onSaved,
}: {
  request: WordSheetRequest | null;
  onClose: () => void;
  onSaved?: (word: WordCard) => void;
}) {
  const { toast } = useApp();
  const [activeTerm, setActiveTerm] = useState("");
  const [activeSide, setActiveSide] = useState<"source" | "translation">("source");
  const [detail, setDetail] = useState<LookupResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [similar, setSimilar] = useState<SimilarExpression[] | null>(null);
  const [similarLoading, setSimilarLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    if (!request) return;
    setActiveTerm(request.term);
    setActiveSide(request.side);
    setDetail(null);
    setSimilar(null);
    setError("");
    setFormOpen(false);
  }, [request]);

  useEffect(() => {
    if (!request || !activeTerm) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setDetail(null);
    api<LookupResponse>("/api/words/lookup", {
      method: "POST",
      body: {
        term: activeTerm,
        sentence: request.sentence,
        translation: request.translation,
        sourceLang: request.sourceLang,
        targetLang: request.targetLang,
        side: activeSide,
      },
      timeoutMs: 90_000,
    })
      .then((data) => {
        if (!cancelled) setDetail(data);
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
  }, [request, activeTerm, activeSide]);

  const draft = useMemo<WordDraft | null>(() => {
    if (!request || !detail) return null;
    return {
      term: detail.term || activeTerm,
      baseForm: detail.baseForm,
      partOfSpeech: detail.partOfSpeech,
      meaning: detail.meaning || detail.contextMeaning,
      contextMeaning: detail.contextMeaning,
      sourceText: request.sentence,
      translatedText: request.translation,
      grammarNote: request.grammarNote,
      sourceLang: request.sourceLang,
      targetLang: request.targetLang,
      translationId: request.translationId ?? null,
      imageKey: request.imageKey ?? null,
    };
  }, [request, detail, activeTerm]);

  async function loadSimilar() {
    if (!request || !detail) return;
    setSimilarLoading(true);
    try {
      const data = await api<SimilarResponse>("/api/words/similar", {
        method: "POST",
        body: {
          term: detail.term || activeTerm,
          sentence: request.sentence,
          sourceLang: request.sourceLang,
          targetLang: request.targetLang,
        },
        timeoutMs: 90_000,
      });
      setSimilar(data.expressions);
      if (!data.expressions.length) toast("似た表現が見つかりませんでした。", "info");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setSimilarLoading(false);
    }
  }

  function lookupAnother(term: string) {
    setActiveTerm(term);
    setActiveSide("source");
    setSimilar(null);
  }

  return (
    <>
      <Sheet open={Boolean(request)} title="単語の詳細" onClose={onClose}>
        {request ? (
          <div className="stack">
            <div>
              <div className="eyebrow">
                {activeSide === "translation" ? "訳文から原文を確認" : "原文の単語"}
              </div>
              <div
                style={{
                  fontFamily: "var(--serif)",
                  fontSize: 29,
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                  lineHeight: 1.2,
                  overflowWrap: "anywhere",
                  marginTop: 3,
                }}
              >
                {activeTerm}
              </div>
              <div className="word-sentence" style={{ marginTop: 12 }}>
                <div>{request.sentence}</div>
                {request.translation ? (
                  <div className="translation">{request.translation}</div>
                ) : null}
              </div>
            </div>

            {loading ? (
              <div className="card-soft card-pad center">
                <Loader2 size={22} className="spin" style={{ color: "var(--teal-3)" }} />
                <p className="small muted" style={{ marginTop: 8 }}>
                  Workers AI が文中での意味を調べています…
                </p>
              </div>
            ) : error ? (
              <div className="form-error">
                {error}
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => {
                      const current = activeTerm;
                      setActiveTerm("");
                      window.setTimeout(() => setActiveTerm(current), 0);
                    }}
                  >
                    <RefreshCw size={13} /> 再試行
                  </button>
                </div>
              </div>
            ) : detail ? (
              <>
                <div className="card card-pad stack-sm">
                  <div className="row wrap">
                    {detail.partOfSpeech ? (
                      <span className="badge">{detail.partOfSpeech}</span>
                    ) : null}
                    {detail.baseForm && detail.baseForm !== detail.term ? (
                      <span className="badge">基本形: {detail.baseForm}</span>
                    ) : null}
                  </div>
                  <div>
                    <div className="label">意味</div>
                    <p style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.6 }}>
                      {detail.meaning || "—"}
                    </p>
                  </div>
                  {detail.contextMeaning ? (
                    <div>
                      <div className="label">この文章での意味</div>
                      <p style={{ fontSize: 13.5, lineHeight: 1.65 }}>
                        {detail.contextMeaning}
                      </p>
                    </div>
                  ) : null}
                  {detail.note ? (
                    <div className="hint-box">{detail.note}</div>
                  ) : null}
                  {activeSide === "translation" && detail.sourceEquivalent ? (
                    <div className="warning-box">
                      対応する原文: <strong>{detail.sourceEquivalent}</strong>
                    </div>
                  ) : null}
                </div>

                <div className="row wrap">
                  <button
                    type="button"
                    className="btn btn-primary grow"
                    onClick={() => setFormOpen(true)}
                  >
                    <BookPlus size={17} /> 単語帳に追加
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={loadSimilar}
                    disabled={similarLoading}
                  >
                    {similarLoading ? (
                      <Loader2 size={16} className="spin" />
                    ) : (
                      <Sparkles size={16} />
                    )}
                    似た表現
                  </button>
                </div>

                {similar ? (
                  <div className="stack-sm">
                    <div className="label">似た表現と使い分け</div>
                    {similar.map((item) => (
                      <button
                        key={item.term}
                        type="button"
                        className="card card-pad"
                        style={{ textAlign: "left" }}
                        onClick={() => lookupAnother(item.term)}
                      >
                        <div className="row between">
                          <strong style={{ fontFamily: "var(--serif)", fontSize: 17 }}>
                            {item.term}
                          </strong>
                          <span className="badge">調べる</span>
                        </div>
                        <p style={{ fontSize: 13, marginTop: 3 }}>{item.meaning}</p>
                        <p className="small muted" style={{ marginTop: 3 }}>
                          {item.difference}
                        </p>
                      </button>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </Sheet>

      <WordbookForm
        open={formOpen}
        draft={draft}
        onClose={() => setFormOpen(false)}
        onSaved={(word) => {
          onSaved?.(word);
          onClose();
        }}
      />
    </>
  );
}
