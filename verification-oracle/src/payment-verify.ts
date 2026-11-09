/**
 * On-chain payment verification.
 *
 * Verifies that a PAYMENT-SIGNATURE corresponds to a confirmed Solana Devnet
 * transaction that invoked the escrow program's `deposit` instruction with the
 * expected amount — then independently confirms the escrow account state and
 * the locked token balance on-chain. No stubbed or placeholder signatures are
 * accepted.
 */

import "dotenv/config";
import { getProgramDerivedAddress, type Address } from "@solana/kit";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const ESCROW_PROGRAM_ID = (
  process.env.ESCROW_PROGRAM_ID?.trim().replace(/[.]+$/, "") ||
  "He1b6VfhTpSzbGpSSL6jDq6TicPqP4WkvQ4xSMPkdy9a"
) as string;
// Mint accepted for payment — defaults to Circle's devnet USDC; override with
// USDC_MINT (e.g. a self-minted devnet demo token) for demos.
export const USDC_DEVNET_MINT =
  process.env.USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export interface DepositVerification {
  ok: boolean;
  depositor: string | null;
  amount: bigint | null;
  /** Escrow PDA extracted from the deposit instruction — persisted for settlement reconciliation */
  escrowPda?: string | null;
  /** Client-supplied nonce carried by the deposit instruction (seeds the escrow PDA) */
  nonce?: bigint | null;
  /** True when the escrow account records the deposit transaction signature (attest landed) */
  attested?: boolean;
  reason?: string;
}

const DEPOSIT_DISCRIMINATOR = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);
const CLAIM_DISCRIMINATOR = Buffer.from([62, 198, 214, 193, 213, 159, 108, 210]);
const REFUND_DISCRIMINATOR = Buffer.from([2, 96, 183, 251, 63, 208, 46, 46]);
const ATTEST_DISCRIMINATOR = Buffer.from([83, 148, 120, 119, 144, 139, 117, 160]);
const ESCROW_ACCOUNT_DISCRIMINATOR = Buffer.from([31, 213, 123, 187, 186, 22, 218, 155]);
/** Escrow account data length: disc(8) + depositor(32) + beneficiary(32) + amount(8) + claimed(1) + refunded(1) + bump(1) + nonce(8) + signature(64) */
const ESCROW_ACCOUNT_LEN = 155;
/** u64 nonce → 8 little-endian bytes (matches Rust's `nonce.to_le_bytes()`) */
function nonceLeBytes(nonce: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(nonce));
  return buf;
}

/** Normalize an instruction account entry (string or { pubkey }/{ address }) to an address string. */
function instructionAccountAddresses(ix: any): string[] {
  if (!Array.isArray(ix?.accounts)) return [];
  return ix.accounts.map((a: any) => (typeof a === "string" ? a : a?.pubkey ?? a?.address ?? ""));
}

function decodeBase58Data(data: string | undefined): Buffer | null {
  if (!data) return null;

  // Strict base64 check with round-trip validation — a base58 string is also
  // valid input to Buffer.from(..., 'base64') and would silently decode to
  // garbage, so we only accept base64 when re-encoding yields the same string.
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(data) && data.length % 4 === 0) {
    try {
      const buf = Buffer.from(data, "base64");
      if (buf.length > 0 && buf.toString("base64") === data) return buf;
    } catch {
      // fall through to base58
    }
  }

  // jsonParsed instructions from the RPC carry data as base58 — decode that.
  // Minimal base58 decoder (no external dependency)
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const BASE = 58n;
  let value = 0n;
  for (const ch of data) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = value * BASE + BigInt(idx);
  }
  let bytes = Buffer.alloc(Math.max(Math.ceil(value.toString(2).length / 8) || 1, 1));
  let v = value;
  for (let i = bytes.length - 1; i >= 0; i--) {
    bytes[i] = Number(v % 256n);
    v /= 256n;
  }
  let leadingZeros = 0;
  for (const ch of data) {
    if (ch === "1") leadingZeros++;
    else break;
  }
  if (leadingZeros > 0) {
    bytes = Buffer.concat([Buffer.alloc(leadingZeros), bytes]);
  }
  return bytes;
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: T };
    return data.result ?? null;
  } catch {
    return null;
  }
}

async function fetchTransactionWithRetry(signature: string) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const result: any = await rpcCall("getTransaction", [
      signature,
      {
        encoding: "jsonParsed",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 1,
      },
    ]);
    if (result) return result;
    if (attempt < 5) {
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  return null;
}

function bufferFromBase64(data: string | [string, string] | undefined): Buffer | null {
  if (!data) return null;
  const raw = typeof data === "string" ? data : data[0];
  if (!raw) return null;
  try {
    return Buffer.from(raw, "base64");
  } catch {
    return null;
  }
}

export interface EscrowState {
  depositor: string;
  beneficiary: string;
  amount: bigint;
  claimed: boolean;
  refunded: boolean;
  /** Client-supplied nonce that seeds this escrow PDA */
  nonce: bigint;
  /** The 64-byte deposit transaction signature recorded by `attest`, or null when unattested */
  depositTxSignature: Buffer | null;
}

/**
 * Fetch and decode the escrow account (V1 layout, 155 bytes).
 * Returns null if the account is missing, not owned by the escrow program,
 * or has an unexpected layout.
 */
export async function fetchEscrowState(escrowAddress: string): Promise<EscrowState | null> {
  const info: any = await rpcCall("getAccountInfo", [
    escrowAddress,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  if (!info || !info.value) return null;

  if (info.value.owner !== ESCROW_PROGRAM_ID) return null;

  const data = bufferFromBase64(info.value.data);
  if (!data || data.length < ESCROW_ACCOUNT_LEN) return null;
  if (!data.subarray(0, 8).equals(ESCROW_ACCOUNT_DISCRIMINATOR)) return null;

  // Layout: [disc(8)] depositor(32) beneficiary(32) amount(8) claimed(1) refunded(1) bump(1) nonce(8) deposit_tx_signature(64)
  const amount = data.readBigUInt64LE(72);
  const claimed = data[80] === 1;
  const refunded = data[81] === 1;
  const nonce = data.readBigUInt64LE(83);
  const sigBytes = data.subarray(91, 155);
  const allZero = sigBytes.every((b: number) => b === 0);
  const depositTxSignature = allZero ? null : Buffer.from(sigBytes);

  const toBase58 = (start: number) => base58Encode(data.subarray(start, start + 32));

  const depositor = toBase58(8);
  const beneficiary = toBase58(40);

  return { depositor, beneficiary, amount, claimed, refunded, nonce, depositTxSignature };
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(input: Buffer): string {
  if (input.length === 0) return "";
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros++;
  const digits: number[] = [0];
  for (let i = zeros; i < input.length; i++) {
    let carry = input[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let output = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) {
    output += BASE58_ALPHABET[digits[i]];
  }
  return output;
}

export function base58ToBuffer(data: string): Buffer | null {
  const BASE = 58n;
  let value = 0n;
  for (const ch of data) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = value * BASE + BigInt(idx);
  }
  let bytes = Buffer.alloc(Math.max(Math.ceil(value.toString(2).length / 8), 1));
  let v = value;
  for (let i = bytes.length - 1; i >= 0; i--) {
    bytes[i] = Number(v % 256n);
    v /= 256n;
  }
  let leadingZeros = 0;
  for (const ch of data) {
    if (ch === "1") leadingZeros++;
    else break;
  }
  if (leadingZeros > 0) {
    bytes = Buffer.concat([Buffer.alloc(leadingZeros), bytes]);
  }
  return bytes;
}

/**
 * Read the owner (authority) of an SPL token account.
 * Returns base58 address or null if the account is missing / malformed.
 */
export async function fetchTokenAccountOwner(tokenAccount: string): Promise<string | null> {
  const info: any = await rpcCall("getAccountInfo", [
    tokenAccount,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  if (!info?.value?.data) return null;
  const data = bufferFromBase64(info.value.data);
  if (!data || data.length < 72) return null;
  return base58Encode(data.subarray(32, 64));
}

export async function fetchTokenAccountBalance(tokenAccount: string): Promise<bigint | null> {
  const result: any = await rpcCall("getTokenAccountBalance", [
    tokenAccount,
    { commitment: "confirmed" },
  ]);
  if (!result?.value?.amount) return null;
  return BigInt(result.value.amount);
}

/**
 * Verify a deposit transaction on-chain.
 *
 * Checks:
 *   1. Transaction exists, confirmed, and has no on-chain error
 *   2. Transaction invoked the escrow program's `deposit` instruction
 *   3. Depositor (fee payer) signed and matches the instruction's depositor
 *   4. Deposited amount matches the x402 requirement
 *   5. USDC mint is in the transaction's account keys
 *   6. Escrow account exists, is owned by the escrow program, and holds the amount
 *   7. Escrow token account holds at least the expected amount
 *   8. The beneficiary (instruction account #1) matches the advertised payTo
 */
export async function verifyPaymentOnChain(
  signature: string,
  expectedAmountBaseUnits: bigint,
  expectedBeneficiary?: string
): Promise<DepositVerification> {
  const result: any = await fetchTransactionWithRetry(signature);

  if (!result) {
    return { ok: false, depositor: null, amount: null, reason: "Transaction not found on devnet (retry)" };
  }
  if (result.meta?.err) {
    return { ok: false, depositor: null, amount: null, reason: "Transaction failed on-chain" };
  }

  const message = result.transaction?.message;
  const accountKeys: Array<{ pubkey?: string }> = message?.accountKeys ?? [];
  const feePayer = accountKeys[0]?.pubkey ?? null;
  const allKeys = accountKeys.map((k) => k.pubkey).filter(Boolean) as string[];

  const instructions: Array<any> = message?.instructions ?? [];

  let depositIx: any | null = null;
  for (const ix of instructions) {
    const programId = ix.programId ?? ix.program ?? ix.programName;
    if (programId !== ESCROW_PROGRAM_ID) continue;
    depositIx = ix;
    break;
  }

  if (!depositIx) {
    return { ok: false, depositor: feePayer, amount: null, reason: "Transaction did not invoke the escrow program" };
  }

  const data = decodeBase58Data(depositIx.data);
  if (!data || !data.subarray(0, 8).equals(DEPOSIT_DISCRIMINATOR)) {
    return { ok: false, depositor: feePayer, amount: null, reason: "Instruction is not a deposit" };
  }

  const amount = data.readBigUInt64LE(8);
  if (amount !== expectedAmountBaseUnits) {
    return {
      ok: false,
      depositor: feePayer,
      amount,
      reason: `Deposit amount ${amount} does not match expected ${expectedAmountBaseUnits}`,
    };
  }
  // V1 deposit instruction data: [discriminator(8)] amount(8) nonce(8)
  if (data.length < 24) {
    return { ok: false, depositor: feePayer, amount, reason: "Deposit instruction missing nonce (V0 layout?)" };
  }
  const nonce = data.readBigUInt64LE(16);

  const firstAccount = depositIx.accounts?.[0];
  if (firstAccount && firstAccount !== feePayer) {
    return { ok: false, depositor: feePayer, amount, reason: "Depositor does not match fee payer" };
  }

  if (!allKeys.includes(USDC_DEVNET_MINT)) {
    return {
      ok: false,
      depositor: feePayer,
      amount,
      reason: "USDC mint not present in transaction — cannot confirm token identity",
    };
  }

  // Identify the escrow PDA and escrow token account from the instruction accounts
  const ixAccounts: string[] = instructionAccountAddresses(depositIx);
  // Deposit accounts order: [depositor, beneficiary, escrow, escrow_token_account, depositor_token_account, mint, token_program, system_program]
  const escrowPda = ixAccounts[2];
  const escrowTokenAccount = ixAccounts[3];

  // Cross-check the beneficiary matches the advertised payment destination.
  // Without this, a client could escrow funds naming any beneficiary and the
  // server would still accept the payment — the operator would never see it.
  if (expectedBeneficiary) {
    const beneficiary = ixAccounts[1];
    if (beneficiary !== expectedBeneficiary) {
      return {
        ok: false,
        depositor: feePayer,
        amount,
        reason: `Deposit beneficiary ${beneficiary} does not match advertised payTo ${expectedBeneficiary}`,
      };
    }
  }

  if (!escrowPda || !escrowTokenAccount) {
    return { ok: false, depositor: feePayer, amount, reason: "Could not locate escrow accounts in instruction" };
  }

  // Cross-check the escrow PDA (and its token account) really is derived from
  // the fee payer + the nonce carried by the instruction — the client cannot
  // point the verification at somebody else's escrow.
  const expectedEscrowPda = await deriveEscrowPdaAddress(feePayer!, nonce);
  const expectedEscrowTokenPda = await deriveEscrowTokenPdaAddress(feePayer!, nonce);
  if (!expectedEscrowPda || expectedEscrowPda !== escrowPda) {
    return {
      ok: false,
      depositor: feePayer,
      amount,
      nonce,
      reason: "Escrow PDA does not match the depositor + nonce from the deposit instruction",
    };
  }
  if (expectedEscrowTokenPda !== escrowTokenAccount) {
    return {
      ok: false,
      depositor: feePayer,
      amount,
      nonce,
      reason: "Escrow token account PDA does not match the depositor + nonce from the deposit instruction",
    };
  }

  // Cross-check the escrow account state independently
  const escrowState = await fetchEscrowState(escrowPda);
  if (!escrowState) {
    return { ok: false, depositor: feePayer, amount, nonce, reason: "Escrow account missing, wrong layout, or not owned by escrow program" };
  }
  if (escrowState.amount !== amount) {
    return {
      ok: false,
      depositor: feePayer,
      amount,
      nonce,
      reason: `Escrow amount ${escrowState.amount} does not match deposited amount`,
    };
  }
  if (escrowState.claimed || escrowState.refunded) {
    return { ok: false, depositor: feePayer, amount, nonce, reason: "Escrow already claimed or refunded" };
  }

  // ── Attestation gate (REQUIRED, V1) ──
  // The escrow account must record exactly this deposit transaction's
  // signature (written by the `attest` instruction after the deposit
  // confirmed). Unattested or mismatched ⇒ no verification, nothing settled.
  const submittedSig = base58ToBuffer(signature);
  if (!escrowState.depositTxSignature) {
    return {
      ok: false,
      depositor: feePayer,
      amount,
      nonce,
      reason:
        "attestation_required — the escrow account has no deposit signature. Submit the `attest` instruction with this deposit transaction's signature, then retry",
    };
  }
  if (!submittedSig || !escrowState.depositTxSignature.equals(submittedSig)) {
    return {
      ok: false,
      depositor: feePayer,
      amount,
      nonce,
      reason: "Escrow account records a different (or unattested) deposit signature than the PAYMENT-SIGNATURE",
    };
  }

  // Cross-check the escrow token account holds the tokens and is owned by the escrow PDA
  const tokenBalance = await fetchTokenAccountBalance(escrowTokenAccount);
  if (tokenBalance === null) {
    return { ok: false, depositor: feePayer, amount, reason: "Escrow token account not found or not a token account" };
  }
  if (tokenBalance < amount) {
    return {
      ok: false,
      depositor: feePayer,
      amount,
      reason: `Escrow token account holds ${tokenBalance}, expected at least ${amount}`,
    };
  }
  const tokenOwner = await fetchTokenAccountOwner(escrowTokenAccount);
  if (tokenOwner !== escrowPda) {
    return {
      ok: false,
      depositor: feePayer,
      amount,
      reason: "Escrow token account authority does not match the escrow PDA",
    };
  }

  return { ok: true, depositor: feePayer, amount: escrowState.amount, escrowPda, nonce, attested: true };
}

/**
 * Derive the escrow PDA for a depositor. V1 seeds: ["escrow", depositor, nonce_le].
 * Without a nonce (legacy records from V0) falls back to ["escrow", depositor].
 * Returns null if the depositor address is not a valid 32-byte base58 key.
 */
export async function deriveEscrowPdaAddress(depositor: string, nonce?: bigint | number | null): Promise<string | null> {
  try {
    const dep = base58ToBuffer(depositor);
    if (!dep || dep.length !== 32) return null;
    const seeds: Buffer[] = [Buffer.from("escrow"), dep];
    if (nonce !== undefined && nonce !== null) seeds.push(nonceLeBytes(nonce));
    const [pda] = await getProgramDerivedAddress({
      seeds,
      programAddress: ESCROW_PROGRAM_ID as unknown as Address,
    });
    return String(pda);
  } catch {
    return null;
  }
}

/**
 * Derive the escrow token-account PDA. V1 seeds: ["escrow-token", depositor, nonce_le].
 */
export async function deriveEscrowTokenPdaAddress(depositor: string, nonce?: bigint | number | null): Promise<string | null> {
  try {
    const dep = base58ToBuffer(depositor);
    if (!dep || dep.length !== 32) return null;
    const seeds: Buffer[] = [Buffer.from("escrow-token"), dep];
    if (nonce !== undefined && nonce !== null) seeds.push(nonceLeBytes(nonce));
    const [pda] = await getProgramDerivedAddress({
      seeds,
      programAddress: ESCROW_PROGRAM_ID as unknown as Address,
    });
    return String(pda);
  } catch {
    return null;
  }
}

/**
 * Check whether the escrow account is closed on-chain (claimed or refunded).
 * Returns false on RPC failure — absence of proof is NOT proof of settlement.
 */
export async function fetchEscrowAccountClosed(escrowAddress: string): Promise<boolean> {
  const info: any = await rpcCall("getAccountInfo", [
    escrowAddress,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  if (info === null) return false; // RPC failure — cannot conclude
  return info?.value === null;
}

export interface SettlementVerification {
  ok: boolean;
  reason?: string;
}

/**
 * Verify a claim/refund settlement transaction on-chain.
 *
 * Checks: confirmed + no error, invoked the escrow program's claim/refund
 * instruction, the escrow account matches the record's escrow PDA, and the
 * signing authority is the expected beneficiary (claim) or the depositor
 * (refund). `expectedEscrowPda` comes from the deposit verification; when
 * absent (legacy records) it is re-derived on the fly.
 * Does not flip server state — callers do that only on ok:true.
 */
export async function verifySettlementOnChain(
  kind: "claim" | "refund",
  signature: string,
  depositor: string,
  expectedPayTo: string,
  expectedEscrowPda?: string | null,
  nonce?: bigint | number | null
): Promise<SettlementVerification> {
  const result: any = await fetchTransactionWithRetry(signature);

  if (!result) {
    return { ok: false, reason: "Settlement transaction not found on devnet (retry)" };
  }
  if (result.meta?.err) {
    return { ok: false, reason: "Settlement transaction failed on-chain" };
  }

  const instructions: Array<any> = result.transaction?.message?.instructions ?? [];
  const ix = instructions.find(
    (i) => (i.programId ?? i.program ?? i.programName) === ESCROW_PROGRAM_ID
  );
  if (!ix) {
    return { ok: false, reason: "Settlement transaction did not invoke the escrow program" };
  }

  const data = decodeBase58Data(ix.data);
  if (!data) {
    return { ok: false, reason: "Could not decode settlement instruction data" };
  }
  const expected = kind === "claim" ? CLAIM_DISCRIMINATOR : REFUND_DISCRIMINATOR;
  if (!data.subarray(0, 8).equals(expected)) {
    return { ok: false, reason: `Instruction is not a ${kind}` };
  }

  const accounts = instructionAccountAddresses(ix);
  const escrowPda = expectedEscrowPda ?? (await deriveEscrowPdaAddress(depositor, nonce));
  if (!escrowPda) {
    return { ok: false, reason: "Depositor is not a valid address" };
  }
  if (accounts[0] !== escrowPda) {
    return { ok: false, reason: "Escrow account does not match the record's escrow PDA" };
  }

  // Claim accounts:  [escrow, escrow_token_account, beneficiary_token_account, beneficiary(signer), token_program]
  // Refund accounts: [escrow, escrow_token_account, depositor_token_account, depositor(signer), token_program]
  const signer = accounts[3];
  if (kind === "claim" && signer !== expectedPayTo) {
    return { ok: false, reason: `Claim signer ${signer} is not the oracle beneficiary` };
  }
  if (kind === "refund" && signer !== depositor) {
    return { ok: false, reason: `Refund signer ${signer} is not the depositor` };
  }

  return { ok: true };
}
