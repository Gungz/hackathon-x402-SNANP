import { test, describe } from "node:test";
import assert from "node:assert";
import { fetchSourceContent } from "../../src/fetch-content";

describe("fetchSourceContent", () => {
  test("returns extracted content on success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any) => {
      if (String(url).includes("api.fetch.tinyfish.ai")) {
        return new Response(
          JSON.stringify({
            results: [
              { url: "https://espn.com/game", title: "Game Result", text: "Arsenal 5-0 Chelsea final score" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ) as Response;
      }
      return originalFetch(url);
    };

    const content = await fetchSourceContent(["https://espn.com/game"]);
    assert.equal(content.length, 1);
    assert.equal(content[0].text, "Arsenal 5-0 Chelsea final score");

    globalThis.fetch = originalFetch;
  });

  test("returns empty array on API error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("error", { status: 500 }) as Response;

    const content = await fetchSourceContent(["https://example.com"]);
    assert.deepEqual(content, []);

    globalThis.fetch = originalFetch;
  });

  test("returns empty for empty URL list", async () => {
    const content = await fetchSourceContent([]);
    assert.deepEqual(content, []);
  });
});
