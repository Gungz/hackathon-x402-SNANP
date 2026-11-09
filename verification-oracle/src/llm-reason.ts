/**
 * Groq LLM reasoning module with Gemini fallback.
 *
 * Calls Groq API (OpenAI-compatible) with the question, resolution criteria,
 * and fetched evidence to produce YES / NO / UNDECIDED with confidence.
 * Falls back to Gemini API if Groq rate-limits.
 */

import "dotenv/config";

export interface LLMReasoningResult {
  outcome: "YES" | "NO" | "UNDECIDED";
  confidence: number;
  reasoning: string;
  provider: "groq" | "gemini";
}

export interface EvidenceContent {
  url: string;
  title: string;
  text: string;
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "openai/gpt-oss-120b";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";

/**
 * Build the prompt for the LLM to reason about the verification outcome.
 */
function buildPrompt(question: string, criteria: string, evidence: EvidenceContent[]): string {
  const evidenceText = evidence
    .map((e, i) => `Source ${i + 1}: ${e.title}\nURL: ${e.url}\nContent:\n${e.text.slice(0, 3000)}`)
    .join("\n\n---\n\n");

  return `You are an autonomous verification oracle. Analyze the following question and resolution criteria against the provided evidence sources.

QUESTION: ${question}
RESOLUTION CRITERIA: ${criteria}

EVIDENCE SOURCES:
${evidenceText || "(No evidence sources available)"}

Instructions:
1. Analyze whether the evidence confirms or refutes the question based on the resolution criteria.
2. If evidence clearly supports the event occurred, return YES.
3. If evidence clearly shows the event did not occur, return NO.
4. If evidence is conflicting, insufficient, or ambiguous, return UNDECIDED.
5. Provide a confidence score between 0.0 and 1.0.
6. Explain your reasoning briefly.

Respond with valid JSON only (no markdown, no code fences):
{
  "outcome": "YES" | "NO" | "UNDECIDED",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}`;
}

/**
 * Parse the LLM response to extract outcome, confidence, and reasoning.
 */
function parseLLMResponse(text: string): { outcome: string; confidence: number; reasoning: string } | null {
  try {
    // Strip any markdown code fences if present
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (["YES", "NO", "UNDECIDED"].includes(parsed.outcome)) {
      return {
        outcome: parsed.outcome,
        confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
        reasoning: parsed.reasoning || "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Call Groq API for LLM reasoning.
 */
async function reasonWithGroq(prompt: string): Promise<{ outcome: string; confidence: number; reasoning: string } | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a verification oracle. Always respond with valid JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.1,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (response.status === 429) {
      console.warn("Groq rate limited — falling back to Gemini");
      return null;
    }

    if (!response.ok) {
      console.error(`Groq API error: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    return parseLLMResponse(content);
  } catch (err) {
    console.error("Groq reasoning failed:", (err as Error).message);
    return null;
  }
}

/**
 * Call Gemini API as fallback when Groq is unavailable.
 */
async function reasonWithGemini(prompt: string): Promise<{ outcome: string; confidence: number; reasoning: string } | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 500,
        },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.error(`Gemini API error: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) return null;

    return parseLLMResponse(content);
  } catch (err) {
    console.error("Gemini reasoning failed:", (err as Error).message);
    return null;
  }
}

/**
 * Reason about verification outcome using Groq with Gemini fallback.
 * Applies confidence threshold: if confidence < 0.5, forces UNDECIDED.
 */
export async function reasonAboutOutcome(
  question: string,
  criteria: string,
  evidence: EvidenceContent[]
): Promise<LLMReasoningResult> {
  const prompt = buildPrompt(question, criteria, evidence);

  // Try Groq first
  let result = await reasonWithGroq(prompt);
  let provider: "groq" | "gemini" = "groq";

  // Fall back to Gemini if Groq failed
  if (!result) {
    result = await reasonWithGemini(prompt);
    provider = "gemini";
  }

  // If both failed, return UNDECIDED
  if (!result) {
    return {
      outcome: "UNDECIDED",
      confidence: 0,
      reasoning: "LLM providers unavailable — unable to determine outcome.",
      provider: "gemini",
    };
  }

  // Apply confidence threshold
  if (result.confidence < 0.5) {
    return {
      outcome: "UNDECIDED",
      confidence: result.confidence,
      reasoning: `Confidence below threshold (0.5): ${result.reasoning}`,
      provider,
    };
  }

  return {
    outcome: result.outcome as "YES" | "NO" | "UNDECIDED",
    confidence: result.confidence,
    reasoning: result.reasoning,
    provider,
  };
}
