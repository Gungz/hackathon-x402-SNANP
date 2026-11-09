import "./env-setup";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import type { Server } from "http";
import { Buffer } from "node:buffer";
import { createRpcMock, type MockRpcState } from "./rpc-mock";
import { app } from "../../src/server";

let server: Server;
let baseUrl: string;

const AMOUNT = 10_000n;
const defaultState = (): MockRpcState => ({
  depositAmount: AMOUNT,
  txShape: "valid",
  txError: null,
});

before(async () => {
  const port = 4100 + Math.floor(Math.random() * 500);
  baseUrl = `http://127.0.0.1:${port}`;
  server = app.listen(port);
});

after(() => {
  server?.close();
});

describe("payment middleware with RPC", { concurrency: 1 }, () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    rpcState = defaultState();
    globalThis.fetch = createRpcMock(rpcState) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rpcState = defaultState();
  });

  let rpcState = defaultState();

  test("unverified request returns 402 with PAYMENT-REQUIRED header", async () => {
    const res = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Test?", criteria: "Test" }),
    });
    assert.equal(res.status, 402);
    const header = res.headers.get("PAYMENT-REQUIRED");
    assert.ok(header, "PAYMENT-REQUIRED header missing");
    const decoded = JSON.parse(Buffer.from(header!, "base64").toString());
    assert.equal(decoded.x402Version, 2);
    assert.equal(decoded.accepts[0].scheme, "exact");
  });

  test("stub signature is rejected with 402 payment_invalid", async () => {
    rpcState = { ...defaultState(), txShape: "notFound" };
    globalThis.fetch = createRpcMock(rpcState) as any;

    const res = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": "stub-not-a-real-tx",
      },
      body: JSON.stringify({ question: "Q?", criteria: "C" }),
    });
    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "payment_invalid");
  });

  test("deposit naming a different beneficiary is rejected", async () => {
    // Instruction names Token Program as beneficiary — must not pass as payment
    rpcState = { ...defaultState(), beneficiary: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" };
    globalThis.fetch = createRpcMock(rpcState) as any;

    const res = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": `wrong-beneficiary-${Date.now()}`,
      },
      body: JSON.stringify({ question: "Q?", criteria: "C" }),
    });
    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, "payment_invalid");
    assert.ok(body.message.includes("beneficiary"), `reason missing beneficiary: ${body.message}`);
  });

  test("wrong-program deposit is rejected", async () => {
    rpcState = { ...defaultState(), txShape: "wrongProgram" };
    globalThis.fetch = createRpcMock(rpcState) as any;

    const res = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": "wrong-program-tx",
      },
      body: JSON.stringify({ question: "Q?", criteria: "C" }),
    });
    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "payment_invalid");
  });

  test("first valid-looking deposit succeeds, second is replay-rejected", async () => {
    const sig = `rpc-replay-${Date.now()}`;

    const res1 = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": sig },
      body: JSON.stringify({ question: "Arsenal?", criteria: "Score" }),
    });
    assert.equal(res1.status, 200);

    const res2 = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": sig },
      body: JSON.stringify({ question: "Arsenal?", criteria: "Score" }),
    });
    assert.equal(res2.status, 402);
    const body = (await res2.json()) as { error: string };
    assert.equal(body.error, "payment_replay");
  });
});
