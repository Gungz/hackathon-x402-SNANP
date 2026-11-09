/**
 * End-to-end tests for VerificationOracle.
 *
 * The unit suite covers mocked network paths; this suite exercises the real
 * server against the real TinyFish/Groq APIs and the real Devnet RPC payment
 * check. The full on-chain deposit flow only runs when the disposable client
 * keypair is funded (SOL + USDC) on devnet — otherwise it is skipped with a
 * message explaining what to faucet.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import type { Server } from "http";
import { app } from "../../src/server";

let server: Server;
let baseUrl: string;

before(async () => {
  const port = 4800 + Math.floor(Math.random() * 200);
  baseUrl = `http://127.0.0.1:${port}`;
  server = app.listen(port);
});

after(() => {
  server?.close();
});

async function clientUsdcBalance(): Promise<number | null> {
  try {
    const { getBalances } = await import("../../src/deposit-client");
    const b = await getBalances();
    return b.usdcBaseUnits === null ? 0 : Number(b.usdcBaseUnits);
  } catch {
    return null;
  }
}

describe("e2e — payment and verification flow", () => {
  test("unpaid request returns 402", async () => {
    const res = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Q?", criteria: "C" }),
    });
    assert.equal(res.status, 402);
  });

  test("stub signature is rejected with 402 payment_invalid", async () => {
    const res = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": `not-a-real-transaction-${Date.now()}`,
      },
      body: JSON.stringify({ question: "Q?", criteria: "C" }),
    });
    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "payment_invalid");
  });

  test("same payment signature twice is rejected as replay", async () => {
    // Requires a funded client keypair — create a real deposit first
    const balance = await clientUsdcBalance();
    if (balance === null || balance < 10_000) {
      console.warn("SKIP: client wallet not funded with USDC on devnet — skipping replay e2e");
      return;
    }

    const { depositToEscrow } = await import("../../src/deposit-client");
    const signature = await depositToEscrow(10_000n);

    const res1 = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": signature,
      },
      body: JSON.stringify({
        question: "Did Arsenal beat Chelsea in April 2024?",
        criteria: "Final score after 90 minutes",
      }),
    });
    assert.equal(res1.status, 200);
    const body = (await res1.json()) as Record<string, unknown>;
    assert.ok(["YES", "NO", "UNDECIDED"].includes(body.outcome as string));
    assert.equal(body.escrowStatus, body.outcome === "UNDECIDED" ? "refundable" : "claimable");
    console.log(`Real deposit tx: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

    const res2 = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": signature,
      },
      body: JSON.stringify({ question: "Q?", criteria: "C" }),
    });
    assert.equal(res2.status, 402);
    const body2 = (await res2.json()) as { error: string };
    assert.equal(body2.error, "payment_replay");
  });
});
