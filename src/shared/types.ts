export const PROMPT_VERSION = "2026-10-22.2";

export type LearnerLevel = "junior" | "high" | "600" | "800" | "900";

export type ReviewMode = "card" | "cloze" | "recall";

export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

export const LEARNER_LEVELS: Array<{
  value: LearnerLevel;
  label: string;
  /** How explanations are written for this learner. */
  instruction: string;
  /** Easiest CEFR level worth quizzing; anything below is already known. */
  minCefr: CefrLevel;
  /**
   * Target vocabulary for the model. Deliberately without example words: the
   * model reused them as the quiz itself.
   */
  vocab: string;
}> = [
  {
    value: "junior",
    label: "中学生",
    instruction: "中学英語を学習中。基本構文も平易に説明し、専門用語は言い換える。",
    minCefr: "A1",
    vocab: "CEFR A1-A2, everyday words from junior-high English",
  },
  {
    value: "high",
    label: "高校生",
    instruction: "中学英語は既習。ifやwillなどの基本事項は省き、高校文法・句動詞・省略を優先する。",
    minCefr: "A2",
    vocab: "CEFR A2-B1, high-school words and common phrasal verbs",
  },
  {
    value: "600",
    label: "TOEIC 600点",
    instruction: "基礎文法は既習。句動詞、コロケーション、文構造の取り違えやすい点を中心に説明する。",
    minCefr: "B1",
    vocab: "CEFR B1-B2, basic office and business vocabulary (TOEIC 600)",
  },
  {
    value: "800",
    label: "TOEIC 800点",
    instruction: "基礎・標準文法は説明不要。文脈上の語義、指示対象、語感、自然な訳になる理由に絞る。",
    minCefr: "B2",
    vocab: "CEFR B2-C1, business, finance, legal and academic vocabulary and idioms (TOEIC 800)",
  },
  {
    value: "900",
    label: "TOEIC 900点",
    instruction: "高度な英語力を想定。語用論、レジスター、含意、似た表現との微妙な差だけを簡潔に扱う。",
    minCefr: "C1",
    vocab: "CEFR C1-C2, advanced formal and low-frequency vocabulary (TOEIC 900)",
  },
];

export function learnerLevelInfo(level: LearnerLevel) {
  return LEARNER_LEVELS.find((item) => item.value === level) ?? LEARNER_LEVELS[3];
}

export function learnerInstruction(level: LearnerLevel): string {
  return (
    LEARNER_LEVELS.find((item) => item.value === level)?.instruction ??
    LEARNER_LEVELS[3].instruction
  );
}

export interface Settings {
  sourceLang: string;
  targetLang: string;
  saveImages: boolean;
  reviewIntervalDays: number;
  reviewTargetCount: number;
  reviewBatchSize: number;
  reviewShowImage: boolean;
  reviewOrder: "due" | "created" | "random";
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_SETTINGS: Omit<Settings, "createdAt" | "updatedAt"> = {
  sourceLang: "en",
  targetLang: "ja",
  saveImages: true,
  reviewIntervalDays: 7,
  reviewTargetCount: 3,
  reviewBatchSize: 20,
  reviewShowImage: true,
  reviewOrder: "due",
};

export interface Segment {
  source: string;
  translation: string;
}

export interface GrammarNote {
  title: string;
  explanation: string;
  example?: string;
}

export interface KeyPhrase {
  term: string;
  meaning: string;
  note?: string;
}

export interface TranslationResult {
  id?: string;
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  segments: Segment[];
  grammarNotes: GrammarNote[];
  keyPhrases: KeyPhrase[];
  imageKey?: string | null;
  createdAt?: number;
  cached?: boolean;
}

export interface WordDetail {
  term: string;
  baseForm: string;
  partOfSpeech: string;
  meaning: string;
  contextMeaning: string;
  note?: string;
  sourceEquivalent?: string;
}

export interface SimilarExpression {
  term: string;
  meaning: string;
  difference: string;
}

export interface SimilarExpressions {
  expressions: SimilarExpression[];
}

export interface WordExample {
  id: string;
  wordId: string;
  translationId?: string | null;
  sourceText: string;
  translatedText: string;
  contextMeaning?: string | null;
  grammarNote?: string | null;
  imageKey?: string | null;
  createdAt: number;
}

export type WordOrigin = "translation" | "manual" | "ai";

export interface ClozeOptionSet {
  updatedAt?: number;
  surface: string;
  choices: string[];
  note?: string;
  sourceText?: string;
}

export interface WordCard {
  id: string;
  term: string;
  normalizedTerm: string;
  baseForm?: string | null;
  partOfSpeech?: string | null;
  meaning: string;
  sourceLang: string;
  targetLang: string;
  origin?: "translation" | "manual" | "ai";
  reviewCount: number;
  knownCount?: number;
  recallCount?: number;
  knownReviewedDay?: string | null;
  recallReviewedDay?: string | null;
  clozeOptions?: ClozeOptionSet | null;
  mastered: boolean;
  nextReviewAt?: number | null;
  lastReviewedAt?: number | null;
  createdAt: number;
  updatedAt: number;
  examples?: WordExample[];
  exampleCount?: number;
  imageKey?: string | null;
  exampleSource?: string | null;
  exampleTranslation?: string | null;
  exampleContext?: string | null;
  exampleGrammarNote?: string | null;
}

export interface TranslationRecord
  extends Omit<TranslationResult, "id" | "createdAt" | "cached"> {
  id: string;
  createdAt: number;
  hasImage?: boolean;
}

export interface ReviewQueueItem {
  word: WordCard;
  example: WordExample | null;
}

export interface ReviewResult {
  word: WordCard;
  nextReviewAt: number | null;
  mastered: boolean;
  reviewCount?: number;
  knownCount?: number;
  recallCount?: number;
  gained?: boolean;
  sameDaySkipped?: boolean;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content?: string;
  text?: string;
}

export interface SelectedTextRange {
  side?: "source" | "translation";
  start?: number;
  end?: number;
  text: string;
}

export interface AiQuizQuestion {
  partOfSpeech?: string;
  id: string;
  term: string;
  meaning: string;
  level?: number;
  source: string;
  translation: string;
  surface: string;
  choices: string[];
  /** Japanese meaning of each choice, aligned with `choices`. */
  choiceMeanings?: string[];
  note: string;
}

export interface AiQuizPlanResponse {
  items: Array<{
    id: string;
    term: string;
    meaning: string;
    partOfSpeech: string;
    distractors: Array<{ term: string; meaning: string }>;
  }>;
}

/** Example sentence for a planned question; `choices` is set only for cloze. */
export interface AiQuizExample {
  id: string;
  surface: string;
  source: string;
  translation: string;
  choices: string[];
}

export interface AiQuizExamplesResponse {
  items: AiQuizExample[];
}

export interface WordCompletionResult {
  term?: string;
  meaning: string;
  sourceText: string;
  translatedText: string;
  baseForm?: string;
  partOfSpeech?: string;
  grammarNote?: string;
  cached?: boolean;
}

export interface AlternativeExampleItem {
  sourceText: string;
  translatedText: string;
  note?: string;
}

export interface AlternativeExamplesResult {
  examples: AlternativeExampleItem[];
  cached?: boolean;
}

export interface AiUsageSummary {
  /** UTC date of the current free-quota day (resets 09:00 JST). */
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** This app's usage converted with Cloudflare's per-model Neuron rates. */
  neurons: number;
  neuronLimit: number;
  /** Account-wide Neurons from the Cloudflare analytics API, when configured. */
  account: { neurons: number; fetchedAt: number } | null;
  byKind: Array<{
    kind: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    neurons: number;
  }>;
  byModel: Array<{ model: string; requests: number; neurons: number }>;
}

export interface Stats {
  translations: number;
  words: number;
  dueWords: number;
  masteredWords: number;
  images: number;
  imageBytes: number;
  ai: AiUsageSummary;
  storage?: StorageUsage;
}

export interface StorageUsage {
  /** D1 database file size, reported by D1 itself. */
  d1: { usedBytes: number | null; limitBytes: number };
  /** "account" is Cloudflare's own figure; "app" counts only stored images. */
  kv: { usedBytes: number; limitBytes: number; source: "account" | "app" };
}

export interface BackupPayload {
  format: "glossframe-backup";
  version: 1;
  exportedAt: number;
  settings: Settings;
  translations: TranslationRecord[];
  words: WordCard[];
  examples: WordExample[];
  reviewEvents: Array<{
    id: string;
    wordId: string;
    rating: "known" | "unknown";
    reviewCountAfter: number;
    reviewedAt: number;
    nextReviewAt: number | null;
  }>;
  images: Array<{ key: string; contentType: string; dataBase64: string }>;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
