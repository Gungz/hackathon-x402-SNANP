/**
 * Mock LLM extractor for V0 demo.
 *
 * In production, this would call a real LLM (GPT-4o, Claude, etc.) to extract
 * verification outcomes from web content. For V0, we use a deterministic
 * keyword-based extractor that returns YES/NO/UNDECIDED with confidence.
 *
 * This is intentionally conservative: ambiguous content returns UNDECIDED
 * rather than guessing.
 */

export interface LLMExtractionResult {
  outcome: "YES" | "NO" | "UNDECIDED";
  confidence: number;
  reasoning: string;
}

/**
 * Extract verification outcome from content using deterministic keyword matching.
 *
 * Looks for explicit confirmation/denial language in the content.
 * Returns UNDECIDED when evidence is conflicting or absent.
 */
export function extractOutcome(
  question: string,
  criteria: string,
  contents: string[]
): LLMExtractionResult {
  const combined = contents.join(" ").toLowerCase();
  const questionLower = question.toLowerCase();
  const criteriaLower = criteria.toLowerCase();

  // Extract key entities from the question (strip punctuation)
  const questionWords = questionLower
    .split(/\s+/)
    .map((w) => w.replace(/[?.,!;:]/g, ""))
    .filter((w) => w.length > 3);

  // Count positive confirmation signals
  const confirmationSignals = [
    "yes",
    "confirmed",
    "true",
    "won",
    "victory",
    "defeats",
    "beat",
    "scored",
    "completed",
  ];
  const denialSignals = [
    "no",
    "denied",
    "false",
    "lost",
    "did not",
    "didn't",
    "cancelled",
    "postponed",
  ];

  let confirmationCount = 0;
  let denialCount = 0;

  for (const signal of confirmationSignals) {
    if (combined.includes(signal)) confirmationCount++;
  }
  for (const signal of denialSignals) {
    if (combined.includes(signal)) denialCount++;
  }

  // Check if key question entities appear in content
  const entityMatches = questionWords.filter((w) => combined.includes(w)).length;
  const entityRatio = questionWords.length > 0 ? entityMatches / questionWords.length : 0;

  // Decision logic
  if (confirmationCount > 0 && denialCount === 0 && entityRatio >= 0.5) {
    return {
      outcome: "YES",
      confidence: Math.min(0.85, 0.6 + entityRatio * 0.25),
      reasoning:
        "Content contains confirmation signals matching the question criteria with no denial signals.",
    };
  }

  if (denialCount > 0 && confirmationCount === 0 && entityRatio >= 0.5) {
    return {
      outcome: "NO",
      confidence: Math.min(0.85, 0.6 + entityRatio * 0.25),
      reasoning:
        "Content contains denial signals matching the question criteria with no confirmation signals.",
    };
  }

  // Conflicting or insufficient evidence
  return {
    outcome: "UNDECIDED",
    confidence: 0.5,
    reasoning: "Evidence is conflicting, ambiguous, or insufficient to determine outcome.",
  };
}

/**
 * Extract outcome from parsed source results.
 * Combines deterministic parser results with LLM extraction as fallback.
 */
export function extractFromSources(
  question: string,
  criteria: string,
  parsedResults: Array<{ domain: string; content: string }>
): LLMExtractionResult {
  if (parsedResults.length === 0) {
    return {
      outcome: "UNDECIDED",
      confidence: 0.0,
      reasoning: "No sources available for verification.",
    };
  }

  const contents = parsedResults.map((r) => r.content);
  return extractOutcome(question, criteria, contents);
}
