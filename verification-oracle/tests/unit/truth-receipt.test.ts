import "./env-setup";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import type { Server } from "http";
import { createRpcMock, type MockRpcState } from "./rpc-mock";
import { app } from "../../src/server";

let server: Server;
let baseUrl: string;

before(async () => {
  const port = 4600 + Math.floor(Math.random() * 400);
  baseUrl = `http://127.0.0.1:${port}`;
  server = app.listen(port);
});

after(() => {
  server?.close();
});

describe("Truth Receipt response", { concurrency: 1 }, () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    const state: MockRpcState = { depositAmount: 10_000n, txShape: "valid", txError: null };
    globalThis.fetch = createRpcMock(state) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("/verify returns all required Truth Receipt fields", async () => {
    const res = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": `test-truth-${Date.now()}`,
      },
      body: JSON.stringify({ question: "Test?", criteria: "Test" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;

    // Core Truth Receipt fields required by the spec
    assert.ok("outcome" in body, "outcome missing");
    assert.ok(["YES", "NO", "UNDECIDED"].includes(body.outcome as string), "outcome invalid");
    assert.ok("confidence" in body, "confidence missing");
    assert.ok("evidence" in body, "evidence missing");
    assert.ok(Array.isArray(body.evidence), "evidence must be array");
    assert.ok("proofId" in body, "proofId missing");
    assert.ok("payment" in body, "payment missing");
    assert.ok("timestamp" in body, "timestamp missing");
    assert.ok("escrowStatus" in body, "escrowStatus missing");
    assert.ok(["claimable", "refundable"].includes(body.escrowStatus as string), "escrowStatus invalid");

    const payment = body.payment as Record<string, unknown>;
    assert.ok(payment.depositSignature, "depositSignature missing from payment");
    assert.ok(typeof payment.depositTransactionUrl === "string", "depositTransactionUrl missing");
  });
});
