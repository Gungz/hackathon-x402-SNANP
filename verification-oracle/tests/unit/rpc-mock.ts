/**
 * Shared mock of the Solana JSON-RPC endpoint.
 *
 * Produces a fully-formed fake deposit that passes verification:
 *   - getTransaction returns an Anchor `deposit` instruction with USDC mint
 *   - getAccountInfo returns the escrow account (owned by escrow program)
 *   - getTokenAccountBalance returns the expected amount
 *   - fetchEscrowState / fetchTokenAccountBalance read from the same state
 *
 * Call semantics:
 *   - Calls to the test's own Express server (127.0.0.1 / localhost) are
 *     passed through to the real fetch — only Solana JSON-RPC methods are
 *     mocked.
 *   - Any other non-JSON-RPC traffic (e.g. TinyFish/Groq/Gemini) gets a
 *     benign empty payload so the verification pipeline degrades gracefully
 *     without real network access.
 */

import { Buffer } from "node:buffer";
import { base58ToBuffer } from "../../src/payment-verify";

const realFetch = globalThis.fetch;

const ESCROW_PROGRAM_ID = "He1b6VfhTpSzbGpSSL6jDq6TicPqP4WkvQ4xSMPkdy9a";
const USDC_DEVNET_MINT = process.env.USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEPOSITOR = "6UBWeY293oqa98E5chTJcjZdqwqJL4Y93o56gep2HBMy";
const BENEFICIARY = "7heA9wh3UMrywyBDwMXPgU8yNkH4uuW1C9EPcXaoGyQB";
const ESCROW_PDA = "ApDGZBJSqP85gCAt15C2zpucqmd4jSzWw1511ouBYXkm";
const ESCROW_TOKEN_ACCOUNT = "6Pusj7UVEQHMPKU4g8zLSqok29NmGbW4VKKU7dsAtamy";
const DEPOSITOR_TOKEN_ACCOUNT = "4sBqwsiH1DFZ5H9nRAGpiA6NpBvH6AHoFEoTEDaE51Z3";
const AMOUNT = 10_000n;
const TOKEN_2022_NOT_USED = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

export interface MockRpcState {
  depositAmount: bigint;
  /** When "notFound", getTransaction returns { result: null } */
  txShape: "valid" | "notFound" | "wrongProgram";
  /** When set, deposit confirmation reports an error */
  txError: string | null;
  /** Override the beneficiary named in the deposit instruction (claim signer target) */
  beneficiary?: string;
  /** When true, Groq/Gemini endpoints answer YES with 0.99 confidence (test pipeline determinism) */
  forceYes?: boolean;
  /** When true, getAccountInfo for the escrow PDA returns value: null (settled) */
  escrowClosed?: boolean;
}

const DEPOSIT_DISCRIMINATOR = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);
const CLAIM_DISCRIMINATOR = Buffer.from([62, 198, 214, 193, 213, 159, 108, 210]);
const REFUND_DISCRIMINATOR = Buffer.from([2, 96, 183, 251, 63, 208, 46, 46]);
// Anchor account discriminator for `Escrow` — only the owner/length matter for tests
const ESCROW_ACCOUNT_DISCRIMINATOR = Buffer.from([124, 49, 231, 13, 77, 213, 89, 67]);

function decodeAddress(address: string): Buffer {
  const buf = base58ToBuffer(address);
  if (!buf || buf.length !== 32) {
    throw new Error(`Mock address is not 32 bytes when decoded: ${address}`);
  }
  return buf;
}

export function buildEscrowAccountData(state: MockRpcState): Buffer {
  const amount = state.depositAmount;
  const beneficiary = state.beneficiary ?? BENEFICIARY;
  const buf = Buffer.alloc(8 + 32 + 32 + 8 + 1 + 1 + 1); // 83 bytes, Anchor layout
  ESCROW_ACCOUNT_DISCRIMINATOR.copy(buf, 0);
  decodeAddress(DEPOSITOR).copy(buf, 8);
  decodeAddress(beneficiary).copy(buf, 40);
  buf.writeBigUInt64LE(amount, 72);
  buf[80] = 0; // claimed
  buf[81] = 0; // refunded
  buf[82] = 253; // bump
  return buf;
}

function buildTokenAccountData(state: MockRpcState): Buffer {
  // SPL Token account: mint(32) | authority(32) | amount(8) | ... (only first 72 bytes matter)
  const buf = Buffer.alloc(72);
  decodeAddress(USDC_DEVNET_MINT).copy(buf, 0);
  decodeAddress(ESCROW_PDA).copy(buf, 32);
  buf.writeBigUInt64LE(state.depositAmount, 64);
  return buf;
}

export function buildMockTransaction(state: MockRpcState) {
  const beneficiary = state.beneficiary ?? BENEFICIARY;
  const dataB64 = Buffer.concat([
    DEPOSIT_DISCRIMINATOR,
    (() => {
      const a = Buffer.alloc(8);
      a.writeBigUInt64LE(state.depositAmount);
      return a;
    })(),
  ]).toString("base64");

  const accounts = [
    DEPOSITOR,
    beneficiary,
    ESCROW_PDA,
    ESCROW_TOKEN_ACCOUNT,
    DEPOSITOR_TOKEN_ACCOUNT,
    USDC_DEVNET_MINT,
    TOKEN_2022_NOT_USED,
    SYSTEM_PROGRAM_ID,
  ];

  const message = {
    accountKeys: [
      { pubkey: DEPOSITOR },
      { pubkey: beneficiary },
      { pubkey: ESCROW_PDA },
      { pubkey: ESCROW_TOKEN_ACCOUNT },
      { pubkey: DEPOSITOR_TOKEN_ACCOUNT },
      { pubkey: USDC_DEVNET_MINT },
      { pubkey: ESCROW_PROGRAM_ID },
      { pubkey: TOKEN_2022_NOT_USED },
    ],
    instructions: [
      { programId: ESCROW_PROGRAM_ID, accounts, data: dataB64 },
    ],
  };

  if (state.txShape === "notFound") {
    return { result: null };
  }

  if (state.txShape === "wrongProgram") {
    return {
      result: {
        meta: { err: null },
        transaction: {
          message: {
            ...message,
            instructions: [
              {
                programId: SYSTEM_PROGRAM_ID,
                accounts,
                data: dataB64,
              },
            ],
          },
        },
      },
    };
  }

  return {
    result: {
      meta: { err: state.txError },
      transaction: { message },
    },
  };
}

/**
 * Build a mock claim/refund settlement transaction, keyed off the signature
 * string used by the settlement tests (mock-claim-*, mock-refund-*,
 * mock-wrongclaimsigner-*). Claim signer = BENEFICIARY, refund signer = DEPOSITOR.
 */
export function buildMockSettlementTransaction(signature: string) {
  const isClaim =
    signature.startsWith("mock-claim-") || signature.startsWith("mock-wrongclaimsigner-");
  const signer = signature.startsWith("mock-wrongclaimsigner-")
    ? "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    : isClaim
      ? BENEFICIARY
      : DEPOSITOR;

  const discriminator = isClaim ? CLAIM_DISCRIMINATOR : REFUND_DISCRIMINATOR;
  const accounts = [
    ESCROW_PDA,
    ESCROW_TOKEN_ACCOUNT,
    DEPOSITOR_TOKEN_ACCOUNT,
    signer,
    TOKEN_2022_NOT_USED,
  ];

  return {
    result: {
      meta: { err: null },
      transaction: {
        message: {
          accountKeys: [
            { pubkey: signer },
            { pubkey: ESCROW_PDA },
            { pubkey: USDC_DEVNET_MINT },
          ],
          instructions: [
            {
              programId: ESCROW_PROGRAM_ID,
              accounts,
              data: discriminator.toString("base64"),
            },
          ],
        },
      },
    },
  };
}

/**
 * Build a complete mock of Solana JSON-RPC fetch responses.
 * Returns a function matching (url, init?) => Promise<Response>.
 */
export function createRpcMock(state: MockRpcState) {
  return async (url: any, init?: any): Promise<any> => {
    const urlString = String(url);

    // Never intercept calls to the test's own HTTP server
    if (
      urlString.startsWith("http://127.0.0.1") ||
      urlString.startsWith("http://localhost") ||
      urlString.startsWith("https://127.0.0.1") ||
      urlString.startsWith("https://localhost")
    ) {
      return realFetch(url, init);
    }

    let body: any = null;
    try {
      body = init?.body ? JSON.parse(init.body as string) : null;
    } catch {
      body = null;
    }
    const method: string = body?.method ?? "";

    // Deterministic YES for the LLM reasoning step (settlement tests)
    if (
      state.forceYes &&
      (urlString.includes("api.groq.com") || urlString.includes("generativelanguage.googleapis.com"))
    ) {
      const content = JSON.stringify({ outcome: "YES", confidence: 0.99, reasoning: "Mocked YES" });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content } }], // Groq (OpenAI-compatible)
          candidates: [{ content: { parts: [{ text: content }] } }], // Gemini
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    if (method === "getTransaction") {
      const sig = typeof body?.params?.[0] === "string" ? body.params[0] : "";
      if (
        sig.startsWith("mock-claim-") ||
        sig.startsWith("mock-refund-") ||
        sig.startsWith("mock-wrongclaimsigner-")
      ) {
        return new Response(JSON.stringify(buildMockSettlementTransaction(sig)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (sig.startsWith("mock-notfound-")) {
        return new Response(JSON.stringify({ result: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(buildMockTransaction(state)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "getAccountInfo") {
      const params = body?.params ?? [];
      const address = typeof params[0] === "string" ? params[0] : params[0]?.pubkey;
      if (address === ESCROW_PDA) {
        if (state.escrowClosed) {
          // Settled — escrow account is closed on-chain
          return new Response(
            JSON.stringify({ result: { context: { slot: 1 }, value: null } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            result: {
              context: { slot: 1 },
              value: {
                owner: ESCROW_PROGRAM_ID,
                data: [buildEscrowAccountData(state).toString("base64"), "base64"],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (address === ESCROW_TOKEN_ACCOUNT) {
        return new Response(
          JSON.stringify({
            result: {
              context: { slot: 1 },
              value: {
                owner: TOKEN_2022_NOT_USED,
                data: [buildTokenAccountData(state).toString("base64"), "base64"],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // Unknown account — not found
      return new Response(
        JSON.stringify({ result: { context: { slot: 1 }, value: null } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (method === "getTokenAccountBalance") {
      return new Response(
        JSON.stringify({
          result: { value: { amount: String(state.depositAmount), uiAmountString: "0.01" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Benign empty payload for anything else (TinyFish, Groq, Gemini, ...)
    return new Response(JSON.stringify({ result: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

export const MOCK_ADDRESSES = {
  DEPOSITOR,
  BENEFICIARY,
  ESCROW_PDA,
  ESCROW_TOKEN_ACCOUNT,
  DEPOSITOR_TOKEN_ACCOUNT,
  AMOUNT,
};
