import { test, describe } from "node:test";
import assert from "node:assert";
import { reasonAboutOutcome } from "../../src/llm-reason";

describe("reasonAboutOutcome", () => {
  test("returns YES when Groq confirms", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async (url: any) => {
      callCount++;
      if (String(url).includes("groq.com")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"outcome":"YES","confidence":0.9,"reasoning":"Confirmed"}' } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ) as Response;
      }
      return originalFetch(url);
    };

    const result = await reasonAboutOutcome("Q?", "criteria", [
      { url: "https://espn.com/game", title: "Result", text: "Arsenal 2-0 Chelsea" },
    ]);
    assert.equal(result.outcome, "YES");
    assert.equal(result.confidence, 0.9);
    assert.equal(result.provider, "groq");

    globalThis.fetch = originalFetch;
  });

  test("falls back to Gemini when Groq returns 429", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any) => {
      if (String(url).includes("groq.com")) {
        return new Response("rate limited", { status: 429 }) as Response;
      }
      if (String(url).includes("googleapis.com")) {
        return new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: '{"outcome":"NO","confidence":0.8,"reasoning":"Denied"}' }] } },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ) as Response;
      }
      return originalFetch(url);
    };

    const result = await reasonAboutOutcome("Q?", "criteria", [
      { url: "https://espn.com/game", title: "Result", text: "Chelsea won" },
    ]);
    assert.equal(result.outcome, "NO");
    assert.equal(result.provider, "gemini");

    globalThis.fetch = originalFetch;
  });

  test("returns UNDECIDED when confidence below threshold", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any) => {
      if (String(url).includes("groq.com")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"outcome":"YES","confidence":0.3,"reasoning":"Unsure"}' } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ) as Response;
      }
      return originalFetch(url);
    };

    const result = await reasonAboutOutcome("Q?", "criteria", [
      { url: "https://espn.com/game", title: "Result", text: "unclear" },
    ]);
    assert.equal(result.outcome, "UNDECIDED");
    assert.equal(result.confidence, 0.3);

    globalThis.fetch = originalFetch;
  });

  test("returns UNDECIDED when both providers fail", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("unavailable", { status: 500 }) as Response;

    const result = await reasonAboutOutcome("Q?", "criteria", []);
    assert.equal(result.outcome, "UNDECIDED");
    assert.equal(result.confidence, 0);

    globalThis.fetch = originalFetch;
  });
});
