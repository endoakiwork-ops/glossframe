import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiQuizQuestion } from "../src/shared/types";
import type { Env } from "../src/worker/env";

const { runJsonModelMock } = vi.hoisted(() => ({
  runJsonModelMock: vi.fn(),
}));

vi.mock("../src/worker/ai", () => ({
  runJsonModel: runJsonModelMock,
}));

import { filterUnambiguousQuestions } from "../src/worker/quiz-quality";

const env = {} as Env;

function question(id: string, overrides: Partial<AiQuizQuestion> = {}): AiQuizQuestion {
  return {
    id,
    term: "check",
    meaning: "確認する",
    source: "Please check the form before submitting.",
    translation: "送信する前にフォームを確認してください。",
    surface: "check",
    choices: ["check", "verify", "inspect", "examine"],
    note: "",
    ...overrides,
  };
}

function verdicts(value: Array<{ id: string; valid: boolean }>) {
  return { value: { verdicts: value }, cached: false, model: "mock" };
}

describe("filterUnambiguousQuestions", () => {
  beforeEach(() => {
    runJsonModelMock.mockReset();
  });

  it("keeps only questions with a valid verdict and preserves order", async () => {
    runJsonModelMock.mockResolvedValueOnce(
      verdicts([
        { id: "q1", valid: true },
        { id: "q2", valid: false },
        { id: "q3", valid: true },
      ]),
    );

    const result = await filterUnambiguousQuestions(env, [
      question("q1", { choices: ["check", "eat", "sleep", "drive"] }),
      question("q2"),
      question("q3", { choices: ["check", "eat", "sleep", "drive"] }),
    ]);

    expect(result.map((item) => item.id)).toEqual(["q1", "q3"]);
    expect(runJsonModelMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a verdict id is missing", async () => {
    runJsonModelMock.mockResolvedValueOnce(
      verdicts([
        { id: "q1", valid: true },
        { id: "q2", valid: true },
      ]),
    );

    const result = await filterUnambiguousQuestions(env, [
      question("q1"),
      question("q2"),
      question("q3"),
    ]);

    expect(result).toEqual([]);
  });

  it("fails closed when a verdict id is duplicated", async () => {
    runJsonModelMock.mockResolvedValueOnce(
      verdicts([
        { id: "q1", valid: true },
        { id: "q1", valid: true },
      ]),
    );

    const result = await filterUnambiguousQuestions(env, [question("q1"), question("q2")]);

    expect(result).toEqual([]);
  });

  it("fails closed when the critic returns an unknown id", async () => {
    runJsonModelMock.mockResolvedValueOnce(
      verdicts([
        { id: "q1", valid: true },
        { id: "other", valid: true },
      ]),
    );

    const result = await filterUnambiguousQuestions(env, [question("q1"), question("q2")]);

    expect(result).toEqual([]);
  });

  it("fails closed when the critic call fails", async () => {
    runJsonModelMock.mockRejectedValueOnce(new Error("model unavailable"));

    const result = await filterUnambiguousQuestions(env, [question("q1")]);

    expect(result).toEqual([]);
  });

  it("rejects the ambiguous check/verify/inspect/examine example", async () => {
    runJsonModelMock.mockImplementationOnce(async (_env, options) => {
      const payload = JSON.parse(options.user) as {
        questions: Array<{ id: string; choices: string[] }>;
      };
      expect(payload.questions[0].choices).toEqual(["check", "verify", "inspect", "examine"]);
      return verdicts([{ id: "q1", valid: false }]);
    });

    const result = await filterUnambiguousQuestions(env, [question("q1")]);

    expect(result).toEqual([]);
  });

  it("does not call the critic for an empty question list", async () => {
    const result = await filterUnambiguousQuestions(env, []);

    expect(result).toEqual([]);
    expect(runJsonModelMock).not.toHaveBeenCalled();
  });
  it("rejects known interchangeable alternatives even if the critic approves", async () => {
    runJsonModelMock.mockResolvedValueOnce(verdicts([{id:"q1",valid:true}]));
    expect(await filterUnambiguousQuestions(env,[question("q1")])).toEqual([]);
  });
});
