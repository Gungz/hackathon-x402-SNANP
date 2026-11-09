/**
 * Tests for the claim/refund settlement endpoints.
 *
 * These endpoints move REAL escrow settlement bookkeeping — the on-chain
 * transaction is authoritative. The server must:
 *   - reject calls without a settlement signature (400)
 *   - reject settlement transactions that don't match the record's escrow PDA
 *   - reject claim transactions not signed by the oracle beneficiary
 *   - reject the wrong transaction type for each endpoint
 *   - flip + persist the record only after verified on-chain settlement
 *   - mark records settled when chain shows the escrow PDA closed (reconcile)
 *
 * Seeded records are deterministic: with forceYes=true the mocked LLM answers
 * YES (escrow claimable); otherwise providers fail and the pipeline forces
 * UNDECIDED (escrow refundable).
 */

import "./env-setup";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import type { Server } from "http";
import { createRpcMock, fakeTxSignature, type MockRpcState } from "./rpc-mock";
import { app } from "../../src/server";

let server: Server;
let baseUrl: string;

before(async () => {
  const port = 5100 + Math.floor(Math.random() * 300);
  baseUrl = `http://127.0.0.1:${port}`;
  server = app.listen(port);
});

after(() => {
  server?.close();
});

describe("claim/refund settlement endpoints", { concurrency: 1 }, () => {
  const originalFetch = globalThis.fetch;
  let state: MockRpcState;

  beforeEach(() => {
    state = { depositAmount: 10_000n, txShape: "valid", txError: null };
    globalThis.fetch = createRpcMock(state) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function seedProof(kind: "claimable" | "refundable"): Promise<string> {
    state.forceYes = kind === "claimable";
    const sig = fakeTxSignature(`settlement-deposit-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
    const res = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": sig,
      },
      body: JSON.stringify({
        question: `Verification-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
        criteria: "Score",
      }),
    });
    const body = (await res.json()) as { proofId?: string; escrowStatus?: string };
    assert.equal(res.status, 200, `seeding /verify failed: ${JSON.stringify(body)}`);
    assert.equal(
      body.escrowStatus,
      kind,
      `seeded record was ${body.escrowStatus}, expected ${kind}`
    );
    assert.ok(body.proofId, "no proofId returned by /verify");
    return body.proofId!;
  }

  // ── Claim endpoint ──

  test("claim without a settlement signature returns 400 signature_required", async () => {
    const proofId = await seedProof("claimable");
    const res = await fetch(`${baseUrl}/escrow/${proofId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "signature_required");
  });

  test("claim with a refund transaction is rejected as settlement_invalid", async () => {
    const proofId = await seedProof("claimable");
    const res = await fetch(`${baseUrl}/escrow/${proofId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: "mock-refund-1" }),
    });
    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "settlement_invalid");
  });

  test("claim with a wrong signer is rejected", async () => {
    const proofId = await seedProof("claimable");
    const res = await fetch(`${baseUrl}/escrow/${proofId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: "mock-wrongclaimsigner-1" }),
    });
    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "settlement_invalid");
  });

  test("claim with an unknown transaction is rejected", async () => {
    const proofId = await seedProof("claimable");
    const res = await fetch(`${baseUrl}/escrow/${proofId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: "mock-notfound-1" }),
    });
    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "settlement_invalid");
  });

  test("valid claim settles the record and removes it from pending", async () => {
    const proofId = await seedProof("claimable");
    const res = await fetch(`${baseUrl}/escrow/${proofId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: "mock-claim-1" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean; status: string };
    assert.equal(body.success, true);
    assert.equal(body.status, "claimed");

    const pending = (await fetch(`${baseUrl}/escrow/pending`).then((r) => r.json())) as any;
    assert.ok(
      !pending.pending.some((r: any) => r.proofId === proofId),
      "settled record still listed as pending"
    );
  });

  test("refund on a claimable record returns 400", async () => {
    const proofId = await seedProof("claimable");
    const res = await fetch(`${baseUrl}/escrow/${proofId}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: "mock-refund-1" }),
    });
    assert.equal(res.status, 400);
  });

  // ── Refund endpoint ──

  test("refund without a settlement signature returns 400 signature_required", async () => {
    const proofId = await seedProof("refundable");
    const res = await fetch(`${baseUrl}/escrow/${proofId}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "signature_required");
  });

  test("refund with a claim transaction is rejected as settlement_invalid", async () => {
    const proofId = await seedProof("refundable");
    const res = await fetch(`${baseUrl}/escrow/${proofId}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: "mock-claim-1" }),
    });
    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "settlement_invalid");
  });

  test("valid refund settles the record and removes it from pending", async () => {
    const proofId = await seedProof("refundable");
    const res = await fetch(`${baseUrl}/escrow/${proofId}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: "mock-refund-2" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean; status: string };
    assert.equal(body.success, true);
    assert.equal(body.status, "refunded");

    const pending = (await fetch(`${baseUrl}/escrow/pending`).then((r) => r.json())) as any;
    assert.ok(
      !pending.pending.some((r: any) => r.proofId === proofId),
      "settled record still listed as pending"
    );
  });

  test("claim on a refundable record returns 400", async () => {
    const proofId = await seedProof("refundable");
    const res = await fetch(`${baseUrl}/escrow/${proofId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: "mock-claim-1" }),
    });
    assert.equal(res.status, 400);
  });

  // ── Generic behavior ──

  test("settlement on an unknown proofId returns 404", async () => {
    const res = await fetch(`${baseUrl}/escrow/does-not-exist-${Date.now()}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: "mock-claim-1" }),
    });
    assert.equal(res.status, 404);
  });

  test("pending reconciles records whose escrow PDA is closed on-chain", async () => {
    const proofId = await seedProof("claimable");
    // Simulate out-of-band on-chain settlement: escrow account is now closed
    state.escrowClosed = true;
    const pending = (await fetch(`${baseUrl}/escrow/pending`).then((r) => r.json())) as any;
    assert.ok(
      !pending.pending.some((r: any) => r.proofId === proofId),
      "closed-escrow record was not reconciled out of pending"
    );
  });
});
