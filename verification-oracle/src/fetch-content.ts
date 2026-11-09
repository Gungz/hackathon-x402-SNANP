/**
 * TinyFish Fetch API wrapper.
 *
 * Calls POST https://api.fetch.tinyfish.ai to extract clean text content
 * from source URLs. Authenticated via X-API-Key header.
 */

import "dotenv/config";

export interface FetchedContent {
  url: string;
  title: string;
  text: string;
}

const TINYFISH_FETCH_URL = "https://api.fetch.tinyfish.ai";

/**
 * Fetch and extract content from multiple URLs using TinyFish Fetch API.
 * Returns extracted content for successfully fetched URLs.
 */
export async function fetchSourceContent(urls: string[]): Promise<FetchedContent[]> {
  const apiKey = process.env.TINYFISH_API_KEY;
  if (!apiKey) {
    console.warn("TINYFISH_API_KEY not set — returning empty fetch results");
    return [];
  }

  if (urls.length === 0) return [];

  try {
    const response = await fetch(TINYFISH_FETCH_URL, {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        urls: urls.slice(0, 5), // Limit to top 5 sources
        format: "markdown",
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      console.error(`TinyFish Fetch API error: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as {
      results?: Array<{ url: string; title?: string; text?: string }>;
    };

    return (data.results || [])
      .filter((r) => r.text)
      .map((r) => ({
        url: r.url,
        title: r.title || r.url,
        text: r.text || "",
      }));
  } catch (err) {
    console.error("TinyFish Fetch failed:", (err as Error).message);
    return [];
  }
}
