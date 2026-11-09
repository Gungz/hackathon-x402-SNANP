/**
 * Seed script for VerificationOracle V0 demo.
 *
 * Runs three preset demo questions through the verification API
 * to demonstrate the end-to-end flow with real TinyFish + Groq verification.
 *
 * Requirements: server running on port 4021 (npm run dev)
 *
 * Run: npx tsx scripts/seed.ts
 */

import { verifyEvent } from "../src/client";

const DEMO_QUESTIONS = [
  {
    question: "Did Arsenal beat Chelsea in their April 2024 Premier League match?",
    criteria: "Final score after 90 minutes from official match reports",
  },
  {
    question: "Did the price of Bitcoin exceed $100,000 at any point in March 2026?",
    criteria: "Closing price above $100,000 on any day in March 2026",
  },
  {
    question: "Was the total solar eclipse visible across parts of North America in April 2024?",
    criteria: "Official NASA or NOAA confirmation of visibility over North America",
  },
];

async function main() {
  console.log("═══ VerificationOracle V0 — Demo Seed ═══\n");

  for (let i = 0; i < DEMO_QUESTIONS.length; i++) {
    const { question, criteria } = DEMO_QUESTIONS[i];
    console.log(`\nDemo ${i + 1}: ${question}`);
    console.log(`Criteria: ${criteria}`);
    console.log("─".repeat(60));

    try {
      const result = await verifyEvent(question, criteria);
      console.log(`Outcome:  ${result.outcome}`);
      console.log(`Conf:     ${((result.confidence || 0) * 100).toFixed(0)}%`);
      console.log(`Proof ID: ${result.proofId}`);
      console.log(`Refund:   ${result.refundable ? "Yes" : "No"}`);
      console.log(`LLM:      ${result.llmProvider || "unknown"}`);
      if (result.reasoning) {
        console.log(`Reasoning: ${result.reasoning}`);
      }
      if (Array.isArray(result.evidence) && result.evidence.length > 0) {
        result.evidence.forEach((e: any) => {
          console.log(`Evidence: ${e.title ?? e.url}`);
          console.log(`          ${e.url ?? e.source}`);
        });
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
    }
  }

  console.log("\n═══ Demo seed complete ═══");
}

main();
