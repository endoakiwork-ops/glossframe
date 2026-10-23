import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  UNKNOWN_RETRY_MS,
  cameraCrop,
  computeKnownReview,
  computeTrackReview,
  computeUnknownReview,
  formatNextReview,
  highlightSegments,
  isDue,
  isVocabularyCandidate,
  isWordMastered,
  jstDayString,
  maskSentence,
  normalizeTerm,
  selectReferenceProfile,
  validateQuizQuestion,
  wordRank,
} from "../src/shared/srs";

describe("computeKnownReview", () => {
  const now = 1_700_000_000_000;

  it("increments the count and schedules the next review", () => {
    const result = computeKnownReview({
      reviewCount: 0,
      targetCount: 3,
      intervalDays: 7,
      now,
    });
    expect(result.reviewCount).toBe(1);
    expect(result.mastered).toBe(false);
    expect(result.nextReviewAt).toBe(now + 7 * DAY_MS);
  });

  it("marks the card mastered when the target is reached", () => {
    const result = computeKnownReview({
      reviewCount: 2,
      targetCount: 3,
      intervalDays: 7,
      now,
    });
    expect(result.reviewCount).toBe(3);
    expect(result.mastered).toBe(true);
    expect(result.nextReviewAt).toBeNull();
  });

  it("clamps an interval of zero to one day", () => {
    const result = computeKnownReview({
      reviewCount: 0,
      targetCount: 5,
      intervalDays: 0,
      now,
    });
    expect(result.nextReviewAt).toBe(now + DAY_MS);
  });

  it("treats a target below one as a single review", () => {
    const result = computeKnownReview({
      reviewCount: 0,
      targetCount: 0,
      intervalDays: 7,
      now,
    });
    expect(result.mastered).toBe(true);
  });
});

describe("computeUnknownReview", () => {
  it("does not advance the count and retries after ten minutes", () => {
    const now = 1_700_000_000_000;
    const result = computeUnknownReview(now);
    expect(result.reviewCount).toBe(-1);
    expect(result.mastered).toBe(false);
    expect(result.nextReviewAt).toBe(now + UNKNOWN_RETRY_MS);
  });
});

describe("normalizeTerm", () => {
  it("normalizes width, case and whitespace", () => {
    expect(normalizeTerm("  Ｈｅｌｌｏ   World  ")).toBe("hello world");
  });

  it("removes surrounding punctuation but keeps inner apostrophes", () => {
    expect(normalizeTerm("「don't」")).toBe("don't");
    expect(normalizeTerm("...word!?")).toBe("word");
  });

  it("returns an empty string for punctuation-only input", () => {
    expect(normalizeTerm(" 「。」 ")).toBe("");
  });
});

describe("isDue", () => {
  const now = 1_700_000_000_000;

  it("is due when there is no next review", () => {
    expect(isDue(null, false, now)).toBe(true);
  });

  it("is due when the next review has passed", () => {
    expect(isDue(now - 1, false, now)).toBe(true);
  });

  it("is not due in the future or when mastered", () => {
    expect(isDue(now + 1, false, now)).toBe(false);
    expect(isDue(null, true, now)).toBe(false);
  });
});

describe("formatNextReview", () => {
  const now = 1_700_000_000_000;

  it("formats minutes, hours and days", () => {
    expect(formatNextReview(now + 5 * 60_000, now)).toBe("5分後");
    expect(formatNextReview(now + 2 * 60 * 60_000, now)).toBe("2時間後");
    expect(formatNextReview(now + 3 * DAY_MS, now)).toBe("3日後");
  });

  it("handles due and missing values", () => {
    expect(formatNextReview(now - 1, now)).toBe("復習できます");
    expect(formatNextReview(null, now)).toBe("—");
    expect(formatNextReview(undefined, now)).toBe("—");
  });
});

describe("computeTrackReview & wordRank", () => {
  const day1 = Date.parse("2026-04-20T10:00:00+09:00");
  const day1Later = Date.parse("2026-04-20T18:00:00+09:00");
  const day2 = Date.parse("2026-04-21T09:00:00+09:00");

  it("increments known and recall tracks independently and caps at 1 increment per JST day", () => {
    const first = computeTrackReview({
      knownCount: 0,
      recallCount: 0,
      mastered: false,
      mode: "card",
      rating: "known",
      targetCount: 3,
      intervalDays: 7,
      now: day1,
    });
    expect(first.knownCount).toBe(1);
    expect(first.recallCount).toBe(0);
    expect(first.gained).toBe(true);
    expect(first.knownReviewedDay).toBe(jstDayString(day1));

    const sameDaySecond = computeTrackReview({
      knownCount: first.knownCount,
      recallCount: first.recallCount,
      knownReviewedDay: first.knownReviewedDay,
      recallReviewedDay: first.recallReviewedDay,
      mastered: first.mastered,
      mode: "cloze",
      rating: "known",
      targetCount: 3,
      intervalDays: 7,
      now: day1Later,
    });
    expect(sameDaySecond.knownCount).toBe(1);
    expect(sameDaySecond.gained).toBe(false);
    expect(sameDaySecond.sameDaySkipped).toBe(true);

    // Recall track on the same day can still advance once
    const sameDayRecall = computeTrackReview({
      knownCount: sameDaySecond.knownCount,
      recallCount: sameDaySecond.recallCount,
      knownReviewedDay: sameDaySecond.knownReviewedDay,
      recallReviewedDay: sameDaySecond.recallReviewedDay,
      mastered: sameDaySecond.mastered,
      mode: "recall",
      rating: "known",
      targetCount: 3,
      intervalDays: 7,
      now: day1Later,
    });
    expect(sameDayRecall.recallCount).toBe(1);
    expect(sameDayRecall.gained).toBe(true);

    // Next day advances knownCount again
    const nextDay = computeTrackReview({
      knownCount: sameDayRecall.knownCount,
      recallCount: sameDayRecall.recallCount,
      knownReviewedDay: sameDayRecall.knownReviewedDay,
      recallReviewedDay: sameDayRecall.recallReviewedDay,
      mastered: sameDayRecall.mastered,
      mode: "card",
      rating: "known",
      targetCount: 3,
      intervalDays: 7,
      now: day2,
    });
    expect(nextDay.knownCount).toBe(2);
    expect(nextDay.gained).toBe(true);
  });

  it("does not increment on retry and never demotes achieved counts or ranks", () => {
    const retryRes = computeTrackReview({
      knownCount: 2,
      recallCount: 1,
      mastered: false,
      mode: "card",
      rating: "known",
      retry: true,
      targetCount: 3,
      intervalDays: 7,
      now: day2,
    });
    expect(retryRes.knownCount).toBe(2);
    expect(retryRes.gained).toBe(false);

    const unknownOnMastered = computeTrackReview({
      knownCount: 3,
      recallCount: 3,
      mastered: true,
      mode: "recall",
      rating: "unknown",
      targetCount: 3,
      intervalDays: 7,
      now: day2,
    });
    expect(unknownOnMastered.knownCount).toBe(3);
    expect(unknownOnMastered.recallCount).toBe(3);
    expect(unknownOnMastered.mastered).toBe(true);
    expect(wordRank({ knownCount: 3, recallCount: 3, targetCount: 3 })).toBe("英語で言える");
    expect(isWordMastered({ knownCount: 3, recallCount: 0, targetCount: 3 })).toBe(true);
  });
});

describe("maskSentence & highlightSegments", () => {
  it("masks and highlights inflected phrasal verbs on word boundaries", () => {
    const sentence = "We were running out of time before the train set off.";
    expect(maskSentence(sentence, "run out of")).toBe(
      "We were [　　　　] time before the train set off.",
    );
    const segs = highlightSegments(sentence, "run out of");
    expect(segs.filter((s) => s.highlight).map((s) => s.text)).toEqual(["running out of"]);
  });

  it("does not match partial substrings inside another word", () => {
    expect(maskSentence("She was running fast.", "run")).toBeNull();
  });
});

describe("validateQuizQuestion", () => {
  it("validates a well-formed 4-choice cloze question", () => {
    const res = validateQuizQuestion(
      {
        term: "put off",
        meaning: "延期する",
        level: 2,
        source: "Don't put off today's work until tomorrow.",
        translation: "今日の仕事を明日まで延期しないで。",
        surface: "put off",
        choices: ["put off", "call on", "look into", "turn down"],
        note: "put off は「先延ばしにする」",
      },
      new Set(["run out of"]),
    );
    expect(res.ok).toBe(true);
    expect(res.question?.surface).toBe("put off");
  });

  it("accepts questions without a note and keeps aligned choice meanings", () => {
    const res = validateQuizQuestion({
      term: "put off",
      meaning: "延期する",
      source: "Don't put off today's work until tomorrow.",
      translation: "今日の仕事を明日まで延期しないで。",
      surface: "put off",
      choices: ["put off", "call on", "look into", "turn down"],
      choiceMeanings: ["延期する", "訪問する", "調査する", "断る"],
    });
    expect(res.ok).toBe(true);
    expect(res.question?.note).toBe("");
    expect(res.question?.choiceMeanings).toEqual(["延期する", "訪問する", "調査する", "断る"]);
  });

  it("drops choice meanings unless there is one distinct meaning per choice", () => {
    const res = validateQuizQuestion({
      term: "put off",
      meaning: "延期する",
      source: "Don't put off today's work until tomorrow.",
      translation: "今日の仕事を明日まで延期しないで。",
      surface: "put off",
      choices: ["put off", "call on", "look into", "turn down"],
      choiceMeanings: ["延期する", "延期する", "調査する"],
    });
    expect(res.ok).toBe(true);
    expect(res.question?.choiceMeanings).toEqual([]);
  });

  it("rejects semicolons, duplicate choices, existing wordbook terms, and missing surface in source", () => {
    expect(
      validateQuizQuestion({
        term: "put off",
        meaning: "延期する",
        source: "It rained; they put off the match.",
        translation: "雨が降り、試合を延期した。",
        surface: "put off",
        choices: ["put off", "call on", "look into", "turn down"],
        note: "note",
      }).reason,
    ).toBe("semicolon_in_source");

    expect(
      validateQuizQuestion({
        term: "put off",
        meaning: "延期する",
        source: "They put off the match.",
        translation: "試合を延期した。",
        surface: "put off",
        choices: ["put off", "put off", "look into", "turn down"],
        note: "note",
      }).reason,
    ).toBe("duplicate_choices");

    expect(
      validateQuizQuestion(
        {
          term: "put off",
          meaning: "延期する",
          source: "They put off the match.",
          translation: "試合を延期した。",
          surface: "put off",
          choices: ["put off", "call on", "look into", "turn down"],
          note: "note",
        },
        new Set(["put off"]),
      ).reason,
    ).toBe("duplicate_or_existing_term");

    expect(
      validateQuizQuestion({
        term: "put off",
        meaning: "延期する",
        source: "They postponed the match.",
        translation: "試合を延期した。",
        surface: "put off",
        choices: ["put off", "call on", "look into", "turn down"],
        note: "note",
      }).reason,
    ).toBe("surface_not_in_source");
  });
});

describe("selectReferenceProfile & cameraCrop & isVocabularyCandidate", () => {
  it("samples at most 10 unmastered words first", () => {
    const words = Array.from({ length: 15 }, (_, i) => ({
      term: `word${i}`,
      meaning: `意味${i}`,
      knownCount: i < 12 ? 1 : 3,
      recallCount: i < 12 ? 0 : 3,
      targetCount: 3,
    }));
    const sample = selectReferenceProfile(words, 10, () => 0.5);
    expect(sample).toHaveLength(10);
    expect(sample.every((w) => w.known < 3)).toBe(true);
  });

  it("computes center cover crop coordinates", () => {
    const crop = cameraCrop(1920, 1080, 300, 400);
    expect(crop.height).toBe(1080);
    expect(crop.width).toBe(810);
    expect(crop.x).toBe((1920 - 810) / 2);
    expect(crop.y).toBe(0);
  });

  it("distinguishes vocabulary candidates from long full sentences", () => {
    expect(isVocabularyCandidate("run out of")).toBe(true);
    expect(isVocabularyCandidate("This is a complete sentence with punctuation.")).toBe(false);
  });
});
