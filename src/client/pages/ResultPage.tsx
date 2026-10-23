import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  Languages,
  Loader2,
  Plus,
  Send,
  Sparkles,
  Volume2,
  X,
} from "lucide-react";
import {
  LEARNER_LEVELS,
  type ChatTurn,
  type LearnerLevel,
  type SelectedTextRange,
  type SimilarExpression,
  type TranslationRecord,
  type TranslationResult,
  type WordCard,
  type WordDetail,
} from "../../shared/types";
import { languageLabel } from "../../shared/languages";
import { normalizeTerm } from "../../shared/srs";
import { api, errorMessage } from "../lib/api";
import { getLocalBlob, translationImageKey } from "../lib/localdb";
import { tokenize, type Token } from "../lib/tokenize";
import { useApp } from "../context/AppContext";
import { useAiQuota } from "../components/AiUsageSheet";
import { TranslationImage } from "../components/TranslationImage";
import type { TranslationRegion } from "../../shared/translation-regions";
import { stopCloudTts } from "../lib/audio";
import { KeyedRequestQueue, type RequestPriority } from "../lib/requestQueue";
import "../translation-view.css";

interface ResultNavState {
  translation?: TranslationResult;
  regions?: TranslationRegion[];
  imageFile?: File | null;
}

interface LookupResponse extends WordDetail {
  cached: boolean;
}

interface SimilarResponse {
  expressions: SimilarExpression[];
  cached: boolean;
}

interface ExplainResponse {
  points: string[];
  cached: boolean;
}

interface ChatResponse {
  answer: string;
  cached: boolean;
}

interface RegionChatState {
  history: ChatTurn[];
  latest: {
    question: string;
    answer: string;
    rangeText?: string;
  } | null;
}

interface Span {
  start: number;
  end: number;
}

type PanelMode = "none" | "word" | "ai";

// Caps background prefetch for very long regions (e.g. the legacy full text).
const PREFETCH_WORD_LIMIT = 40;

function selectionWithin(
  element: HTMLElement | null,
  text: string,
  side: "source" | "translation",
): SelectedTextRange | null {
  if (!element || typeof window === "undefined") return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) {
    return null;
  }

  const raw = range.toString();
  const selected = raw.trim();
  if (!selected) return null;

  let prefix = "";
  try {
    const before = range.cloneRange();
    before.selectNodeContents(element);
    before.setEnd(range.startContainer, range.startOffset);
    prefix = before.toString();
  } catch {
    return null;
  }

  const leading = raw.length - raw.trimStart().length;
  const start = prefix.length + leading;
  const end = start + selected.length;
  if (text.slice(start, end) === selected) {
    return { side, text: selected, start, end };
  }

  // Range.toString() can normalise line endings; fall back to the exact text.
  const found = text.indexOf(selected);
  if (found < 0) return null;
  return { side, text: selected, start: found, end: found + selected.length };
}

interface LiveResult {
  translation: TranslationResult;
  regions: TranslationRegion[];
  imageFile: File;
  onCancel: () => void;
}

export function ResultPage({ live }: { live?: LiveResult } = {}) {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const {
    settings,
    toast,
    refreshStats,
    learnerLevel,
    performanceMode,
    setLearnerLevel,
    setUsageOpen,
    speak,
  } = useApp();
  const quota = useAiQuota();
  const navState = (location.state as ResultNavState | null) ?? null;
  const imageFile = live?.imageFile ?? navState?.imageFile ?? null;
  const initialTranslation = live?.translation ?? (
    navState?.translation && (!id || navState.translation.id === id)
      ? navState.translation
      : null);

  const [translation, setTranslation] = useState<TranslationRecord | TranslationResult | null>(
    () => initialTranslation,
  );
  const [loading, setLoading] = useState(!initialTranslation);
  const [error, setError] = useState("");

  const [regions, setRegions] = useState<TranslationRegion[]>(() => navState?.regions ?? []);
  const [activeRegion, setActiveRegion] = useState<TranslationRegion | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>("none");

  const [activeTerm, setActiveTerm] = useState("");
  const [chosenSpan, setChosenSpan] = useState<Span | null>(null);
  const [lookupNonce, setLookupNonce] = useState(0);
  const [wordDetail, setWordDetail] = useState<LookupResponse | null>(null);
  const [wordLoading, setWordLoading] = useState(false);
  const [wordError, setWordError] = useState("");
  const [similarList, setSimilarList] = useState<SimilarExpression[] | null>(null);
  const [similarLoading, setSimilarLoading] = useState(false);
  const [similarError, setSimilarError] = useState("");
  const [savingWord, setSavingWord] = useState(false);
  const [savedTerms, setSavedTerms] = useState<Set<string>>(new Set());

  const [explainPoints, setExplainPoints] = useState<string[]>([]);
  const [explainLoading, setExplainLoading] = useState(false);
  const [explainError, setExplainError] = useState("");

  const [questionRange, setQuestionRange] = useState<SelectedTextRange | null>(null);
  const [questionInput, setQuestionInput] = useState("");
  const [pendingChats, setPendingChats] = useState<Set<string>>(new Set());
  const chatLoading = activeRegion ? pendingChats.has(activeRegion.id) : false;
  const [chatError, setChatError] = useState("");
  const [chatsByRegion, setChatsByRegion] = useState<Record<string, RegionChatState>>({});

  const [fileImageUrl, setFileImageUrl] = useState<string | null>(null);
  const [localImageUrl, setLocalImageUrl] = useState<string | null>(null);

  const [viewport, setViewport] = useState(() => {
    if (typeof window === "undefined") return { height: 0, top: 0 };
    const visual = window.visualViewport;
    return {
      height: visual?.height ?? window.innerHeight,
      top: visual?.offsetTop ?? 0,
    };
  });

  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const cardScrollRef = useRef<HTMLDivElement | null>(null);
  const sourceRef = useRef<HTMLParagraphElement | null>(null);
  const translationRef = useRef<HTMLParagraphElement | null>(null);
  const activeRegionRef = useRef<TranslationRegion | null>(null);

  const sourceLang = translation?.sourceLang ?? settings?.sourceLang ?? "en";
  const targetLang = translation?.targetLang ?? settings?.targetLang ?? "ja";
  const activeChat = activeRegion ? chatsByRegion[activeRegion.id] : undefined;
  const latestAnswer = activeChat?.latest?.answer ?? "";
  const phraseMeaning =
    translation?.keyPhrases.find((phrase) => normalizeTerm(phrase.term) === normalizeTerm(activeTerm))
      ?.meaning ?? "";
  // The lookup returns 2-3 short glosses in `meaning`; show those, not an interpretation.
  const wordMeaning =
    wordDetail?.meaning || wordDetail?.contextMeaning || phraseMeaning || "";
  const candidate = (wordDetail?.term || activeTerm).trim();
  const canSaveTerm =
    candidate.split(/\s+/).filter(Boolean).length === 1 ||
    (translation?.keyPhrases ?? []).some(
      (phrase) => normalizeTerm(phrase.term) === normalizeTerm(candidate),
    );
  const isCurrentTermSaved = savedTerms.has(normalizeTerm(wordDetail?.term || activeTerm));
  const quotaLabel =
    quota.used !== null
      ? `AI枠 ${quota.short} Neurons${quota.source === "preview" ? "（表示例）" : ""}`
      : "AI枠";
  const ringOffset = Math.round((1 - quota.ratio) * 69);

  const shellStyle = {
    "--tv-vvh": `${Math.max(1, viewport.height)}px`,
    "--tv-vvtop": `${viewport.top}px`,
  } as CSSProperties;

  const relatedPhrases = useMemo(() => {
    if (!activeRegion || !activeTerm.trim()) return [];
    const word = activeTerm.trim().toLowerCase();
    return (translation?.keyPhrases ?? [])
      .filter((phrase) => {
        const term = phrase.term.trim();
        if (!term || !activeRegion.source.includes(term)) return false;
        if (normalizeTerm(term) === normalizeTerm(activeTerm)) return false;
        return term.toLowerCase().split(/\s+/).includes(word);
      })
      .slice(0, 4);
  }, [activeRegion, activeTerm, translation]);

  const goCamera = useCallback(() => {
    stopCloudTts();
    if (live) live.onCancel();
    else navigate("/", { replace: true });
  }, [navigate, live?.onCancel]);

  useEffect(() => {
    activeRegionRef.current = activeRegion;
  }, [activeRegion]);

  // Keep the result surface inside the visible area when a mobile keyboard or
  // browser chrome changes the visual viewport.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => {
      const visual = window.visualViewport;
      // Only the keyboard and browser chrome should reshape the screen. If the
      // page itself got zoomed, following it would re-fit the image mid-pinch.
      if (visual && visual.scale > 1.01) return;
      setViewport({
        height: Math.max(1, visual?.height ?? window.innerHeight),
        top: visual?.offsetTop ?? 0,
      });
    };
    update();
    const visual = window.visualViewport;
    visual?.addEventListener("resize", update);
    visual?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      visual?.removeEventListener("resize", update);
      visual?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    if (live) {
      setTranslation(live.translation);
      setRegions(live.regions);
      setLoading(false);
    }
  }, [live?.translation, live?.regions]);

  useEffect(() => {
    if (live || !id) return;
    if (translation && translation.id === id) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    api<TranslationRecord>(`/api/translations/${id}`)
      .then((data) => {
        if (!cancelled) setTranslation(data);
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
  }, [id, translation]);

  // The navigation state is the canonical source for a just-captured result;
  // history links load the persisted regions through GET /regions.
  useEffect(() => {
    if (live) return;
    let alive = true;
    setActiveRegion(null);
    setPanelMode("none");
    setActiveTerm("");
    setChosenSpan(null);
    setQuestionRange(null);
    setChatError("");

    if (navState?.regions) {
      setRegions(navState.regions);
      return () => {
        alive = false;
      };
    }

    setRegions([]);
    if (!id) {
      return () => {
        alive = false;
      };
    }
    api<{ regions: TranslationRegion[] }>(`/api/translations/${id}/regions`)
      .then((data) => {
        if (alive) setRegions(Array.isArray(data.regions) ? data.regions : []);
      })
      .catch(() => {
        if (alive) setRegions([]);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    if (!imageFile) {
      setFileImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(imageFile);
    setFileImageUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [imageFile]);

  useEffect(() => {
    if (!id || imageFile) {
      setLocalImageUrl(null);
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    getLocalBlob(translationImageKey(id)).then((blob) => {
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setLocalImageUrl(url);
    }).catch(() => { /* Persisted server image remains available. */ });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, imageFile]);

  // The card is an overlay, so its measured height decides how much viewport
  // remains for the image. Measuring (rather than assuming 38%) lets a short
  // card leave more room for the photo.
  useEffect(() => {
    const shell = rootRef.current;
    if (!shell) return;
    const update = () => {
      const card = cardRef.current;
      const height = card ? Math.round(card.getBoundingClientRect().height) : 0;
      shell.style.setProperty("--tv-card-height", `${Math.max(0, height)}px`);
    };
    update();
    const card = cardRef.current;
    const observer =
      card && typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (card) observer?.observe(card);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [activeRegion, panelMode, viewport.height]);

  useEffect(() => {
    if (!activeRegion) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(".sheet, dialog[open]")) return;
      event.preventDefault();
      goCamera();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeRegion, goCamera]);

  useEffect(() => {
    cardScrollRef.current?.scrollTo({ top: 0 });
  }, [activeRegion?.id]);

  useEffect(() => {
    if (panelMode !== "ai" || !latestAnswer) return;
    const element = cardScrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [latestAnswer, panelMode]);

  useEffect(() => {
    return () => stopCloudTts();
  }, []);

  // Native selection is the only range-selection mechanism, matching v8-v16.
  useEffect(() => {
    if (!activeRegion) return;
    let timer = 0;
    const onSelectionChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const sourceSelection = selectionWithin(
          sourceRef.current,
          activeRegion.source,
          "source",
        );
        if (sourceSelection) {
          setQuestionRange(sourceSelection);
          return;
        }
        const translationSelection = selectionWithin(
          translationRef.current,
          activeRegion.translation,
          "translation",
        );
        if (translationSelection) setQuestionRange(translationSelection);
      }, 180);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      window.clearTimeout(timer);
    };
  }, [activeRegion]);

  // Word lookups and similar expressions share one queue: tapped terms run
  // first, and the background prefetch of the open sentence fills idle time.
  const requestQueue = useRef(new KeyedRequestQueue(3));
  const requestLookup = useCallback(
    (term: string, region: TranslationRegion, priority: RequestPriority) =>
      requestQueue.current.request(
        ["lookup", term, region.source, region.translation, sourceLang, targetLang].join("\u0000"),
        () =>
          api<LookupResponse>("/api/words/lookup", {
            method: "POST",
            body: {
              term,
              sentence: region.source,
              translation: region.translation,
              sourceLang,
              targetLang,
              side: "source",
            },
            timeoutMs: 60_000,
          }),
        priority,
      ),
    [sourceLang, targetLang],
  );
  const requestSimilar = useCallback(
    (term: string, sentence: string, priority: RequestPriority) =>
      requestQueue.current.request(
        ["similar", term, sentence, sourceLang, targetLang, learnerLevel].join("\u0000"),
        () =>
          api<SimilarResponse>("/api/words/similar", {
            method: "POST",
            body: { term, sentence, sourceLang, targetLang, learnerLevel },
            timeoutMs: 20_000,
          }),
        priority,
      ),
    [sourceLang, targetLang, learnerLevel],
  );

  const refreshStatsRef = useRef(refreshStats);
  useEffect(() => {
    refreshStatsRef.current = refreshStats;
  }, [refreshStats]);

  // Response mode: once a sentence opens, look up each of its words in the
  // background, then their similar expressions after all lookups settle.
  useEffect(() => {
    if (performanceMode !== "response" || !activeRegion) return;
    const region = activeRegion;
    const queue = requestQueue.current;
    const terms = [
      ...new Set(
        tokenize(region.source, sourceLang)
          .filter((token) => token.isWord && token.text.trim() && !/^\d+$/.test(token.text))
          .map((token) => token.text),
      ),
    ].slice(0, PREFETCH_WORD_LIMIT);
    let alive = true;
    Promise.all(
      terms.map((term) =>
        requestLookup(term, region, "low")
          .then((data) => (data.term || term).trim())
          .catch(() => ""),
      ),
    ).then((resolved) => {
      if (!alive) return;
      void refreshStatsRef.current();
      const similarTerms = [...new Set(resolved.filter(Boolean))];
      Promise.all(
        similarTerms.map((term) => requestSimilar(term, region.source, "low").catch(() => undefined)),
      ).then(() => {
        if (alive) void refreshStatsRef.current();
      });
    });
    return () => {
      alive = false;
      queue.dropPendingLow();
    };
  }, [performanceMode, activeRegion, sourceLang, requestLookup, requestSimilar]);

  // Word/idiom lookup always uses the selected region, never the whole page.
  useEffect(() => {
    if (panelMode !== "word" || !activeTerm.trim() || !activeRegion || !translation) return;
    const region = activeRegion;
    let cancelled = false;
    setWordLoading(true);
    setWordError("");
    setWordDetail(null);
    setSimilarList(null);
    setSimilarError("");
    const term = activeTerm.trim();
    requestLookup(term, region, "high")
      .then((data) => {
        // The tapped term's similar expressions also jump the queue.
        if (performanceMode === "response") {
          requestSimilar((data.term || term).trim(), region.source, "high").catch(() => undefined);
        }
        if (!cancelled) {
          setWordDetail(data);
          void refreshStats();
        }
      })
      .catch((err) => {
        if (!cancelled) setWordError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setWordLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    panelMode,
    activeTerm,
    activeRegion,
    translation,
    performanceMode,
    requestLookup,
    requestSimilar,
    refreshStats,
    lookupNonce,
  ]);

  // Explanation and chat are mutually exclusive with word details. A stored
  // answer replaces the explanation, but the full conversation stays internal.
  useEffect(() => {
    if (panelMode !== "ai" || !activeRegion || !translation) return;
    if (latestAnswer) {
      setExplainLoading(false);
      setExplainError("");
      return;
    }
    const region = activeRegion;
    let cancelled = false;
    setExplainLoading(true);
    setExplainError("");
    setExplainPoints([]);
    api<ExplainResponse>("/api/translate/explain", {
      method: "POST",
      body: {
        sourceText: region.source,
        translatedText: region.translation,
        sourceLang,
        targetLang,
        learnerLevel,
      },
      timeoutMs: 60_000,
    })
      .then((data) => {
        if (!cancelled) {
          setExplainPoints(data.points);
          void refreshStats();
        }
      })
      .catch((err) => {
        if (!cancelled) setExplainError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setExplainLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    panelMode,
    activeRegion,
    translation,
    latestAnswer,
    learnerLevel,
    sourceLang,
    targetLang,
    refreshStats,
  ]);

  function openRegion(region: TranslationRegion) {
    stopCloudTts();
    window.getSelection()?.removeAllRanges();
    setActiveRegion(region);
    setQuestionRange(null);
    setPanelMode("none");
    setActiveTerm("");
    setChosenSpan(null);
    setWordDetail(null);
    setWordError("");
    setWordLoading(false);
    setSimilarList(null);
    setSimilarError("");
    setSimilarLoading(false);
    setExplainPoints([]);
    setExplainError("");
    setExplainLoading(false);
    setQuestionInput("");
    setChatError("");
  }

  function resetWordPanel(term: string, span: Span | null) {
    setPanelMode("word");
    setQuestionRange(null);
    setActiveTerm(term);
    setChosenSpan(span);
    setWordDetail(null);
    setWordError("");
    setWordLoading(true);
    setSimilarList(null);
    setSimilarError("");
    setLookupNonce((value) => value + 1);
  }

  function handleTokenClick(token: Token) {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    resetWordPanel(token.text, { start: token.start, end: token.end });
  }

  function selectPhrase(term: string) {
    const trimmed = term.trim();
    if (!trimmed) return;
    const source = activeRegion?.source ?? "";
    const index = source.toLowerCase().indexOf(trimmed.toLowerCase());
    resetWordPanel(
      trimmed,
      index >= 0 ? { start: index, end: index + trimmed.length } : null,
    );
  }

  function toggleAiPanel() {
    if (panelMode === "ai") {
      setPanelMode("none");
      return;
    }
    setPanelMode("ai");
    setActiveTerm("");
    setChosenSpan(null);
    setWordDetail(null);
    setWordError("");
    setSimilarList(null);
    setSimilarError("");
  }

  const similarTerm = (wordDetail?.term || activeTerm).trim();

  async function loadSimilar() {
    if (!translation || !activeRegion) return;
    const term = similarTerm;
    if (!term) return;
    setSimilarLoading(true);
    setSimilarError("");
    try {
      const data = await requestSimilar(term, activeRegion.source, "high");
      setSimilarList(data.expressions);
      void refreshStats();
    } catch (err) {
      setSimilarError(errorMessage(err));
    } finally {
      setSimilarLoading(false);
    }
  }

  async function saveSelectedWord() {
    if (!translation || !activeRegion || !activeTerm.trim() || savingWord) return;
    const termToSave = (wordDetail?.term || activeTerm).trim();
    if (!canSaveTerm) {
      toast("文の範囲は質問に引用できます。登録は単語か確認済みの熟語を選んでください。", "info");
      return;
    }
    if (!wordMeaning.trim()) {
      toast("意味を取得してから登録してください。", "error");
      return;
    }

    setSavingWord(true);
    try {
      await api<{ word: WordCard }>("/api/words", {
        method: "POST",
        body: {
          term: termToSave,
          baseForm: wordDetail?.baseForm || termToSave,
          partOfSpeech: wordDetail?.partOfSpeech || "",
          meaning: wordMeaning.trim(),
          contextMeaning: wordDetail?.contextMeaning || wordMeaning.trim(),
          sourceText: activeRegion.source,
          translatedText: activeRegion.translation,
          grammarNote: wordDetail?.note || "",
          sourceLang,
          targetLang,
          origin: "translation",
          translationId: translation?.id ?? id ?? null,
          existingImageKey: translation.imageKey ?? null,
        },
      });
      setSavedTerms((previous) => new Set(previous).add(normalizeTerm(termToSave)));
      void refreshStats();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setSavingWord(false);
    }
  }

  async function submitQuestion() {
    if (!translation || !activeRegion || chatLoading) return;
    const question = questionInput.trim();
    if (!question) return;
    const region = activeRegion;
    let range = questionRange;
    if (!range) {
      range =
        selectionWithin(sourceRef.current, region.source, "source") ??
        selectionWithin(translationRef.current, region.translation, "translation");
      if (range) setQuestionRange(range);
    }
    const history = (chatsByRegion[region.id]?.history ?? []).slice(-6);
    setPendingChats(current => new Set(current).add(region.id));
    setChatError("");
    try {
      const data = await api<ChatResponse>("/api/translate/chat", {
        method: "POST",
        body: {
          sourceText: region.source,
          translatedText: region.translation,
          sourceLang,
          targetLang,
          learnerLevel,
          question,
          selectedRange: range,
          history,
        },
        timeoutMs: 60_000,
      });
      setChatsByRegion((previous) => {
        const current = previous[region.id] ?? { history: [], latest: null };
        const nextHistory: ChatTurn[] = [
          ...current.history,
          { role: "user", content: question },
          { role: "assistant", content: data.answer },
        ];
        return {
          ...previous,
          [region.id]: {
            history: nextHistory,
            latest: {
              question,
              answer: data.answer,
              rangeText: range?.text,
            },
          },
        };
      });
      if (activeRegionRef.current?.id === region.id) {
        setQuestionInput("");
        setQuestionRange(null);
        window.getSelection()?.removeAllRanges();
      }
      void refreshStats();
    } catch (err) {
      if (activeRegionRef.current?.id === region.id) {
        setChatError(errorMessage(err));
      }
    } finally {
      setPendingChats(current => { const next = new Set(current); next.delete(region.id); return next; });
    }
  }

  function clearQuestionRange() {
    setQuestionRange(null);
    window.getSelection()?.removeAllRanges();
  }

  if (loading) {
    return (
      <div className="tv-result tv-state" style={shellStyle}>
        <Loader2 className="spin" size={24} aria-hidden="true" />
        <p>翻訳を読み込んでいます…</p>
      </div>
    );
  }

  if (error || !translation) {
    return (
      <div className="tv-result tv-state" style={shellStyle}>
        <div className="tv-state-card">
          <p className="tv-state-error">{error || "翻訳が見つかりません。"}</p>
          <Link to="/" className="btn btn-primary">
            <ArrowLeft size={16} /> カメラへ戻る
          </Link>
        </div>
      </div>
    );
  }

  const imageUrl =
    fileImageUrl ??
    localImageUrl ??
    (translation.imageKey ? `/api/images/${translation.imageKey}` : null);
  const tokens = activeRegion ? tokenize(activeRegion.source, sourceLang) : [];

  return (
    <div
      ref={rootRef}
      className={`tv-result${activeRegion ? " has-card" : ""}`}
      style={shellStyle}
    >
      <div className="tv-stage">
        {imageUrl ? (
          <TranslationImage
            key={imageUrl}
            src={imageUrl}
            regions={regions}
            activeId={activeRegion?.id ?? null}
            showOriginal={showOriginal}
            onSelect={openRegion}
          />
        ) : (
          <div className="tv-image-missing" role="status">
            <p>この翻訳には画像が保存されていません。</p>
          </div>
        )}
      </div>

      <header className="tv-topbar">
        <span className="tv-lang" aria-label="翻訳方向">
          <Languages size={13} aria-hidden="true" />
          {languageLabel(sourceLang)} → {languageLabel(targetLang)}
        </span>
        <div className="tv-top-actions">
          <button
            type="button"
            className="tv-top-btn"
            onClick={() => setShowOriginal((value) => !value)}
            aria-pressed={showOriginal}
            aria-label={showOriginal ? "訳を重ねる" : "原文を見る"}
            title={showOriginal ? "訳を重ねる" : "原文を見る"}
          >
            {showOriginal ? <EyeOff size={16} /> : <Eye size={16} />}
            <span>{showOriginal ? "訳を表示" : "原文を見る"}</span>
          </button>
          <button
            type="button"
            className="tv-top-btn"
            onClick={() => setUsageOpen(true)}
            aria-label="AI枠の利用状況を開く"
            title={quotaLabel}
          >
            <Sparkles size={16} />
            <span>AI枠</span>
          </button>
          <button
            type="button"
            className="tv-close"
            onClick={goCamera}
            aria-label="カメラに戻る"
            title="カメラに戻る"
          >
            <X size={20} />
          </button>
        </div>
      </header>

      {!live && (!imageUrl || regions.length === 0) && !activeRegion ? (
        <button className="tv-legacy-reader btn btn-secondary" onClick={() => openRegion({id:"legacy-full-text",source:translation.sourceText,translation:translation.translatedText,x:0,y:0,width:1,height:1})}>
          原文と訳を読む
        </button>
      ) : null}

      {activeRegion ? (
        <section
          className={`tv-card${panelMode === "ai" ? " expanded" : ""}`}
          ref={cardRef}
          role="dialog"
          aria-label="選択した領域の原文と翻訳"
        >
          <div className="tv-card-scroll" ref={cardScrollRef}>
            <div className="tv-card-actions">
              <button
                type="button"
                onClick={() => void speak(activeRegion.source, sourceLang)}
                aria-label="英語を聴く"
                title="英語を聴く"
              >
                <Volume2 size={17} />
              </button>
              <button
                type="button"
                className="tv-ai-button quota-button"
                data-quota={quota.status}
                aria-expanded={panelMode === "ai"}
                aria-label="AI解説と質問"
                title={quotaLabel}
                onClick={toggleAiPanel}
              >
                <svg className="quota-ring" viewBox="0 0 26 26" aria-hidden="true">
                  <circle className="quota-track" cx="13" cy="13" r="11" />
                  <circle
                    className="quota-value"
                    cx="13"
                    cy="13"
                    r="11"
                    strokeDasharray="69"
                    strokeDashoffset={quota.used !== null ? ringOffset : 18}
                  />
                </svg>
                <Sparkles size={16} />
              </button>
              <button
                type="button"
                className="tv-card-close"
                onClick={goCamera}
                aria-label="カメラに戻る"
                title="カメラに戻る"
              >
                <X size={19} />
              </button>
            </div>

            {(activeRegion.originalSource && activeRegion.originalSource !== activeRegion.source || activeRegion.needsReview) && (
              <details className="tv-ocr-correction" key={activeRegion.id}>
                <summary>{activeRegion.needsReview ? "OCR要確認" : "OCR補正あり"}</summary>
                <p>読み取り原文</p>
                <p className="tv-ocr-original">{activeRegion.originalSource ?? activeRegion.source}</p>
                {activeRegion.needsReview && <p>読み取りが曖昧な箇所があります。画像と見比べ、必要なら近くから撮り直してください。</p>}
              </details>
            )}
            <p className="tv-source" ref={sourceRef}>
              {tokens.map((token, index) => {
                if (!token.isWord) return <span key={index}>{token.text}</span>;
                const chosen =
                  chosenSpan != null &&
                  token.start >= chosenSpan.start &&
                  token.end <= chosenSpan.end;
                return (
                  <span
                    key={index}
                    role="button"
                    tabIndex={0}
                    className="tv-token"
                    data-chosen={chosen ? "true" : "false"}
                    onClick={() => handleTokenClick(token)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleTokenClick(token);
                      }
                    }}
                  >
                    {token.text}
                  </span>
                );
              })}
            </p>

            <p className="tv-translation" ref={translationRef}>
              {activeRegion.translation}
            </p>

            {panelMode === "word" ? (
              <div className="tv-word" role="region" aria-label="選択した語句の意味と登録">
                <div className="tv-word-line">
                  <strong>{wordDetail?.term || activeTerm}</strong>
                  <span className="tv-word-meaning">
                    {wordLoading ? (
                      <span className="muted">意味を取得中…</span>
                    ) : wordError ? (
                      <span className="tv-inline-error">{wordError}</span>
                    ) : (
                      wordMeaning || "—"
                    )}
                  </span>
                  <button
                    type="button"
                    className="tv-similar-trigger"
                    onClick={() => void loadSimilar()}
                    disabled={similarLoading || wordLoading}
                  >
                    {similarLoading ? "取得中…" : "似た表現"}
                  </button>
                  <button
                    type="button"
                    className="tv-save-word"
                    onClick={() => void saveSelectedWord()}
                    disabled={savingWord || wordLoading || isCurrentTermSaved || !canSaveTerm}
                    aria-label={isCurrentTermSaved ? "単語帳に保存済み" : "単語帳に追加"}
                    title={
                      !canSaveTerm
                        ? "単語か確認済みの熟語を選ぶと登録できます"
                        : isCurrentTermSaved
                          ? "単語帳に保存済み"
                          : "単語帳に追加"
                    }
                  >
                    {savingWord ? (
                      <Loader2 size={13} className="spin" />
                    ) : isCurrentTermSaved ? (
                      <Check size={14} />
                    ) : (
                      <Plus size={15} />
                    )}
                  </button>
                </div>

                {relatedPhrases.length ? (
                  <div className="tv-related-phrases" aria-label="確認済みの熟語">
                    {relatedPhrases.map((phrase) => (
                      <button
                        key={phrase.term}
                        type="button"
                        onClick={() => selectPhrase(phrase.term)}
                      >
                        {phrase.term}
                      </button>
                    ))}
                  </div>
                ) : null}

                {similarError ? (
                  <p className="tv-inline-error" role="alert">
                    {similarError}
                  </p>
                ) : null}

                {similarList ? (
                  <div id="similarResults" aria-label="似た表現と使い分け">
                    {similarList.length ? (
                      similarList.map((item) => (
                        <div key={item.term} className="tv-similar-item">
                          <div className="between">
                            <strong>{item.term}</strong>
                            <button
                              type="button"
                              className="tv-similar-trigger"
                              onClick={() => selectPhrase(item.term)}
                            >
                              調べる
                            </button>
                          </div>
                          <p>{item.meaning}</p>
                          <p className="muted">{item.difference}</p>
                        </div>
                      ))
                    ) : (
                      <p className="tv-muted">似た表現が見つかりませんでした。</p>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}

            {panelMode === "ai" ? (
              <div className="tv-ai" role="region" aria-label="AI解説と質問">
                <div className="tv-ai-head">
                  <span>{latestAnswer ? "最新の回答" : "レベル別解説"}</span>
                  <label className="tv-level">
                    <span>解説レベル</span>
                    <select
                      value={learnerLevel}
                      onChange={(event) => setLearnerLevel(event.target.value as LearnerLevel)}
                      aria-label="解説レベル"
                    >
                      {LEARNER_LEVELS.map((level) => (
                        <option key={level.value} value={level.value}>
                          {level.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {chatError ? (
                  <p className="tv-inline-error" role="alert">
                    {chatError}
                  </p>
                ) : null}

                {chatLoading ? (
                  <p className="tv-ai-loading">
                    <Loader2 size={13} className="spin" aria-hidden="true" /> 回答を生成しています…
                  </p>
                ) : latestAnswer ? (
                  <p className="tv-answer">{latestAnswer}</p>
                ) : explainLoading ? (
                  <p className="tv-ai-loading">
                    <Loader2 size={13} className="spin" aria-hidden="true" /> 解説を生成しています…
                  </p>
                ) : explainError ? (
                  <p className="tv-inline-error" role="alert">
                    {explainError}
                  </p>
                ) : explainPoints.length ? (
                  <div className="tv-explanation">
                    <small>
                      {LEARNER_LEVELS.find((level) => level.value === learnerLevel)?.label} 向けの要点
                    </small>
                    {explainPoints.map((point, index) => (
                      <p key={index}>・{point}</p>
                    ))}
                  </div>
                ) : (
                  <p className="tv-muted">解説を取得できませんでした。</p>
                )}
              </div>
            ) : null}
          </div>

          {panelMode === "ai" ? (
            <div className="tv-composer">
              {questionRange ? (
                <div className="tv-range-context">
                  <span>対象箇所: 「{questionRange.text}」</span>
                  <button
                    type="button"
                    onClick={clearQuestionRange}
                    aria-label="対象箇所を解除"
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : null}
              <form
                className="tv-chat-entry"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitQuestion();
                }}
              >
                <input
                  value={questionInput}
                  onChange={(event) => setQuestionInput(event.target.value)}
                  placeholder="この文について質問する…"
                  aria-label="この文について質問する"
                  maxLength={1000}
                />
                <button
                  type="submit"
                  className="tv-send"
                  disabled={chatLoading || !questionInput.trim()}
                  aria-label="質問を送信"
                >
                  {chatLoading ? (
                    <Loader2 size={13} className="spin" />
                  ) : (
                    <Send size={13} />
                  )}
                </button>
              </form>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
