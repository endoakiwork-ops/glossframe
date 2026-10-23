import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  BookPlus,
  Check,
  Layers3,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import {
  LEARNER_LEVELS,
  type AiQuizExample,
  type AiQuizExamplesResponse,
  type AiQuizPlanResponse,
  type ClozeOptionSet,
  type LearnerLevel,
  type ReviewMode,
  type ReviewQueueItem,
  type ReviewResult,
  type WordCard,
} from "../../shared/types";
import {
  findTermRanges,
  highlightSegments,
  maskSentence,
  normalizeTerm,
} from "../../shared/srs";
import { api, errorMessage } from "../lib/api";
import { prefetchCloudTts } from "../lib/audio";
import {
  loadPausedSessions,
  loadRecentAiTerms,
  rememberAiTerms,
  modeLabel,
  removePausedSession,
  savePausedSession,
  type PausedReviewSession,
  type ReviewAnswerRecord,
  type ReviewSessionQuestion,
} from "../lib/reviewSessions";
import { useApp } from "../context/AppContext";
import { EmptyState } from "../components/EmptyState";
import { ImageZoomModal } from "../components/ImageZoomModal";

type PlanItem = AiQuizPlanResponse["items"][number];

/**
 * Builds an AI question from a planned word. Word ↔ meaning modes need only
 * the plan; cloze also needs the verified example sentence and its choices.
 */
function questionFromPlan(item: PlanItem, mode: ReviewMode, example?: AiQuizExample): ReviewSessionQuestion {
  const options = [{ term: item.term, meaning: item.meaning }, ...item.distractors];
  let choices: string[];
  let correctChoice: string;
  const choiceNotes: Record<string, string> = {};
  if (mode === "card") {
    choices = options.map((o) => o.meaning);
    correctChoice = item.meaning;
    for (const o of options) choiceNotes[o.meaning] = o.term;
  } else if (mode === "recall") {
    choices = options.map((o) => o.term);
    correctChoice = item.term;
    for (const o of options) choiceNotes[o.term] = o.meaning;
  } else {
    choices = example?.choices ?? [];
    correctChoice = example?.surface ?? item.term;
    // Cloze choices are inflected; match each back to its word by stem.
    for (const choice of choices) {
      const stem = normalizeTerm(choice).slice(0, 4);
      const match =
        normalizeTerm(choice) === normalizeTerm(correctChoice)
          ? options[0]
          : options.find((o) => normalizeTerm(o.term).startsWith(stem));
      if (match) choiceNotes[choice] = match.meaning;
    }
  }
  return {
    id: item.id,
    wordId: null,
    term: item.term,
    surface: example?.surface ?? item.term,
    meaning: item.meaning,
    partOfSpeech: item.partOfSpeech,
    sourceText: example?.source ?? "",
    translatedText: example?.translation ?? "",
    note: "",
    imageKey: null,
    choices: shuffleArray(choices),
    correctChoice,
    choiceNotes,
    distractors: item.distractors,
  };
}

function planItemOf(question: ReviewSessionQuestion): PlanItem {
  return {
    id: question.id,
    term: question.term,
    meaning: question.meaning,
    partOfSpeech: question.partOfSpeech,
    distractors: question.distractors ?? [],
  };
}

function shuffleArray<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildFallbackChoices(
  correct: string,
  pool: string[],
  fallbackDefaults: string[],
): string[] {
  const unique: string[] = [correct];
  const seen = new Set<string>([normalizeTerm(correct)]);
  for (const candidate of [...shuffleArray(pool), ...fallbackDefaults]) {
    const trimmed = candidate.trim();
    const norm = normalizeTerm(trimmed);
    if (trimmed && norm && !seen.has(norm)) {
      seen.add(norm);
      unique.push(trimmed);
    }
    if (unique.length >= 4) break;
  }
  return shuffleArray(unique);
}

function HighlightedExample({ text, term }: { text: string; term: string }) {
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

export function ReviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    settings,
    stats,
    toast,
    refreshStats,
    learnerLevel,
    setLearnerLevel,
    performanceMode,
    speak,
  } = useApp();

  const initialSource = searchParams.get("source") === "ai" ? "ai" : "wordbook";
  const [stage, setStage] = useState<"setup" | "active" | "summary">("setup");
  const [source, setSource] = useState<"wordbook" | "ai">(initialSource);
  const [mode, setMode] = useState<ReviewMode>(initialSource === "ai" ? "cloze" : "card");
  const [count, setCount] = useState<5 | 10>(5);
  const [scope, setScope] = useState<"due" | "all">("due");
  const [pausedSessions, setPausedSessions] = useState<PausedReviewSession[]>(() =>
    loadPausedSessions(),
  );
  const [activeSession, setActiveSession] = useState<PausedReviewSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [useChoicesInWordbook, setUseChoicesInWordbook] = useState(true);
  const [selfRevealed, setSelfRevealed] = useState(false);
  const [zoomImageUrl, setZoomImageUrl] = useState<string | null>(null);
  const [savedAiTerms, setSavedAiTerms] = useState<Set<string>>(new Set());
  const [savingAiTerm, setSavingAiTerm] = useState<string | null>(null);
  /** Background AI requests still running, per session id. */
  const [aiPending, setAiPending] = useState<Record<string, number>>({});
  const [exampleLoading, setExampleLoading] = useState<Set<string>>(new Set());
  const [exampleFailed, setExampleFailed] = useState<Set<string>>(new Set());

  // Sync URL ?resume= or ?source=ai on mount
  useEffect(() => {
    const resumeId = searchParams.get("resume");
    if (resumeId) {
      const found = loadPausedSessions().find((s) => s.id === resumeId);
      if (found) {
        setActiveSession(found);
        setSource(found.source);
        setMode(found.mode);
        setCount(found.count);
        setScope(found.scope);
        setSelfRevealed(false);
        setStage("active");
      }
      setSearchParams({}, { replace: true });
      return;
    }
    if (searchParams.get("source") === "ai") {
      setSource("ai");
              setMode("cloze");
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if ((stats?.dueWords ?? 0) === 0 && (stats?.words ?? 0) > 0) {
      setScope("all");
    }
  }, [stats?.dueWords, stats?.words]);

  const currentQuestion = useMemo<ReviewSessionQuestion | null>(() => {
    if (!activeSession) return null;
    return activeSession.questions[activeSession.index] ?? null;
  }, [activeSession]);

  const currentAnswer = useMemo<ReviewAnswerRecord | null>(() => {
    if (!activeSession || !currentQuestion) return null;
    return (
      activeSession.answers.find((a) => a.questionId === currentQuestion.id) ?? null
    );
  }, [activeSession, currentQuestion]);

  // Only cloze appends questions later; example sentences never block "next".
  const waitingForMore =
    Boolean(activeSession) &&
    activeSession!.mode === "cloze" &&
    activeSession!.questions.length < activeSession!.count &&
    (aiPending[activeSession!.id] ?? 0) > 0;
  const isLastLoaded = Boolean(activeSession) && activeSession!.index + 1 >= activeSession!.questions.length;

  // Response mode synthesizes the audio before it is tapped.
  useEffect(() => {
    if (performanceMode !== "response" || !currentQuestion) return;
    const lang = settings?.sourceLang ?? "en";
    prefetchCloudTts(currentQuestion.term, lang);
    if (currentQuestion.sourceText) prefetchCloudTts(currentQuestion.sourceText, lang);
  }, [performanceMode, currentQuestion?.term, currentQuestion?.sourceText, settings?.sourceLang]);

  const startWordbookSession = useCallback(async () => {
    setStarting(true);
    setStartError("");
    try {
      let data = await api<{ items: ReviewQueueItem[] }>(
        `/api/review/queue?limit=60&scope=${scope}`,
      );
      if (data.items.length === 0 && scope === "due") {
        data = await api<{ items: ReviewQueueItem[] }>(
          `/api/review/queue?limit=60&scope=all`,
        );
        if (data.items.length > 0) setScope("all");
      }
      if (data.items.length === 0) {
        setStartError("単語帳にまだ単語がありません。先に翻訳画面や単語帳から単語を登録してください。");
        return;
      }

      let eligible = data.items;
      if (mode === "cloze") {
        const withSentence = data.items.filter((item) =>
          findTermRanges(item.example?.sourceText ?? item.word.exampleSource ?? "", item.word.term).length === 1,
        );
        if (withSentence.length === 0) {
          setStartError(
            "文脈穴埋めモードには例文付きの単語が必要です。「単語 → 意味」または「日本語 → 英語」を選ぶか、単語に例文を追加してください。",
          );
          return;
        }
        eligible = withSentence;
      }

      let selectedItems = eligible.slice(0, count);
      let clozeMap: Record<string, ClozeOptionSet> = {};
      if (mode === "cloze") {
        try {
          const clozeRes = await api<{ items: Record<string, ClozeOptionSet> }>(
            "/api/review/cloze",
            {
              method: "POST",
              body: {
                wordIds: selectedItems.map((i) => i.word.id),
                learnerLevel,
              },
              timeoutMs: 45_000,
            },
          );
          clozeMap = clozeRes.items ?? {};
        } catch (error) {
          throw error;
        }
        selectedItems = selectedItems.filter(item => clozeMap[item.word.id]?.choices.length === 4);
        if (!selectedItems.length) throw new Error("有効な穴埋め問題を作成できませんでした。例文を確認するか、別の出題形式を選んでください。");
      }

      const allMeanings = data.items.map((i) => i.word.meaning).filter(Boolean);
      const allTerms = data.items.map((i) => i.word.term).filter(Boolean);

      const questions: ReviewSessionQuestion[] = selectedItems.map((item, idx) => {
        const w = item.word;
        const ex = item.example;
        const sourceText = (ex?.sourceText ?? w.exampleSource ?? "").trim();
        const translatedText = (ex?.translatedText ?? w.exampleTranslation ?? "").trim();
        const note = (ex?.grammarNote ?? w.exampleGrammarNote ?? ex?.contextMeaning ?? "").trim();
        const ranges = sourceText ? findTermRanges(sourceText, w.term) : [];
        const surface = ranges.length
          ? sourceText.slice(ranges[0].start, ranges[0].end)
          : w.term;

        let choices: string[] = [];
        let correctChoice = w.meaning;

        if (mode === "card") {
          correctChoice = w.meaning;
          choices = buildFallbackChoices(w.meaning, allMeanings, [
            "一時的に保留する",
            "徐々に変化させる",
            "明確に区別する",
            "慎重に検討する",
          ]);
        } else if (mode === "cloze") {
          const aiCloze = clozeMap[w.id];
          correctChoice = aiCloze?.surface || surface;
          if (aiCloze && aiCloze.choices.length === 4) {
            choices = shuffleArray(aiCloze.choices);
          } else {
            choices = buildFallbackChoices(correctChoice, allTerms, [
              "maintain",
              "consider",
              "establish",
              "preserve",
            ]);
          }
        } else {
          // recall: Japanese -> English
          correctChoice = w.term;
          choices = buildFallbackChoices(w.term, allTerms, [
            "maintain",
            "consider",
            "establish",
            "preserve",
          ]);
        }

        return {
          id: `wb-${w.id}-${idx}`,
          wordId: w.id,
          term: w.term,
          surface,
          meaning: w.meaning,
          partOfSpeech: w.partOfSpeech ?? "",
          sourceText,
          translatedText,
          note,
          imageKey: ex?.imageKey ?? w.imageKey ?? null,
          choices,
          correctChoice,
        };
      });

      const session: PausedReviewSession = {
        id: `session-${Date.now()}`,
        source: "wordbook",
        mode,
        count,
        scope,
        questions,
        index: 0,
        answers: [],
        retriedIds: [],
        isRetryRound: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const nextList = savePausedSession(session);
      setPausedSessions(nextList);
      setActiveSession(session);
      setSelfRevealed(false);
      setStage("active");
    } catch (err) {
      setStartError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  }, [scope, mode, count, learnerLevel]);

  // Keeps background AI results attached to the session they were started for.
  const activeSessionRef = useRef<PausedReviewSession | null>(null);
  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  const patchSession = useCallback(
    (sessionId: string, update: (session: PausedReviewSession) => PausedReviewSession) => {
      const current = activeSessionRef.current;
      // A finished or discarded session must not be resurrected by a late result.
      if (!current || current.id !== sessionId) return;
      if (!loadPausedSessions().some((s) => s.id === sessionId)) return;
      const next = update(current);
      activeSessionRef.current = next;
      setActiveSession(next);
      setPausedSessions(savePausedSession(next));
    },
    [],
  );

  const fetchExamples = useCallback(
    (items: PlanItem[], examplesMode: ReviewMode) =>
      api<AiQuizExamplesResponse>("/api/review/ai-examples", {
        method: "POST",
        body: {
          mode: examplesMode,
          learnerLevel,
          items: items.map((item) => ({
            id: item.id,
            term: item.term,
            meaning: item.meaning,
            distractors: item.distractors.map((d) => d.term),
          })),
        },
        timeoutMs: 60_000,
      }).then((res) => res.items),
    [learnerLevel],
  );

  const attachExamples = useCallback(
    (sessionId: string, examples: AiQuizExample[]) => {
      if (!examples.length) return;
      patchSession(sessionId, (session) => ({
        ...session,
        questions: session.questions.map((q) => {
          const example = examples.find((e) => e.id === q.id);
          return example
            ? { ...q, surface: example.surface, sourceText: example.source, translatedText: example.translation }
            : q;
        }),
      }));
    },
    [patchSession],
  );

  /** Retries one example when its background chunk failed or skipped it. */
  const loadExample = useCallback(
    async (question: ReviewSessionQuestion) => {
      const session = activeSessionRef.current;
      if (!session || !question.distractors || exampleLoading.has(question.id)) return;
      setExampleLoading((prev) => new Set(prev).add(question.id));
      try {
        const examples = await fetchExamples([planItemOf(question)], "card");
        if (!examples.length) setExampleFailed((prev) => new Set(prev).add(question.id));
        attachExamples(session.id, examples);
      } catch {
        setExampleFailed((prev) => new Set(prev).add(question.id));
      } finally {
        setExampleLoading((prev) => {
          const next = new Set(prev);
          next.delete(question.id);
          return next;
        });
      }
    },
    [attachExamples, fetchExamples, exampleLoading],
  );

  // When the answer is shown and its background example never arrived, fetch
  // that one example automatically; it appears as soon as it is ready.
  const examplePendingForSession = activeSession ? (aiPending[activeSession.id] ?? 0) : 0;
  useEffect(() => {
    if (!currentAnswer || !currentQuestion?.distractors || currentQuestion.sourceText) return;
    if (examplePendingForSession > 0 || exampleFailed.has(currentQuestion.id)) return;
    void loadExample(currentQuestion);
  }, [currentAnswer, currentQuestion, examplePendingForSession, exampleFailed, loadExample]);

  const startAiSession = useCallback(async () => {
    setStarting(true);
    setStartError("");
    try {
      // Recently quizzed words first: the server shows the newest ones to the model.
      const excludeTerms = [
        ...new Set([
          ...loadRecentAiTerms(),
          ...pausedSessions.filter((s) => s.source === "ai").flatMap((s) => s.questions.map((q) => q.term)),
        ]),
      ].slice(0, 200);

      const plan = await api<AiQuizPlanResponse>("/api/review/ai-plan", {
        method: "POST",
        body: { count, mode, learnerLevel, excludeTerms },
        timeoutMs: 60_000,
      });
      const stamp = Date.now();
      const sessionId = `ai-session-${stamp}`;
      const items: PlanItem[] = plan.items.map((item, idx) => ({ ...item, id: `ai-${stamp}-${idx}` }));
      rememberAiTerms(items.map((item) => item.term));

      const begin = (questions: ReviewSessionQuestion[]) => {
        const session: PausedReviewSession = {
          id: sessionId,
          source: "ai",
          mode,
          count,
          scope: "all",
          questions,
          index: 0,
          answers: [],
          retriedIds: [],
          isRetryRound: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        activeSessionRef.current = session;
        setPausedSessions(savePausedSession(session));
        setActiveSession(session);
        setSelfRevealed(false);
        setStage("active");
      };

      const chunks: PlanItem[][] = [];
      for (let i = 0; i < items.length; i += 2) chunks.push(items.slice(i, i + 2));
      const trackChunk = (delta: number) =>
        setAiPending((prev) => ({ ...prev, [sessionId]: Math.max(0, (prev[sessionId] ?? 0) + delta) }));

      if (mode !== "cloze") {
        // Word ↔ meaning questions need no sentence, so the session starts now.
        begin(items.map((item) => questionFromPlan(item, mode)));
        // Examples are written in the background while the learner answers.
        for (const chunk of chunks) {
          trackChunk(1);
          fetchExamples(chunk, mode)
            .then((examples) => attachExamples(sessionId, examples))
            .catch(() => undefined)
            .finally(() => trackChunk(-1));
        }
      } else {
        // Cloze needs sentences: start on the first verified chunk, append the rest.
        await new Promise<void>((resolve, reject) => {
          let started = false;
          let remaining = chunks.length;
          trackChunk(chunks.length);
          for (const chunk of chunks) {
            fetchExamples(chunk, "cloze")
              .then((examples) => {
                const questions = examples.flatMap((example) => {
                  const item = chunk.find((entry) => entry.id === example.id);
                  return item ? [questionFromPlan(item, "cloze", example)] : [];
                });
                if (!questions.length) return;
                if (!started) {
                  started = true;
                  begin(questions.slice(0, count));
                  resolve();
                } else {
                  patchSession(sessionId, (session) => ({
                    ...session,
                    questions: [...session.questions, ...questions].slice(0, count),
                  }));
                }
              })
              .catch(() => undefined)
              .finally(() => {
                remaining -= 1;
                trackChunk(-1);
                if (remaining === 0 && !started) {
                  reject(new Error("穴埋め問題を作れませんでした。もう一度お試しください。"));
                }
              });
          }
        });
      }
      void refreshStats();
    } catch (err) {
      // Never destroy existing sessions when AI generation fails or is disconnected
      setStartError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  }, [count, mode, learnerLevel, pausedSessions, refreshStats, fetchExamples, attachExamples, patchSession]);

  const recordAnswer = useCallback(
    (params: {
      correct: boolean;
      chosen: string;
      assisted: boolean;
    }) => {
      if (!activeSession || !currentQuestion || currentAnswer) return;

      const isRetry =
        activeSession.isRetryRound ||
        activeSession.retriedIds.includes(currentQuestion.id);

      // Show the result immediately; the server only decides the count bonus.
      const answerRecord: ReviewAnswerRecord = {
        questionId: currentQuestion.id,
        correct: params.correct,
        chosen: params.chosen,
        assisted: params.assisted,
        gained: false,
        sameDaySkipped: false,
      };
      const updatedSession: PausedReviewSession = {
        ...activeSession,
        answers: [...activeSession.answers, answerRecord],
        updatedAt: Date.now(),
      };
      activeSessionRef.current = updatedSession;
      setActiveSession(updatedSession);
      setPausedSessions(savePausedSession(updatedSession));

      if (activeSession.source !== "wordbook" || !currentQuestion.wordId) return;
      const sessionId = activeSession.id;
      const questionId = currentQuestion.id;
      void api<ReviewResult>(`/api/words/${currentQuestion.wordId}/review`, {
        method: "POST",
        body: {
          rating: params.correct ? "known" : "unknown",
          mode: activeSession.mode,
          assisted: params.assisted,
          retry: isRetry,
          requestId: `${sessionId}:${questionId}:${isRetry ? "retry" : "first"}`,
        },
      })
        .then((res) => {
          void refreshStats();
          if (!res.gained && !res.sameDaySkipped) return;
          const current = activeSessionRef.current;
          // The session may already be on the summary screen; still update its tally.
          if (!current || current.id !== sessionId) return;
          const target = current.answers.findLastIndex((a) => a.questionId === questionId);
          if (target < 0) return;
          const answers = current.answers.map((a, i) =>
            i === target ? { ...a, gained: Boolean(res.gained), sameDaySkipped: Boolean(res.sameDaySkipped) } : a,
          );
          const next = { ...current, answers };
          activeSessionRef.current = next;
          setActiveSession(next);
          if (loadPausedSessions().some((s) => s.id === sessionId)) {
            setPausedSessions(savePausedSession(next));
          }
        })
        .catch((err) => toast(errorMessage(err), "error"));
    },
    [activeSession, currentQuestion, currentAnswer, toast, refreshStats],
  );

  function goToNextQuestion() {
    if (!activeSession) return;
    const nextIndex = activeSession.index + 1;
    // Cloze questions still being generated will be appended; wait for them.
    if (nextIndex >= activeSession.questions.length && waitingForMore) return;
    setSelfRevealed(false);
    if (nextIndex >= activeSession.questions.length) {
      const remaining = removePausedSession(activeSession.id);
      setPausedSessions(remaining);
      setStage("summary");
      void refreshStats();
      return;
    }
    const updated: PausedReviewSession = {
      ...activeSession,
      index: nextIndex,
      updatedAt: Date.now(),
    };
    setActiveSession(updated);
    setPausedSessions(savePausedSession(updated));
  }

  function pauseCurrentSession() {
    if (!activeSession) {
      setStage("setup");
      return;
    }
    const next = savePausedSession(activeSession);
    setPausedSessions(next);
    setStage("setup");
  }

  function resumeSession(session: PausedReviewSession) {
    setActiveSession(session);
    setSource(session.source);
    setMode(session.mode);
    setCount(session.count);
    setScope(session.scope);
    setSelfRevealed(false);
    setStartError("");
    setStage("active");
  }

  function discardPausedSession(id: string, event: React.MouseEvent) {
    event.stopPropagation();
    const next = removePausedSession(id);
    setPausedSessions(next);
    if (activeSession?.id === id) {
      setActiveSession(null);
    }
  }

  function startRetryIncorrect() {
    if (!activeSession) return;
    const wrongIds = new Set(
      activeSession.answers.filter((a) => !a.correct).map((a) => a.questionId),
    );
    const wrongQuestions = activeSession.questions.filter((q) => wrongIds.has(q.id));
    if (!wrongQuestions.length) return;

    const retrySession: PausedReviewSession = {
      ...activeSession,
      id: `${activeSession.id}-retry-${Date.now()}`,
      questions: wrongQuestions.map((q) => ({
        ...q,
        choices: shuffleArray(q.choices),
      })),
      index: 0,
      answers: [],
      retriedIds: [
        ...new Set([...activeSession.retriedIds, ...wrongQuestions.map((q) => q.id)]),
      ],
      isRetryRound: true,
      updatedAt: Date.now(),
    };
    const next = savePausedSession(retrySession);
    setPausedSessions(next);
    setActiveSession(retrySession);
    setSelfRevealed(false);
    setStage("active");
  }

  async function saveAiQuestionToWordbook(q: ReviewSessionQuestion) {
    const norm = normalizeTerm(q.term);
    if (savedAiTerms.has(norm) || savingAiTerm === q.id) return;
    setSavingAiTerm(q.id);
    try {
      await api<{ word: WordCard }>("/api/words", {
        method: "POST",
        body: {
          term: q.term,
          baseForm: q.term,
          partOfSpeech: q.partOfSpeech,
          meaning: q.meaning,
          contextMeaning: q.meaning,
          sourceText: q.sourceText,
          translatedText: q.translatedText,
          grammarNote: q.note,
          sourceLang: settings?.sourceLang ?? "en",
          targetLang: settings?.targetLang ?? "ja",
          origin: "ai",
          image: null,
          existingImageKey: null,
        },
      });
      setSavedAiTerms((prev) => new Set(prev).add(norm));
      void refreshStats();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setSavingAiTerm(null);
    }
  }

  // ---------- Stage 1: Setup & Paused Sessions ----------
  if (stage === "setup") {
    return (
      <div className="stack fade-in">
        <div className="wb-segment" role="tablist" aria-label="出題元の切り替え">
          <button
            type="button"
            role="tab"
            aria-selected={source === "wordbook"}
            className={source === "wordbook" ? "selected" : ""}
            onClick={() => {
              setSource("wordbook");
              setStartError("");
            }}
          >
            単語帳の復習
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={source === "ai"}
            className={source === "ai" ? "selected" : ""}
            onClick={() => {
              setSource("ai");
              setStartError("");
            }}
          >
            AI出題（4択専用）
          </button>
        </div>

        {pausedSessions.length > 0 ? (
          <section className="stack-sm">
            <div className="label">中断中のセッション ({pausedSessions.length})</div>
            <div className="wb-paused-list">
              {pausedSessions.map((s) => (
                <div key={s.id} className="wb-paused-row">
                  <button
                    type="button"
                    className="paused-main-btn"
                    onClick={() => resumeSession(s)}
                  >
                    <div>
                      <b>
                        {s.source === "ai" ? "AI出題" : "単語帳"} · {modeLabel(s.mode)}
                      </b>
                      <small>
                        {s.index + 1} / {s.questions.length} 問目 · 正解{" "}
                        {s.answers.filter((a) => a.correct).length} 問
                      </small>
                    </div>
                    <span className="badge due">
                      <Play size={11} /> 再開
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    style={{ width: 30, height: 30, minHeight: 30 }}
                    onClick={(e) => discardPausedSession(s.id, e)}
                    aria-label="この中断セッションを破棄"
                    title="破棄"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="stack-sm">
          <div className="label">出題形式</div>
          <div className="wb-mode-list">
            <button
              type="button"
              className={`wb-mode${mode === "card" ? " selected" : ""}`}
              onClick={() => setMode("card")}
            >
              <span className="wb-mode-icon">A→あ</span>
              <span>
                <b>単語 → 意味</b>
                <small>英単語から日本語の意味を答えます（理解トラック）</small>
              </span>
            </button>

            <button
              type="button"
              className={`wb-mode${mode === "recall" ? " selected" : ""}`}
              onClick={() => setMode("recall")}
            >
              <span className="wb-mode-icon">あ→A</span>
              <span>
                <b>日本語 → 英語</b>
                <small>日本語の意味から英語表現を思い出します（想起トラック）</small>
              </span>
            </button>

            <button
              type="button"
              className={`wb-mode${mode === "cloze" ? " selected" : ""}`}
              onClick={() => setMode("cloze")}
            >
              <span className="wb-mode-icon">[ _ ]</span>
              <span>
                <b>文脈穴埋め</b>
                <small>例文の空欄に入る英単語・熟語を4択で選びます（理解トラック）</small>
              </span>
            </button>
          </div>
        </section>

        <div className="card card-pad stack-sm">
          <div className="between">
            <span className="label">問題数</span>
            <div className="wb-counts">
              {([5, 10] as const).map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`btn btn-sm ${count === n ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => setCount(n)}
                >
                  {n}問
                </button>
              ))}
            </div>
          </div>

          {source === "wordbook" ? (
            <div className="between" style={{ paddingTop: 6, borderTop: "1px solid var(--line)" }}>
              <span className="label">対象範囲</span>
              <div className="wb-counts">
                <button
                  type="button"
                  className={`btn btn-sm ${scope === "due" ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => setScope("due")}
                >
                  復習対象 ({stats?.dueWords ?? 0})
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${scope === "all" ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => setScope("all")}
                >
                  全登録語 ({stats?.words ?? 0})
                </button>
              </div>
            </div>
          ) : (
            <div className="between" style={{ paddingTop: 6, borderTop: "1px solid var(--line)" }}>
              <span className="label">出題レベル</span>
              <select
                className="select"
                style={{ width: 180, padding: "6px 28px 6px 10px", fontSize: 13 }}
                value={learnerLevel}
                onChange={(e) => setLearnerLevel(e.target.value as LearnerLevel)}
                aria-label="AI出題レベル"
              >
                {LEARNER_LEVELS.map((lvl) => (
                  <option key={lvl.value} value={lvl.value}>
                    {lvl.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {source === "ai" ? (
          <div className="wb-note">
            単語帳から最大10語を抽出した語彙プロファイルを基準に、未登録の語句で4択問題を生成します。
          </div>
        ) : (
          <div className="wb-note">
            理解（英→日・穴埋め）と想起（日→英）を別々に記録します。各トラックは日本時間で1日1回まで加算され、どちらかが設定回数に達すると習得済みになります。
          </div>
        )}

        {startError ? <div className="form-error">{startError}</div> : null}

        <button
          type="button"
          className="btn btn-primary btn-lg btn-block"
          disabled={starting}
          onClick={() =>
            void (source === "ai" ? startAiSession() : startWordbookSession())
          }
        >
          {starting ? (
            <Loader2 size={17} className="spin" />
          ) : source === "ai" ? (
            <Sparkles size={17} />
          ) : (
            <Layers3 size={17} />
          )}
          {starting
            ? source === "ai"
              ? "AI出題を生成・検証しています…"
              : "復習問題を準備しています…"
            : source === "ai"
              ? `AI出題を開始（${count}問・4択）`
              : `復習を開始（${count}問）`}
        </button>
      </div>
    );
  }

  // ---------- Stage 3: Summary ----------
  if (stage === "summary" && activeSession) {
    const total = activeSession.questions.length;
    const correctCount = activeSession.answers.filter((a) => a.correct).length;
    const wrongCount = total - correctCount;
    const gainedCount = activeSession.answers.filter((a) => a.gained).length;

    return (
      <div className="stack fade-in">
        <div className="card card-pad wb-result">
          <div className="wb-result-icon">
            <Check size={34} />
          </div>
          <h3>{activeSession.source === "ai" ? "AI出題 完了" : "復習セッション 完了"}</h3>
          <p>
            {modeLabel(activeSession.mode)} · 全{total}問
          </p>
          <div className="wb-result-score">
            {correctCount}
            <span> / {total}</span>
          </div>

          <div className="wb-result-stats">
            <div>
              <b>{correctCount}</b>
              <small>正解</small>
            </div>
            <div>
              <b>{wrongCount}</b>
              <small>要復習</small>
            </div>
            {activeSession.source === "wordbook" ? (
              <div>
                <b>+{gainedCount}</b>
                <small>{activeSession.mode === "recall" ? "想起カウント" : "理解カウント"}</small>
              </div>
            ) : null}
          </div>

          <div className="stack-sm" style={{ marginTop: 22 }}>
            {wrongCount > 0 ? (
              <button
                type="button"
                className="btn btn-primary btn-block"
                onClick={startRetryIncorrect}
              >
                <RotateCcw size={15} /> 間違えた {wrongCount} 問だけ解き直す（重複加算なし）
              </button>
            ) : null}
            <div className="row" style={{ justifyContent: "center" }}>
              <button
                type="button"
                className="btn btn-secondary grow"
                onClick={() => setStage("setup")}
              >
                設定に戻る
              </button>
              <Link to="/words" className="btn btn-secondary grow">
                単語帳へ
              </Link>
            </div>
          </div>
        </div>

        {activeSession.source === "ai" ? (
          <section className="card card-pad stack-sm">
            <div className="label">出題された語句を単語帳に保存</div>
            {activeSession.questions.map((q) => {
              const isSaved = savedAiTerms.has(normalizeTerm(q.term));
              return (
                <div
                  key={q.id}
                  className="between"
                  style={{
                    padding: "10px 0",
                    borderBottom: "1px solid var(--line)",
                    gap: 10,
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{q.term}</div>
                    <div className="small muted">{q.meaning}</div>
                  </div>
                  <button
                    type="button"
                    className={`btn btn-sm ${isSaved ? "btn-secondary" : "btn-primary"}`}
                    disabled={isSaved || savingAiTerm === q.id}
                    onClick={() => void saveAiQuestionToWordbook(q)}
                  >
                    {savingAiTerm === q.id ? (
                      <Loader2 size={13} className="spin" />
                    ) : isSaved ? (
                      <>
                        <Check size={13} /> 追加済み
                      </>
                    ) : (
                      <>
                        <BookPlus size={13} /> 単語帳へ
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </section>
        ) : null}
      </div>
    );
  }

  // ---------- Stage 2: Active Question ----------
  if (!activeSession || !currentQuestion) {
    return (
      <EmptyState
        icon={<Layers3 size={20} />}
        title="セッションが見つかりません"
        description="復習の設定画面から新しいセッションを開始してください。"
        action={
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setStage("setup")}
          >
            復習設定へ
          </button>
        }
      />
    );
  }

  const isAi = activeSession.source === "ai";
  // AI quiz is strictly 4-choice only. Wordbook cloze is also 4-choice.
  const showChoices =
    isAi || activeSession.mode === "cloze" || useChoicesInWordbook;
  const maskedCloze =
    activeSession.mode === "cloze"
      ? maskSentence(
          currentQuestion.sourceText,
          currentQuestion.surface || currentQuestion.term,
        )
      : null;

  const isSavedAiWord = savedAiTerms.has(normalizeTerm(currentQuestion.term));

  return (
    <div className="stack fade-in">
      <div className="wb-review-meta">
        <span>
          {isAi ? "AI出題（4択）" : "単語帳"} · {modeLabel(activeSession.mode)}
          {activeSession.isRetryRound ? "（解き直し）" : ""}
        </span>
        <div className="row" style={{ gap: 8 }}>
          <b>
            {activeSession.index + 1}
            <span> / {activeSession.questions.length}</span>
          </b>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={pauseCurrentSession}
            title="中断して保存"
          >
            <Pause size={13} /> 中断
          </button>
        </div>
      </div>

      <progress
        className="wb-session-progress"
        max={activeSession.questions.length}
        value={activeSession.index + (currentAnswer ? 1 : 0.2)}
      />

      <div className="card card-pad stack">
        {/* Toggle between 4-choice and self-check is ONLY shown for wordbook card/recall before answering */}
        {!isAi && activeSession.mode !== "cloze" && !currentAnswer ? (
          <div className="wb-question-toggle">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setUseChoicesInWordbook((v) => !v);
                setSelfRevealed(false);
              }}
            >
              {useChoicesInWordbook ? "自己判定に切替" : "4択表示に切替"}
            </button>
          </div>
        ) : null}

        <div className="wb-question">
          <small>
            {activeSession.mode === "card"
              ? "この語句の意味を選んでください"
              : activeSession.mode === "recall"
                ? "この意味に合う英語を選んでください"
                : "空欄に入る最も自然な表現を選んでください"}
          </small>

          {activeSession.mode === "cloze" ? (
            <>
              {/* The translation would give the answer away; it appears only after answering. */}
              <p className="sentence">
                {maskedCloze ?? currentQuestion.sourceText}
              </p>
            </>
          ) : activeSession.mode === "recall" ? (
            <p>{currentQuestion.meaning}</p>
          ) : (
            <div className="row" style={{ justifyContent: "center", gap: 8, margin: "18px 0" }}>
              <p style={{ margin: 0 }}>{currentQuestion.term}</p>
              <button
                type="button"
                className="btn-icon"
                onClick={() => void speak(currentQuestion.term, settings?.sourceLang ?? "en")}
                aria-label="発音を聞く"
              >
                <Volume2 size={18} />
              </button>
            </div>
          )}
        </div>

        {/* Before answering */}
        {!currentAnswer ? (
          showChoices ? (
            <div className="wb-options" role="group" aria-label="4択の選択肢">
              {currentQuestion.choices.map((choice, idx) => (
                <button
                  key={`${idx}-${choice}`}
                  type="button"
                  className="wb-option"
                  onClick={() => {
                    const isCorrect =
                      normalizeTerm(choice) ===
                        normalizeTerm(currentQuestion.correctChoice) ||
                      choice.trim() === currentQuestion.correctChoice.trim();
                    void recordAnswer({
                      correct: isCorrect,
                      chosen: choice,
                      assisted: true,
                    });
                  }}
                >
                  <span>{idx + 1}</span>
                  <div>{choice}</div>
                </button>
              ))}
            </div>
          ) : !selfRevealed ? (
            <button
              type="button"
              className="btn btn-secondary btn-lg btn-block"
              onClick={() => setSelfRevealed(true)}
            >
              答えを見る
            </button>
          ) : (
            <div className="stack">
              <div className="card-soft card-pad center">
                <div style={{ fontSize: 20, fontWeight: 700 }}>
                  {activeSession.mode === "recall"
                    ? currentQuestion.term
                    : currentQuestion.meaning}
                </div>
              </div>
              <div className="wb-two">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    void recordAnswer({
                      correct: false,
                      chosen: "まだ",
                      assisted: false,
                    })
                  }
                >
                  <X size={15} /> まだ
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() =>
                    void recordAnswer({
                      correct: true,
                      chosen: currentQuestion.correctChoice,
                      assisted: false,
                    })
                  }
                >
                  <Check size={15} /> 思い出せた
                </button>
              </div>
            </div>
          )
        ) : (
          /* Post-answer feedback, explanation, and image (NEVER shown before answering) */
          <div className="wb-answer fade-in">
            <div className={`wb-feedback${currentAnswer.correct ? "" : " incorrect"}`}>
              {currentAnswer.correct ? "正解です！" : "惜しい！"}
              <small>
                正解: {currentQuestion.correctChoice}
                {!currentAnswer.correct && currentAnswer.chosen
                  ? ` （あなたの回答: ${currentAnswer.chosen}）`
                  : ""}
                {activeSession.source === "wordbook" && currentAnswer.correct
                  ? currentAnswer.gained
                    ? activeSession.mode === "recall"
                      ? " · 想起カウント +1"
                      : " · 理解カウント +1"
                    : currentAnswer.sameDaySkipped
                      ? " · 本日分は加算済み"
                      : activeSession.isRetryRound
                        ? " · 解き直し（重複加算なし）"
                        : ""
                  : ""}
              </small>
            </div>

            {showChoices && currentQuestion.choices.length ? (
              <div className="wb-options wb-options-review" aria-label="選択肢の答え合わせ">
                {currentQuestion.choices.map((choice, idx) => {
                  const isCorrectChoice =
                    normalizeTerm(choice) === normalizeTerm(currentQuestion.correctChoice) ||
                    choice.trim() === currentQuestion.correctChoice.trim();
                  const isChosen = choice === currentAnswer.chosen;
                  return (
                    <div
                      key={`${idx}-${choice}`}
                      className={`wb-option${isCorrectChoice ? " correct" : isChosen ? " chosen" : ""}`}
                    >
                      <span>
                        {isCorrectChoice ? <Check size={14} /> : isChosen ? <X size={14} /> : idx + 1}
                      </span>
                      <div>
                        {choice}
                        {currentQuestion.choiceNotes?.[choice] ? (
                          <small className="wb-option-note">{currentQuestion.choiceNotes[choice]}</small>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}

            <div className="row between" style={{ marginTop: 14 }}>
              <div className="row" style={{ gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: 24 }}>{currentQuestion.term}</h3>
                <button
                  type="button"
                  className="btn-icon"
                  style={{ width: 30, height: 30, minHeight: 30 }}
                  onClick={() =>
                    void speak(currentQuestion.term, settings?.sourceLang ?? "en")
                  }
                  aria-label="単語を発音"
                >
                  <Volume2 size={15} />
                </button>
              </div>
              {isAi ? (
                <button
                  type="button"
                  className={`btn btn-sm ${isSavedAiWord ? "btn-secondary" : "btn-primary"}`}
                  disabled={isSavedAiWord || savingAiTerm === currentQuestion.id}
                  onClick={() => void saveAiQuestionToWordbook(currentQuestion)}
                >
                  {savingAiTerm === currentQuestion.id ? (
                    <Loader2 size={13} className="spin" />
                  ) : isSavedAiWord ? (
                    <>
                      <Check size={13} /> 単語帳に保存済み
                    </>
                  ) : (
                    <>
                      <BookPlus size={13} /> 単語帳に追加
                    </>
                  )}
                </button>
              ) : null}
            </div>

            <p className="wb-meaning" style={{ margin: "6px 0 14px" }}>
              {currentQuestion.meaning}
            </p>

            {currentQuestion.sourceText ? (
              <div className="wb-example">
                <div className="between" style={{ alignItems: "flex-start" }}>
                  <p>
                    <HighlightedExample
                      text={currentQuestion.sourceText}
                      term={currentQuestion.surface || currentQuestion.term}
                    />
                  </p>
                  <button
                    type="button"
                    className="btn-icon"
                    style={{ width: 28, height: 28, minHeight: 28, flexShrink: 0 }}
                    onClick={() =>
                      void speak(currentQuestion.sourceText, settings?.sourceLang ?? "en")
                    }
                    aria-label="例文を読み上げ"
                  >
                    <Volume2 size={14} />
                  </button>
                </div>
                {currentQuestion.translatedText ? (
                  <p>{currentQuestion.translatedText}</p>
                ) : null}
              </div>
            ) : isAi && currentQuestion.distractors ? (
              exampleFailed.has(currentQuestion.id) ? (
                <p className="small muted">
                  例文を作れませんでした。{" "}
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => {
                      setExampleFailed((prev) => {
                        const next = new Set(prev);
                        next.delete(currentQuestion.id);
                        return next;
                      });
                    }}
                  >
                    もう一度作る
                  </button>
                </p>
              ) : (
                <p className="small muted">
                  <Loader2 size={13} className="spin" style={{ verticalAlign: "-2px" }} /> 例文を作成中…
                </p>
              )
            ) : null}

            {/* Post-answer image reveal + zoom modal */}
            {Boolean(settings?.reviewShowImage && currentQuestion.imageKey) ? (
              <button
                type="button"
                className="wb-image"
                onClick={() =>
                  setZoomImageUrl(`/api/images/${currentQuestion.imageKey}`)
                }
              >
                <img
                  src={`/api/images/${currentQuestion.imageKey}`}
                  alt="復習カードの画像"
                  loading="lazy"
                />
                <span>タップで画像を拡大</span>
              </button>
            ) : null}

            <button
              type="button"
              className="btn btn-primary btn-lg btn-block"
              style={{ marginTop: 14 }}
              onClick={goToNextQuestion}
              disabled={isLastLoaded && waitingForMore}
            >
              {isLastLoaded && waitingForMore ? (
                <>
                  <Loader2 size={15} className="spin" /> 次の問題を作成中…
                </>
              ) : isLastLoaded ? (
                "結果を見る"
              ) : (
                "次の問題へ"
              )}
            </button>
          </div>
        )}
      </div>

      <ImageZoomModal
        src={zoomImageUrl}
        alt="復習カードの拡大画像"
        onClose={() => setZoomImageUrl(null)}
      />
    </div>
  );
}
