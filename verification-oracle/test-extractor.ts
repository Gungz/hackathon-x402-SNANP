import { extractOutcome, extractFromSources } from "./src/llm-extractor";

const r1 = extractOutcome(
  "Did Arsenal beat Chelsea?",
  "Final score after 90 minutes",
  ["Arsenal confirmed victory over Chelsea with a 2-1 final score."]
);
console.log("Test 1 (YES):", JSON.stringify(r1));

const r2 = extractOutcome(
  "Did Arsenal beat Chelsea?",
  "Final score after 90 minutes",
  ["Arsenal did not beat Chelsea; the match ended in a draw."]
);
console.log("Test 2 (NO):", JSON.stringify(r2));

const r3 = extractOutcome(
  "Did Arsenal beat Chelsea?",
  "Final score after 90 minutes",
  ["Arsenal won the match.", "Chelsea denies defeat and claims the result is disputed."]
);
console.log("Test 3 (UNDECIDED):", JSON.stringify(r3));

const r4 = extractFromSources("Test?", "Criteria", []);
console.log("Test 4 (no sources):", JSON.stringify(r4));
