import type { ReviewMode } from "../../shared/types";

export interface ReviewSessionQuestion {
  id: string;
  wordId: string | null;
  term: string;
  surface: string;
  meaning: string;
  partOfSpeech: string;
  sourceText: string;
  translatedText: string;
  note: string;
  imageKey: string | null;
  choices: string[];
  correctChoice: string;
  /** Optional counterpart for each choice (meaning ↔ English), shown after answering. */
  choiceNotes?: Record<string, string>;
  /** AI questions keep their distractors so an example can be generated later. */
  distractors?: Array<{ term: string; meaning: string }>;
}

export interface ReviewAnswerRecord {
  questionId: string;
  correct: boolean;
  chosen: string;
  assisted: boolean;
  gained?: boolean;
  sameDaySkipped?: boolean;
}

export interface PausedReviewSession {
  id: string;
  source: "wordbook" | "ai";
  mode: ReviewMode;
  count: 5 | 10;
  scope: "due" | "all";
  questions: ReviewSessionQuestion[];
  index: number;
  answers: ReviewAnswerRecord[];
  retriedIds: string[];
  isRetryRound: boolean;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = "gf_review_sessions_v2";
const MAX_SESSIONS = 5;

export function loadPausedSessions(): PausedReviewSession[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is PausedReviewSession =>
          Boolean(
            s &&
              typeof s.id === "string" &&
              Array.isArray(s.questions) &&
              s.questions.length > 0 &&
              typeof s.index === "number" &&
              s.index < s.questions.length,
          ),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS);
  } catch {
    return [];
  }
}

export function savePausedSession(session: PausedReviewSession): PausedReviewSession[] {
  const existing = loadPausedSessions().filter((s) => s.id !== session.id);
  const next = [{ ...session, updatedAt: Date.now() }, ...existing].slice(0, MAX_SESSIONS);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage quota errors
  }
  return next;
}

export function removePausedSession(id: string): PausedReviewSession[] {
  const next = loadPausedSessions().filter((s) => s.id !== id);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

const RECENT_AI_TERMS_KEY = "gf_recent_ai_terms";
const RECENT_AI_TERMS_LIMIT = 150;

/** Words recently used in AI quizzes, newest first, so new quizzes avoid them. */
export function loadRecentAiTerms(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_AI_TERMS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function rememberAiTerms(terms: string[]): void {
  const next = [...new Set([...terms, ...loadRecentAiTerms()])].slice(0, RECENT_AI_TERMS_LIMIT);
  try {
    window.localStorage.setItem(RECENT_AI_TERMS_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
}

export function modeLabel(mode: ReviewMode): string {
  if (mode === "cloze") return "文脈穴埋め";
  if (mode === "recall") return "日本語 → 英語";
  return "単語 → 意味";
}
