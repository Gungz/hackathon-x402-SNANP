/**
 * Shared mock of the Solana JSON-RPC endpoint.
 *
 * Produces a fully-formed fake V1 deposit that passes verification:
 *   - getTransaction returns an Anchor `deposit` instruction with USDC mint
 *     and a client-supplied nonce (escrow PDAs derive from depositor + nonce)
 *   - getAccountInfo returns the escrow account (owned by escrow program, 155 bytes)
 *   - getTokenAccountBalance returns the expected amount
 *   - the escrow account records the submitted signature as its attested
 *     deposit signature (unless `attested: false` is passed)
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
import { createHash } from "node:crypto";
import { base58ToBuffer, base58Encode, deriveEscrowPdaAddress, deriveEscrowTokenPdaAddress } from "../../src/payment-verify";

const realFetch = globalThis.fetch;

const ESCROW_PROGRAM_ID = "He1b6VfhTpSzbGpSSL6jDq6TicPqP4WkvQ4xSMPkdy9a";
const USDC_DEVNET_MINT = process.env.USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEPOSITOR = "6UBWeY293oqa98E5chTJcjZdqwqJL4Y93o56gep2HBMy";
const BENEFICIARY = "7heA9wh3UMrywyBDwMXPgU8yNkH4uuW1C9EPcXaoGyQB";
const DEPOSITOR_TOKEN_ACCOUNT = "4sBqwsiH1DFZ5H9nRAGpiA6NpBvH6AHoFEoTEDaE51Z3";
const AMOUNT = 10_000n;
const MOCK_NONCE = 12345n;
const TOKEN_2022_NOT_USED = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

const DEPOSIT_DISCRIMINATOR = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);
const CLAIM_DISCRIMINATOR = Buffer.from([62, 198, 214, 193, 213, 159, 108, 210]);
const REFUND_DISCRIMINATOR = Buffer.from([2, 96, 183, 251, 63, 208, 46, 46]);
const ESCROW_ACCOUNT_DISCRIMINATOR = Buffer.from([31, 213, 123, 187, 186, 22, 218, 155]);

/** Deterministic 64-byte base58 "transaction signature" for tests. */
export function fakeTxSignature(seed: string): string {
  const digest = createHash("sha256").update(seed).digest();
  return base58Encode(Buffer.concat([digest, digest]));
}

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
  /** Nonce carried by the deposit instruction; also seeds the mock escrow PDA (default 12345) */
  nonce?: bigint;
  /** When false, the escrow account records NO deposit signature (unattested) — default true (attested) */
  attested?: boolean;
}

function decodeAddress(address: string): Buffer {
  const buf = base58ToBuffer(address);
  if (!buf || buf.length !== 32) {
    throw new Error(`Mock address is not 32 bytes when decoded: ${address}`);
  }
  return buf;
}

export function buildEscrowAccountData(state: MockRpcState, attestedSignature: Buffer | null): Buffer {
  const amount = state.depositAmount;
  const beneficiary = state.beneficiary ?? BENEFICIARY;
  const nonce = state.nonce ?? MOCK_NONCE;
  // disc(8) + depositor(32) + beneficiary(32) + amount(8) + claimed(1) + refunded(1) + bump(1) + nonce(8) + signature(64)
  const buf = Buffer.alloc(155);
  ESCROW_ACCOUNT_DISCRIMINATOR.copy(buf, 0);
  decodeAddress(DEPOSITOR).copy(buf, 8);
  decodeAddress(beneficiary).copy(buf, 40);
  buf.writeBigUInt64LE(amount, 72);
  buf[80] = 0; // claimed
  buf[81] = 0; // refunded
  buf[82] = 253; // bump
  buf.writeBigUInt64LE(nonce, 83);
  if (state.attested !== false && attestedSignature && attestedSignature.length === 64) {
    attestedSignature.copy(buf, 91);
  } else {
    buf.fill(0, 91, 155);
  }
  return buf;
}

function buildTokenAccountData(state: MockRpcState, escrowPdaBytes: Buffer): Buffer {
  // SPL Token account: mint(32) | authority(32) | amount(8) | ... (only first 72 bytes matter)
  const buf = Buffer.alloc(72);
  decodeAddress(USDC_DEVNET_MINT).copy(buf, 0);
  escrowPdaBytes.copy(buf, 32); // authority == escrow PDA
  buf.writeBigUInt64LE(state.depositAmount, 64);
  return buf;
}

export async function buildMockTransaction(state: MockRpcState) {
  const beneficiary = state.beneficiary ?? BENEFICIARY;
  const nonce = state.nonce ?? MOCK_NONCE;
  const escrowPda = (await deriveEscrowPdaAddress(DEPOSITOR, nonce))!;
  const escrowTokenPda = (await deriveEscrowTokenPdaAddress(DEPOSITOR, nonce))!;
  const dataB64 = Buffer.concat([
    DEPOSIT_DISCRIMINATOR,
    (() => {
      const a = Buffer.alloc(8);
      a.writeBigUInt64LE(state.depositAmount);
      return a;
    })(),
    (() => {
      const n = Buffer.alloc(8);
      n.writeBigUInt64LE(nonce);
      return n;
    })(),
  ]).toString("base64");

  const accounts = [
    DEPOSITOR,
    beneficiary,
    escrowPda,
    escrowTokenPda,
    DEPOSITOR_TOKEN_ACCOUNT,
    USDC_DEVNET_MINT,
    TOKEN_2022_NOT_USED,
    SYSTEM_PROGRAM_ID,
  ];

  const message = {
    accountKeys: [
      { pubkey: DEPOSITOR },
      { pubkey: beneficiary },
      { pubkey: escrowPda },
      { pubkey: escrowTokenPda },
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
export async function buildMockSettlementTransaction(signature: string) {
  const isClaim =
    signature.startsWith("mock-claim-") || signature.startsWith("mock-wrongclaimsigner-");
  const signer = signature.startsWith("mock-wrongclaimsigner-")
    ? "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    : isClaim
      ? BENEFICIARY
      : DEPOSITOR;

  const nonce = MOCK_NONCE;
  const escrowPda = (await deriveEscrowPdaAddress(DEPOSITOR, nonce))!;
  const escrowTokenPda = (await deriveEscrowTokenPdaAddress(DEPOSITOR, nonce))!;

  const discriminator = isClaim ? CLAIM_DISCRIMINATOR : REFUND_DISCRIMINATOR;
  const accounts = [
    escrowPda,
    escrowTokenPda,
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
            { pubkey: escrowPda },
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
  // The signature under verification — the mock escrow account attests with
  // exactly these bytes so the attestation gate can pass deterministically.
  let lastSignature: Buffer | null = null;

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

    const nonce = state.nonce ?? MOCK_NONCE;
    const escrowPda = (await deriveEscrowPdaAddress(DEPOSITOR, nonce))!;
    const escrowTokenPda = (await deriveEscrowTokenPdaAddress(DEPOSITOR, nonce))!;

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
      lastSignature = base58ToBuffer(sig);
      if (
        sig.startsWith("mock-claim-") ||
        sig.startsWith("mock-refund-") ||
        sig.startsWith("mock-wrongclaimsigner-")
      ) {
        return new Response(JSON.stringify(await buildMockSettlementTransaction(sig)), {
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
      return new Response(JSON.stringify(await buildMockTransaction(state)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "getAccountInfo") {
      const params = body?.params ?? [];
      const address = typeof params[0] === "string" ? params[0] : params[0]?.pubkey;
      if (address === escrowPda) {
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
                data: [buildEscrowAccountData(state, lastSignature).toString("base64"), "base64"],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (address === escrowTokenPda) {
        return new Response(
          JSON.stringify({
            result: {
              context: { slot: 1 },
              value: {
                owner: TOKEN_2022_NOT_USED,
                data: [buildTokenAccountData(state, decodeAddress(escrowPda)).toString("base64"), "base64"],
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
  DEPOSITOR_TOKEN_ACCOUNT,
  AMOUNT,
  MOCK_NONCE,
};
