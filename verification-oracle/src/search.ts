/**
 * TinyFish Search API wrapper.
 *
 * Calls GET https://api.search.tinyfish.ai with the verification question
 * to retrieve ranked web results. Authenticated via X-API-Key header.
 */

import "dotenv/config";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  totalResults: number;
}

const TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";

/**
 * Search the web using TinyFish Search API.
 * Returns ranked results or empty array on failure.
 */
export async function searchTinyFish(
  query: string,
  purpose?: string
): Promise<SearchResult[]> {
  const apiKey = process.env.TINYFISH_API_KEY;
  if (!apiKey) {
    console.warn("TINYFISH_API_KEY not set — returning empty search results");
    return [];
  }

  try {
    const params = new URLSearchParams({ query });
    if (purpose) params.set("purpose", purpose);

    const response = await fetch(`${TINYFISH_SEARCH_URL}?${params}`, {
      headers: {
        "X-API-Key": apiKey,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.error(`TinyFish Search API error: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as { results?: SearchResult[] };
    return data.results || [];
  } catch (err) {
    console.error("TinyFish Search failed:", (err as Error).message);
    return [];
  }
}
