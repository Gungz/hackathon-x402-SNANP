/**
 * Agent-facing CLI for VerificationOracle.
 *
 * Usage:
 *   npx tsx src/cli.ts verify --question "Did Arsenal beat Chelsea?" --criteria "Final score after 90 minutes" --yes
 *
 * `--yes` is required: it is an explicit approval to sign and submit a
 * devnet `deposit` transaction via the client keypair. The CLI prints the
 * full transaction summary before asking for `--yes`.
 */

import { verifyEvent } from "./client";

async function main() {
  const args = process.argv.slice(2);
  let question = "";
  let criteria = "";
  let yes = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--question" && args[i + 1]) {
      question = args[i + 1];
      i++;
    } else if (args[i] === "--criteria" && args[i + 1]) {
      criteria = args[i + 1];
      i++;
    } else if (args[i] === "--yes") {
      yes = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Usage: npx tsx src/cli.ts verify --question "<question>" --criteria "<criteria>" --yes

Options:
  --question  The natural-language question to verify
  --criteria  Explicit resolution criteria for the question
  --yes       Confirm you want to sign and submit a real 0.01 USDC devnet deposit
`);
      process.exit(0);
    }
  }

  if (!question || !criteria) {
    console.error("Error: Both --question and --criteria are required.");
    console.error("Run 'npx tsx src/cli.ts --help' for usage.");
    process.exit(1);
  }

  console.log(`\nVerifying: "${question}"`);
  console.log(`Criteria: "${criteria}"`);
  console.log(`Network:  Solana Devnet`);
  console.log(`Amount:   0.01 (10,000 base units) of the asset required by the server (PAYMENT-REQUIRED terms)`);
  console.log(`Destination: escrow PDA (see escrow program)\n`);

  if (!yes) {
    console.log("Transaction approval required. No transaction was signed or sent.");
    console.log("Re-run with --yes to proceed with the real payment.");
    process.exit(2);
  }

  console.log("Approved. Signing and submitting deposit…\n");

  try {
    const result = await verifyEvent(question, criteria);

    console.log("═══ Verification Complete ═══");
    console.log(`Outcome:    ${result.outcome}`);
    console.log(`Confidence: ${(result.confidence * 100).toFixed(0)}%`);
    console.log(`Proof ID:   ${result.proofId}`);
    console.log(`Timestamp:  ${result.timestamp}`);
    console.log(`Refundable: ${result.payment.refundable ? "Yes" : "No"}`);
    console.log(`Escrow:     ${result.payment.escrowStatus ?? result.escrowStatus ?? "unknown"}`);
    console.log(`Amount:     ${result.payment.amount} ${result.payment.asset} on ${result.payment.network}`);
    console.log(`PayTo:      ${result.payment.payTo}`);
    console.log(`Deposit:    ${result.payment.depositTransactionUrl ?? `https://explorer.solana.com/tx/${result.payment.depositSignature}?cluster=devnet`}`);
    if (result.evidence && result.evidence.length > 0) {
      console.log(`Evidence:   ${result.evidence.map((e: any) => e.source).join(", ")}`);
    }
    console.log("═════════════════════════════\n");
  } catch (err) {
    console.error("Verification failed:", (err as Error).message);
    process.exit(1);
  }
}

main();

