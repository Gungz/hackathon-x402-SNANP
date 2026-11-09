import { test, describe } from "node:test";
import assert from "node:assert";
import { searchTinyFish } from "../../src/search";

describe("searchTinyFish", () => {
  test("returns results array on success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any) => {
      if (String(url).includes("api.search.tinyfish.ai")) {
        return new Response(
          JSON.stringify({
            results: [{ title: "Test", url: "https://example.com", snippet: "test" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ) as Response;
      }
      return originalFetch(url);
    };

    const results = await searchTinyFish("test question");
    assert.equal(results.length, 1);
    assert.equal(results[0].url, "https://example.com");

    globalThis.fetch = originalFetch;
  });

  test("returns empty array on API error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("error", { status: 500 }) as Response;

    const results = await searchTinyFish("test");
    assert.deepEqual(results, []);

    globalThis.fetch = originalFetch;
  });

  test("returns empty array when TINYFISH_API_KEY missing", async () => {
    const originalKey = process.env.TINYFISH_API_KEY;
    delete process.env.TINYFISH_API_KEY;

    const results = await searchTinyFish("test");
    assert.deepEqual(results, []);

    process.env.TINYFISH_API_KEY = originalKey;
  });
});
