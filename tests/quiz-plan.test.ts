import { describe, expect, it } from "vitest";
import { belowLevel, meaningsOverlap, validateQuizPlanItem } from "../src/shared/quiz-plan";

const item = (distractors: Array<{ term: string; meaning: string }>, term = "postpone", meaning = "延期する") => ({
  term,
  meaning,
  pos: "verb",
  distractors,
});

describe("validateQuizPlanItem", () => {
  it("accepts clearly different options", () => {
    const result = validateQuizPlanItem(
      item([
        { term: "borrow", meaning: "借りる" },
        { term: "praise", meaning: "褒める" },
        { term: "deliver", meaning: "配達する" },
      ]),
      "q1",
      new Set(),
    );
    expect(result?.distractors).toHaveLength(3);
  });

  it("rejects alert/warning style near-synonyms", () => {
    expect(
      validateQuizPlanItem(
        item(
          [
            { term: "warning", meaning: "警告" },
            { term: "harvest", meaning: "収穫" },
            { term: "ladder", meaning: "はしご" },
          ],
          "alert",
          "警戒",
        ),
        "q1",
        new Set(),
      ),
    ).toBeNull();
  });

  it("rejects known synonym pairs even with unrelated meanings", () => {
    expect(
      validateQuizPlanItem(
        item(
          [
            { term: "verify", meaning: "立証" },
            { term: "harvest", meaning: "収穫" },
            { term: "ladder", meaning: "はしご" },
          ],
          "check",
          "確かめる",
        ),
        "q1",
        new Set(),
      ),
    ).toBeNull();
  });

  it("rejects wordbook terms and incomplete distractors", () => {
    const distractors = [
      { term: "borrow", meaning: "借りる" },
      { term: "praise", meaning: "褒める" },
      { term: "deliver", meaning: "配達する" },
    ];
    expect(validateQuizPlanItem(item(distractors), "q1", new Set(["postpone"]))).toBeNull();
    expect(validateQuizPlanItem(item(distractors.slice(0, 2)), "q1", new Set())).toBeNull();
  });
});

describe("meaningsOverlap", () => {
  it("flags shared kanji and containment", () => {
    expect(meaningsOverlap("警戒", "警告")).toBe(true);
    expect(meaningsOverlap("延期する", "延期")).toBe(true);
    expect(meaningsOverlap("借りる", "褒める")).toBe(false);
  });
});

describe("level filtering", () => {
  const distractors = [
    { term: "borrow", meaning: "借りる" },
    { term: "praise", meaning: "褒める" },
    { term: "deliver", meaning: "配達する" },
  ];

  it("drops words the model rates below the learner's CEFR level", () => {
    const easy = { ...item(distractors, "count", "数える"), cefr: "A1" };
    expect(validateQuizPlanItem(easy, "q1", new Set(), "B2")).toBeNull();
    const fit = { ...item(distractors, "reimburse", "払い戻す"), cefr: "B2" };
    expect(validateQuizPlanItem(fit, "q1", new Set(), "B2")?.term).toBe("reimburse");
  });

  it("does not treat a missing rating as too easy", () => {
    expect(belowLevel("", "B2")).toBe(false);
    expect(belowLevel("b1", "B2")).toBe(true);
    expect(belowLevel("C1+", "B2")).toBe(false);
  });
});
