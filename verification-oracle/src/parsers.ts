/**
 * Deterministic parsers for allowlisted sports sources.
 *
 * These parsers extract structured match results from known HTML patterns
 * without using an LLM. They are cheap, fast, and deterministic — ideal for
 * micro-fee verification where cost and predictability matter.
 *
 * Each parser takes raw HTML content and returns a normalized result or null
 * if the pattern doesn't match.
 */

export interface ParsedResult {
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  status: "final" | "live" | "postponed" | "cancelled";
  confidence: number;
}

/**
 * Parser for sports.example.com — expects HTML like:
 *   <div class="score">Arsenal 2 - 1 Chelsea</div>
 *   <span class="status">Final</span>
 */
export function parseSportsExampleCom(html: string): ParsedResult | null {
  const scoreMatch = html.match(/([A-Za-z\s]+)\s+(\d+)\s*-\s*(\d+)\s+([A-Za-z\s]+)/i);
  const statusMatch = html.match(/class="status">\s*(Final|Live|Postponed|Cancelled)\s*</i);

  if (!scoreMatch) return null;

  const homeTeam = scoreMatch[1].trim();
  const homeScore = parseInt(scoreMatch[2], 10);
  const awayScore = parseInt(scoreMatch[3], 10);
  const awayTeam = scoreMatch[4].trim();

  const statusText = statusMatch?.[1]?.toLowerCase() || "final";
  let status: ParsedResult["status"] = "final";
  if (statusText === "live") status = "live";
  else if (statusText === "postponed") status = "postponed";
  else if (statusText === "cancelled") status = "cancelled";

  return {
    homeTeam,
    awayTeam,
    homeScore,
    awayScore,
    status,
    confidence: 0.95,
  };
}

/**
 * Parser for news.example.com — expects HTML like:
 *   <h1>Match Result: Arsenal defeats Chelsea 2-1</h1>
 *   <div class="match-status">Completed</div>
 */
export function parseNewsExampleCom(html: string): ParsedResult | null {
  const resultMatch = html.match(/([A-Za-z\s]+)\s+(?:defeats|beats|wins|draws?)\s+([A-Za-z\s]+)\s+(\d+)[-:](\d+)/i);

  if (!resultMatch) return null;

  const winner = resultMatch[1].trim();
  const loser = resultMatch[2].trim();
  const winnerScore = parseInt(resultMatch[3], 10);
  const loserScore = parseInt(resultMatch[4], 10);

  // Determine home/away based on order in headline
  return {
    homeTeam: winner,
    awayTeam: loser,
    homeScore: winnerScore,
    awayScore: loserScore,
    status: "final",
    confidence: 0.90,
  };
}

/**
 * Registry of domain → parser function.
 * Add new domains here as they are allowlisted.
 */
export const PARSERS: Record<string, (html: string) => ParsedResult | null> = {
  "sports.example.com": parseSportsExampleCom,
  "news.example.com": parseNewsExampleCom,
};

/**
 * Parse HTML content using the domain-specific parser.
 * Returns null if no parser exists for the domain or parsing fails.
 */
export function parseSource(domain: string, html: string): ParsedResult | null {
  const parser = PARSERS[domain.toLowerCase()];
  if (!parser) return null;
  return parser(html);
}
