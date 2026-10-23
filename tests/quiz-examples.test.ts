import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv, Env } from "../src/worker/env";
import { wordRoutes } from "../src/worker/routes/words";

/** Minimal env: the AI returns `reply` as chat content; the cache always misses. */
function harness(reply: unknown) {
  const db = {
    prepare: () => {
      const statement = {
        bind: () => statement,
        first: async () => null,
        run: async () => ({}),
        all: async () => ({ results: [] }),
      };
      return statement;
    },
  };
  const env = {
    AI: { run: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) },
    DB: db,
  } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.route("/api", wordRoutes);
  return (items: Array<{ id: string; term: string }>) =>
    app.request(
      "https://app.example/api/review/ai-examples",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "card", learnerLevel: "800", items }),
      },
      env,
    );
}

describe("POST /api/review/ai-examples", () => {
  it("recovers a sentence the model put in surface (seen in production)", async () => {
    const post = harness({
      items: [
        {
          id: "q1",
          surface: "The company will reimburse employees for travel expenses.",
          source: "",
          translation: "会社は従業員の出張費用を補償します。",
          choices: [],
        },
      ],
    });
    const response = await post([{ id: "q1", term: "reimburse" }]);
    const body = (await response.json()) as { items: Array<{ source: string; surface: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].source).toBe("The company will reimburse employees for travel expenses.");
    expect(body.items[0].surface).toBe("reimburse");
  });

  it("takes the inflected spelling from the sentence", async () => {
    const post = harness({
      items: [{ id: "q1", surface: "reimburse", source: "They reimbursed my costs.", translation: "訳", choices: [] }],
    });
    const body = (await (await post([{ id: "q1", term: "reimburse" }])).json()) as {
      items: Array<{ surface: string }>;
    };
    expect(body.items[0].surface).toBe("reimbursed");
  });
});
