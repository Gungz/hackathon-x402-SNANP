import express from "express";
import * as path from "path";
import "dotenv/config";
import { searchTinyFish } from "./search";
import { fetchSourceContent } from "./fetch-content";
import { reasonAboutOutcome, LLMReasoningResult } from "./llm-reason";
import { appendProof } from "./proofs";
import { ALLOWED_DOMAINS, isDomainAllowed, isUrlAllowed } from "./allowlist";
import { verifyPaymentOnChain, verifySettlementOnChain, deriveEscrowPdaAddress, fetchEscrowAccountClosed, USDC_DEVNET_MINT } from "./payment-verify";
import { loadEscrowRecords, saveEscrowRecords, type EscrowRecordStored } from "./escrow-store";

const network = process.env.X402_NETWORK || "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const priceUsd = process.env.X402_PRICE_USD || "0.01";
const escrowProgramId = (process.env.ESCROW_PROGRAM_ID?.trim().replace(/[.]+$/, "")) || "";

// USDC on Solana Devnet has 6 decimals
const USDC_DECIMALS = 6;
const amountBaseUnits = Math.round(parseFloat(priceUsd) * 10 ** USDC_DECIMALS).toString();

// Settled payment payloads — replay protection (synchronous, prevents TOCTOU)
const settledPayments = new Set<string>();
const pendingVerifications = new Set<string>();

// Escrow settlement records — persisted to disk so pending state survives restarts
type EscrowRecord = EscrowRecordStored;
let escrowRecords: EscrowRecord[] = loadEscrowRecords();

function settleRecord(proofId: string, status: "claimed" | "refunded"): void {
  const idx = escrowRecords.findIndex((r) => r.proofId === proofId);
  if (idx < 0) return;
  escrowRecords[idx] = { ...escrowRecords[idx], status };
  saveEscrowRecords(escrowRecords);
}


const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

/**
 * The oracle operator wallet that receives escrow claims.
 * Hard-fails when unset — advertising a placeholder payment destination would
 * lock users' funds to an address nobody can claim.
 */
function payToAddress(): string {
  const payTo = process.env.SOLANA_PAY_TO?.trim().replace(/[.]+$/, "");
  if (!payTo) {
    throw new Error(
      "SOLANA_PAY_TO is not set — refusing to advertise a payment destination. Set it in .env"
    );
  }
  return payTo;
}

function buildPaymentRequired(): string {
  const paymentRequired = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network,
        payTo: payToAddress(),
        amount: amountBaseUnits,
        asset: USDC_DEVNET_MINT,
        maxTimeoutSeconds: 3600,
        description: "Event verification — pay per verified fact",
        mimeType: "application/json",
      },
    ],
  };
  return Buffer.from(JSON.stringify(paymentRequired)).toString("base64");
}

// Middleware: payment required for POST /verify — verifies the deposit on-chain
async function requirePayment(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.path === "/verify" && req.method === "POST") {
    const paymentSig = req.headers["payment-signature"];
    if (!paymentSig) {
      res.set("PAYMENT-REQUIRED", buildPaymentRequired());
      res.status(402).json({
        x402Version: 2,
        error: "payment_required",
        message: "x402 payment required before verification — sign and submit a real deposit transaction first",
        accepts: [
          {
            scheme: "exact",
            network,
            payTo: payToAddress(),
            amount: amountBaseUnits,
            asset: USDC_DEVNET_MINT,
            maxTimeoutSeconds: 3600,
          },
        ],
      });
      return;
    }

    const sigValue = Array.isArray(paymentSig) ? paymentSig[0] : paymentSig;

    // Replay protection — check synchronously before any async work (TOCTOU-safe)
    if (settledPayments.has(sigValue) || pendingVerifications.has(sigValue)) {
      res.status(402).json({
        x402Version: 2,
        error: "payment_replay",
        message: "This transaction has already been used as payment. Replay is not allowed.",
      });
      return;
    }

    // Reserve the signature synchronously to block concurrent duplicate submissions
    pendingVerifications.add(sigValue);

    // Verify the deposit transaction on-chain
    let verification;
    try {
      verification = await verifyPaymentOnChain(sigValue, BigInt(amountBaseUnits), payToAddress());
    } catch (err) {
      pendingVerifications.delete(sigValue);
      throw err;
    }

    if (!verification.ok) {
      pendingVerifications.delete(sigValue);
      res.status(402).json({
        x402Version: 2,
        error: "payment_invalid",
        message: `Payment transaction failed verification: ${verification.reason}`,
      });
      return;
    }

    pendingVerifications.delete(sigValue);
    settledPayments.add(sigValue);
    (req as any).paymentSignature = sigValue;
    (req as any).depositor = verification.depositor;
    (req as any).escrowPda = verification.escrowPda ?? null;
    next();
    return;
  }
  next();
}

app.use((req, res, next) => requirePayment(req, res, next).catch((err) => {
  console.error("Payment middleware error:", err);
  res.status(500).json({ error: "internal_error", message: "Payment verification failed" });
}));

app.post("/verify", async (req, res) => {
  const { question, criteria } = req.body as {
    question: string;
    criteria: string;
  };

  // ── Step 1: TinyFish Search ──
  const searchResults = await searchTinyFish(
    question,
    "Find authoritative sources to verify a real-world event for a prediction market oracle"
  );

  // Filter to allowlisted domains
  const filteredResults = searchResults.filter((r) => isUrlAllowed(r.url));

  // ── Step 2: TinyFish Fetch (extract content from top sources) ──
  const evidenceContent = await fetchSourceContent(
    filteredResults.slice(0, 3).map((r) => r.url)
  );

  // ── Step 3: Groq LLM Reasoning (with Gemini fallback) ──
  const llmResult = await reasonAboutOutcome(question, criteria, evidenceContent);

  // ── Step 4: Build Truth Receipt ──
  const proofId = `${Date.now()}-${Buffer.from(question + criteria).toString("base64").slice(0, 12)}`;
  const timestamp = new Date().toISOString();
  const escrowStatus = llmResult.outcome === "UNDECIDED" ? "refundable" : "claimable";

  // Extract the depositor verified on-chain during payment validation
  const paymentSignature = (req as any).paymentSignature as string | undefined;
  const depositor = (req as any).depositor as string | null;
  const escrowPda = (req as any).escrowPda as string | null;
  escrowRecords.push({
    proofId,
    status: escrowStatus as "claimable" | "refundable",
    amount: amountBaseUnits,
    clientWallet: depositor ?? payToAddress(),
    depositor,
    escrowPda,
    depositSignature: paymentSignature,
    timestamp,
  });
  saveEscrowRecords(escrowRecords);

  const paymentResponse = {
    x402Version: 2,
    success: true,
    network,
    payTo: payToAddress(),
    amount: amountBaseUnits,
    asset: USDC_DEVNET_MINT,
    refundable: llmResult.outcome === "UNDECIDED",
    escrowStatus,
    depositSignature: paymentSignature,
    depositor,
    depositTransactionUrl: `https://explorer.solana.com/tx/${paymentSignature}?cluster=devnet`,
  };

  const truthReceipt = {
    outcome: llmResult.outcome,
    confidence: llmResult.confidence,
    evidence: evidenceContent.map((e) => ({
      source: new URL(e.url).hostname,
      url: e.url,
      title: e.title,
      excerpt: e.text.slice(0, 200),
    })),
    proofId,
    payment: paymentResponse,
    timestamp,
    escrowStatus,
    llmProvider: llmResult.provider,
    reasoning: llmResult.reasoning,
  };

  // Append to proof history
  try {
    appendProof({
      proofId,
      timestamp,
      question,
      criteria,
      outcome: llmResult.outcome,
      confidence: llmResult.confidence,
      refundable: llmResult.outcome === "UNDECIDED",
      evidenceCount: evidenceContent.length,
      payment: {
        network: paymentResponse.network,
        payTo: paymentResponse.payTo,
        amount: paymentResponse.amount,
        asset: paymentResponse.asset,
        refundable: paymentResponse.refundable,
      },
    });
  } catch {
    // Non-fatal
  }

  res.set("PAYMENT-RESPONSE", Buffer.from(JSON.stringify(paymentResponse)).toString("base64"));
  res.json({
    status: "ok",
    message: "Verification complete",
    x402Version: 2,
    ...truthReceipt,
    allowedDomains: ALLOWED_DOMAINS,
  });
});

// ── Escrow endpoints ──

// Reconcile pending records against chain: if the record's escrow PDA is
// closed, the settlement (claim or refund) already happened — flip the record
// so the dashboard's pending list stays truthful across restarts and real settlements.
async function reconcilePendingRecords(): Promise<void> {
  for (const r of escrowRecords) {
    if (r.status !== "claimable" && r.status !== "refundable") continue;
    const pda = r.escrowPda ?? (r.depositor ? await deriveEscrowPdaAddress(r.depositor) : null);
    if (!pda) continue;
    if (await fetchEscrowAccountClosed(pda)) {
      const settled = r.status === "claimable" ? "claimed" : "refunded";
      r.status = settled;
      saveEscrowRecords(escrowRecords);
    }
  }
}

app.get("/escrow/pending", async (_req, res) => {
  await reconcilePendingRecords();
  const pending = escrowRecords.filter(
    (r) => r.status === "claimable" || r.status === "refundable"
  );
  res.json({
    pending,
    total: pending.length,
    escrowProgramId: escrowProgramId || "not_deployed",
  });
});

app.post("/escrow/:proofId/claim", (req, res) => {
  handleSettlement(req, res, "claim");
});

app.post("/escrow/:proofId/refund", (req, res) => {
  handleSettlement(req, res, "refund");
});

/**
 * Mark a claim/refund settlement as done — but only when the caller proves the
 * settlement transaction really landed on-chain. The wallet-signed dashboard
 * flow moves the tokens; this endpoint reconciles server-side bookkeeping.
 */
async function handleSettlement(
  req: express.Request,
  res: express.Response,
  kind: "claim" | "refund"
) {
  const record = escrowRecords.find((r) => r.proofId === req.params.proofId);
  if (!record) {
    res.status(404).json({ error: "not_found", message: "Escrow record not found" });
    return;
  }
  const expectedStatus = kind === "claim" ? "claimable" : "refundable";
  if (record.status !== expectedStatus) {
    res.status(400).json({ error: `not_${kind}able`, message: `Escrow status is ${record.status}` });
    return;
  }
  if (!record.depositor) {
    res.status(400).json({ error: "invalid_depositor", message: "Record has no depositor on-chain" });
    return;
  }

  const signature = (req.body as any)?.signature;
  if (typeof signature !== "string" || signature.length === 0) {
    res.status(400).json({
      error: "signature_required",
      message: `Provide the settlement transaction signature — verify on-chain before marking this record ${kind}ed`,
    });
    return;
  }

  const check = await verifySettlementOnChain(kind, signature, record.depositor, payToAddress(), record.escrowPda ?? null);
  if (!check.ok) {
    res.status(402).json({
      error: "settlement_invalid",
      message: `Settlement transaction failed verification: ${check.reason}`,
    });
    return;
  }

  settleRecord(record.proofId, kind === "claim" ? "claimed" : "refunded");
  const updated = escrowRecords.find((r) => r.proofId === record.proofId);
  res.json({ success: true, proofId: record.proofId, status: updated?.status });
}

app.get("/", (_req, res) => {
  res.json({
    service: "VerificationOracle",
    version: "1.0.0",
    endpoint: "POST /verify",
    payment: "x402 V2 on Solana Devnet USDC",
    escrow: escrowProgramId || "not_deployed",
    allowedDomains: ALLOWED_DOMAINS,
  });
});

// Only start listening when run directly (not when imported by tests)
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  const PORT = parseInt(process.env.PORT || "4021", 10);
  try {
    payToAddress();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  app.listen(PORT, () => {
  console.log(`VerificationOracle x402 resource server listening on http://127.0.0.1:${PORT}`);
  console.log(`Network: ${network}`);
  console.log(`PayTo: ${payToAddress()}`);
  console.log(`Price: $${priceUsd} USDC (${amountBaseUnits} base units) per verification`);
  console.log(`Escrow program: ${escrowProgramId || "not_deployed"}`);
  console.log(`Allowed domains: ${ALLOWED_DOMAINS.join(", ")}`);
  console.log(`TinyFish API: ${process.env.TINYFISH_API_KEY ? "configured" : "NOT SET"}`);
  console.log(`Groq API: ${process.env.GROQ_API_KEY ? "configured" : "NOT SET"}`);
  console.log(`Gemini API: ${process.env.GEMINI_API_KEY ? "configured" : "NOT SET"}`);
  });
}

export { app };
