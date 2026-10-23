export const UNKNOWN_RETRY_MS = 10 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReviewComputation {
  reviewCount: number;
  mastered: boolean;
  nextReviewAt: number | null;
}

/**
 * "覚えた" advances the card. The interval is applied from now; the card is
 * removed from the normal review pool once the target count is reached.
 */
export function computeKnownReview(params: {
  reviewCount: number;
  targetCount: number;
  intervalDays: number;
  now: number;
}): ReviewComputation {
  const reviewCount = params.reviewCount + 1;
  const mastered = reviewCount >= Math.max(1, params.targetCount);
  return {
    reviewCount,
    mastered,
    nextReviewAt: mastered ? null : params.now + Math.max(1, params.intervalDays) * DAY_MS,
  };
}

/**
 * "まだ覚えていない" does not increase the count. The card stays due, but is
 * pushed 10 minutes out so one session cannot loop on it forever.
 */
export function computeUnknownReview(now: number): ReviewComputation {
  return { reviewCount: -1, mastered: false, nextReviewAt: now + UNKNOWN_RETRY_MS };
}

export function normalizeTerm(term: string): string {
  return term
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s.,!?;:'"()[\]{}「」『』、。！？…—–-]+|[\s.,!?;:'"()[\]{}「」『』、。！？…—–-]+$/g, "");
}

export function isDue(nextReviewAt: number | null | undefined, mastered: boolean, now: number): boolean {
  return !mastered && (nextReviewAt == null || nextReviewAt <= now);
}

export function formatNextReview(nextReviewAt: number | null | undefined, now = Date.now()): string {
  if (nextReviewAt == null) return "—";
  const diff = nextReviewAt - now;
  if (diff <= 0) return "復習できます";
  const minutes = Math.ceil(diff / 60000);
  if (minutes < 60) return `${minutes}分後`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `${hours}時間後`;
  return `${Math.ceil(hours / 24)}日後`;
}

export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function jstDayString(now = Date.now()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(now));
}

export function isWordMastered(params: {
  knownCount?: number;
  recallCount?: number;
  reviewCount?: number;
  mastered?: boolean;
  targetCount?: number;
}): boolean {
  const target = Math.max(1, params.targetCount ?? 3);
  const known = params.knownCount ?? params.reviewCount ?? 0;
  const recall = params.recallCount ?? 0;
  return Boolean(params.mastered) || known >= target || recall >= target;
}

export function wordRank(params: {
  knownCount?: number;
  recallCount?: number;
  reviewCount?: number;
  targetCount?: number;
}): string {
  const target = Math.max(1, params.targetCount ?? 3);
  const known = params.knownCount ?? params.reviewCount ?? 0;
  const recall = params.recallCount ?? 0;
  if (recall >= target) return "英語で言える";
  if (recall > 0) return "想起を練習中";
  if (known >= target) return "意味がわかる";
  if (known > 0) return "覚えかけ";
  return "未習得";
}

export interface TrackReviewComputation {
  knownCount: number;
  recallCount: number;
  reviewCount: number;
  knownReviewedDay: string | null;
  recallReviewedDay: string | null;
  mastered: boolean;
  nextReviewAt: number | null;
  gained: boolean;
  sameDaySkipped: boolean;
}

/**
 * Separate comprehension (known) and recall tracks with at most 1 increment per JST day
 * per track, retry deduplication, and no demotion of achieved ranks/counts.
 */
export function computeTrackReview(params: {
  knownCount: number;
  recallCount: number;
  knownReviewedDay?: string | null;
  recallReviewedDay?: string | null;
  mastered: boolean;
  mode: "card" | "cloze" | "recall";
  rating: "known" | "unknown";
  retry?: boolean;
  assisted?: boolean;
  targetCount: number;
  intervalDays: number;
  now: number;
}): TrackReviewComputation {
  const target = Math.max(1, params.targetCount || 3);
  const intervalDays = Math.max(1, params.intervalDays || 7);
  const today = jstDayString(params.now);
  const track = params.mode === "recall" ? "recall" : "known";

  let knownCount = Math.max(0, params.knownCount);
  let recallCount = Math.max(0, params.recallCount);
  let knownReviewedDay = params.knownReviewedDay ?? null;
  let recallReviewedDay = params.recallReviewedDay ?? null;
  let gained = false;

  if (params.rating === "known") {
    if (!params.retry) {
      if (track === "recall") {
        if (recallReviewedDay !== today && recallCount < target) {
          recallCount = Math.min(target, recallCount + 1);
          recallReviewedDay = today;
          gained = true;
        } else if (recallReviewedDay !== today) {
          recallReviewedDay = today;
        }
      } else {
        if (knownReviewedDay !== today && knownCount < target) {
          knownCount = Math.min(target, knownCount + 1);
          knownReviewedDay = today;
          gained = true;
        } else if (knownReviewedDay !== today) {
          knownReviewedDay = today;
        }
      }
    }
    const mastered = Boolean(params.mastered) || knownCount >= target || recallCount >= target;
    const reviewCount = Math.max(knownCount, recallCount);
    return {
      knownCount,
      recallCount,
      reviewCount,
      knownReviewedDay,
      recallReviewedDay,
      mastered,
      nextReviewAt: params.retry ? params.now : params.now + intervalDays * DAY_MS,
      gained,
      sameDaySkipped: !gained && (track === "recall" ? params.recallReviewedDay : params.knownReviewedDay) === today,
    };
  }

  // On "unknown", never demote achieved counts or mastered status.
  const mastered = Boolean(params.mastered) || knownCount >= target || recallCount >= target;
  const reviewCount = Math.max(knownCount, recallCount);
  return {
    knownCount,
    recallCount,
    reviewCount,
    knownReviewedDay,
    recallReviewedDay,
    mastered,
    nextReviewAt: params.now,
    gained: false,
    sameDaySkipped: false,
  };
}

export const KNOWN_INFLECTIONS: Record<string, string[]> = {
  "run out of": ["running out of", "ran out of", "runs out of", "run out of"],
  "look after": ["looks after", "looked after", "looking after", "look after"],
  "set off": ["sets off", "setting off", "set off"],
  "pick up": ["picks up", "picked up", "picking up", "pick up"],
  "leave off": ["leaves off", "left off", "leaving off", "leave off"],
  "take a break": ["takes a break", "took a break", "taking a break", "take a break"],
  "get along with": ["gets along with", "got along with", "getting along with", "get along with"],
  "put off": ["puts off", "putting off", "put off"],
  "give up": ["gives up", "gave up", "given up", "giving up", "give up"],
  "figure out": ["figures out", "figured out", "figuring out", "figure out"],
  "depend on": ["depends on", "depended on", "depending on", "depend on"],
  "put up with": ["puts up with", "putting up with", "put up with"],
  "take part in": ["takes part in", "took part in", "taking part in", "take part in"],
  "turn off": ["turns off", "turned off", "turning off", "turn off"],
  "wake up": ["wakes up", "woke up", "woken up", "waking up", "wake up"],
  throw: ["throws", "threw", "thrown", "throwing", "throw"],
};

export function termBoundaryPattern(term: string): RegExp {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-zÀ-ž])${escaped}(?![A-Za-zÀ-ž])`, "gi");
}

export function findTermRanges(
  text: string,
  term: string,
  surface?: string | null,
): Array<{ start: number; end: number }> {
  const source = String(text ?? "");
  if (!source) return [];
  const norm = normalizeTerm(term);
  const candidates = [
    surface?.trim(),
    term.trim(),
    ...(KNOWN_INFLECTIONS[norm] ?? []),
  ]
    .filter((v): v is string => Boolean(v && v.trim()))
    .sort((a, b) => b.length - a.length);

  const matches: Array<{ start: number; end: number }> = [];
  for (const candidate of candidates) {
    const pattern = termBoundaryPattern(candidate);
    for (const match of source.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (!matches.some((m) => start < m.end && end > m.start)) {
        matches.push({ start, end });
      }
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

export function maskSentence(
  sourceText: string | null | undefined,
  term: string,
  surface?: string | null,
): string | null {
  const source = String(sourceText ?? "");
  if (!source.trim() || !term.trim()) return null;
  const ranges = findTermRanges(source, term, surface);
  if (!ranges.length) return null;
  let cursor = 0;
  let out = "";
  for (const r of ranges) {
    out += source.slice(cursor, r.start) + "[　　　　]";
    cursor = r.end;
  }
  out += source.slice(cursor);
  return out;
}

export function highlightSegments(
  sourceText: string | null | undefined,
  term: string,
  surface?: string | null,
): Array<{ text: string; highlight: boolean }> {
  const source = String(sourceText ?? "");
  if (!source) return [];
  if (!term.trim()) return [{ text: source, highlight: false }];
  const ranges = findTermRanges(source, term, surface);
  if (!ranges.length) return [{ text: source, highlight: false }];
  const segments: Array<{ text: string; highlight: boolean }> = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) {
      segments.push({ text: source.slice(cursor, r.start), highlight: false });
    }
    segments.push({ text: source.slice(r.start, r.end), highlight: true });
    cursor = r.end;
  }
  if (cursor < source.length) {
    segments.push({ text: source.slice(cursor), highlight: false });
  }
  return segments;
}

export interface RawQuizCandidate {
  id?: string;
  term?: string;
  meaning?: string;
  level?: number;
  source?: string;
  translation?: string;
  surface?: string;
  choices?: string[];
  /** Japanese meaning of each choice, in the same order as `choices`. */
  choiceMeanings?: string[];
  note?: string;
}

export function validateQuizQuestion(
  raw: RawQuizCandidate,
  existingNormalizedTerms: Set<string> = new Set(),
): {
  ok: boolean;
  reason?: string;
  question?: {
    id: string;
    term: string;
    meaning: string;
    level: number;
    source: string;
    translation: string;
    surface: string;
    choices: string[];
    choiceMeanings: string[];
    note: string;
  };
} {
  const term = String(raw.term ?? "").trim().replace(/\s+/g, " ");
  const meaning = String(raw.meaning ?? "").trim();
  const source = String(raw.source ?? "").trim();
  const translation = String(raw.translation ?? "").trim();
  const surface = String(raw.surface || term).trim().replace(/\s+/g, " ");
  const note = String(raw.note ?? "").trim();
  const level = Math.min(5, Math.max(1, Math.round(Number(raw.level ?? 2) || 2)));

  // The note is optional: review screens no longer show explanations.
  if (!term || !meaning || !source || !translation || !surface) {
    return { ok: false, reason: "missing_fields" };
  }
  if (source.includes(";")) {
    return { ok: false, reason: "semicolon_in_source" };
  }
  const normalizedTerm = normalizeTerm(term);
  if (!normalizedTerm || existingNormalizedTerms.has(normalizedTerm)) {
    return { ok: false, reason: "duplicate_or_existing_term" };
  }
  if (!Array.isArray(raw.choices) || raw.choices.length !== 4) {
    return { ok: false, reason: "choices_count" };
  }
  const choices = raw.choices.map((c) => String(c ?? "").trim().replace(/\s+/g, " "));
  if (choices.some((c) => !c)) {
    return { ok: false, reason: "empty_choice" };
  }
  const normalizedChoices = choices.map((c) => normalizeTerm(c));
  if (new Set(normalizedChoices).size !== 4) {
    return { ok: false, reason: "duplicate_choices" };
  }
  const normalizedSurface = normalizeTerm(surface);
  const matchingIndex = normalizedChoices.findIndex(
    (c) => c === normalizedSurface,
  );
  if (matchingIndex < 0) {
    return { ok: false, reason: "correct_answer_missing" };
  }
  // Ensure the exact target expression exists in source on word boundaries.
  if (!termBoundaryPattern(surface).test(source)) {
    return { ok: false, reason: "surface_not_in_source" };
  }

  const meanings = Array.isArray(raw.choiceMeanings)
    ? raw.choiceMeanings.map((m) => String(m ?? "").trim())
    : [];
  // Meanings are only usable when every choice has its own distinct one.
  const choiceMeanings =
    meanings.length === 4 && meanings.every(Boolean) && new Set(meanings).size === 4 ? meanings : [];

  return {
    ok: true,
    question: {
      id: raw.id || `ai-${normalizedTerm.replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`,
      term,
      meaning,
      level,
      source,
      translation,
      surface: choices[matchingIndex],
      choices,
      choiceMeanings,
      note,
    },
  };
}

export function selectReferenceProfile(
  words: Array<{
    term: string;
    meaning: string;
    knownCount?: number;
    recallCount?: number;
    reviewCount?: number;
    mastered?: boolean;
    targetCount?: number;
  }>,
  maxSample = 10,
  rng: () => number = Math.random,
): Array<{ term: string; meaning: string; known: number; recall: number }> {
  const unmastered = words.filter((w) => !isWordMastered(w));
  const pool = unmastered.length > 0 ? unmastered : words;
  const uniqueMap = new Map<string, (typeof pool)[number]>();
  for (const w of pool) {
    const key = normalizeTerm(w.term);
    if (key && !uniqueMap.has(key)) {
      uniqueMap.set(key, w);
    }
  }
  const unique = [...uniqueMap.values()];
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }
  return unique.slice(0, Math.max(0, maxSample)).map((w) => ({
    term: w.term.trim(),
    meaning: w.meaning.trim(),
    known: w.knownCount ?? w.reviewCount ?? 0,
    recall: w.recallCount ?? 0,
  }));
}

export function cameraCrop(
  width: number,
  height: number,
  viewWidth: number,
  viewHeight: number,
): { x: number; y: number; width: number; height: number } {
  const safeViewW = Math.max(1, viewWidth);
  const safeViewH = Math.max(1, viewHeight);
  const ratio = safeViewW / safeViewH;
  const sourceRatio = width / height;
  const cropWidth = sourceRatio > ratio ? height * ratio : width;
  const cropHeight = sourceRatio > ratio ? height : width / ratio;
  return {
    x: (width - cropWidth) / 2,
    y: (height - cropHeight) / 2,
    width: cropWidth,
    height: cropHeight,
  };
}

export function isVocabularyCandidate(term: string): boolean {
  const cleaned = term.trim().replace(/\s+/g, " ");
  if (!cleaned || cleaned.length > 100) return false;
  // Reject full sentences with terminal punctuation
  if (/[.!?。！？]$/.test(cleaned) && cleaned.split(/\s+/).length > 1) return false;
  const words = cleaned.split(/\s+/);
  if (words.length > 6) return false;
  return true;
}
