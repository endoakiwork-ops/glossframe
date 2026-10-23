import { isVocabularyCandidate, normalizeTerm } from "./srs";
import { CEFR_LEVELS, type CefrLevel } from "./types";

/** Interchangeable options seen in live generations; a model can miss these. */
export const KNOWN_SYNONYM_GROUPS = [
  ["therefore", "consequently", "thus", "hence", "as a result"],
  ["check", "verify", "inspect", "examine"],
  ["improve", "enhance", "upgrade"],
  ["on time", "in time"],
  ["get along", "get on"],
  ["alert", "warning", "caution", "warn"],
];

export function hasKnownSynonyms(terms: string[]): boolean {
  const options = new Set(terms.map(normalizeTerm));
  return KNOWN_SYNONYM_GROUPS.some((group) => group.filter((term) => options.has(term)).length > 1);
}

export interface QuizPlanItem {
  id: string;
  term: string;
  meaning: string;
  partOfSpeech: string;
  distractors: Array<{ term: string; meaning: string }>;
}

const KANJI = /[一-鿿]/g;

/**
 * Meanings that share a kanji usually overlap (警戒 / 警告), which makes a
 * "word → meaning" question ambiguous even when the English words differ.
 */
export function meaningsOverlap(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (!x || !y) return true;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const kanji = new Set(x.match(KANJI) ?? []);
  return (y.match(KANJI) ?? []).some((char) => kanji.has(char));
}

/**
 * True when the model's own CEFR rating is below the learner's level. A
 * missing or unreadable rating is not treated as too easy.
 */
export function belowLevel(cefr: string | undefined, minCefr: CefrLevel): boolean {
  const rank = CEFR_LEVELS.indexOf(String(cefr ?? "").trim().toUpperCase().slice(0, 2) as CefrLevel);
  return rank >= 0 && rank < CEFR_LEVELS.indexOf(minCefr);
}

/**
 * Accepts a planned question only when its four options are unambiguous in
 * both directions: distinct English terms and clearly different meanings.
 */
export function validateQuizPlanItem(
  raw: {
    term?: string;
    cefr?: string;
    meaning?: string;
    pos?: string;
    distractors?: Array<{ term?: string; meaning?: string }>;
  },
  id: string,
  existing: Set<string>,
  minCefr: CefrLevel = "A1",
): QuizPlanItem | null {
  const term = String(raw.term ?? "").trim().replace(/\s+/g, " ");
  const meaning = String(raw.meaning ?? "").trim();
  const norm = normalizeTerm(term);
  if (!term || !meaning || !norm || existing.has(norm) || !isVocabularyCandidate(term)) return null;
  // Too easy for this learner (e.g. "count" for TOEIC 800).
  if (belowLevel(raw.cefr, minCefr)) return null;

  const distractors = (raw.distractors ?? [])
    .map((d) => ({ term: String(d.term ?? "").trim().replace(/\s+/g, " "), meaning: String(d.meaning ?? "").trim() }))
    .filter((d) => d.term && d.meaning)
    .slice(0, 3);
  if (distractors.length !== 3) return null;

  const terms = [term, ...distractors.map((d) => d.term)];
  if (new Set(terms.map(normalizeTerm)).size !== 4 || hasKnownSynonyms(terms)) return null;

  // Only answer-vs-distractor overlap makes the question ambiguous.
  if (distractors.some((d) => meaningsOverlap(meaning, d.meaning))) return null;
  if (new Set(distractors.map((d) => d.meaning)).size !== 3) return null;

  return { id, term, meaning, partOfSpeech: String(raw.pos ?? "").trim(), distractors };
}
