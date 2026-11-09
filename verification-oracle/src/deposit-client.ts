/**
 * Deposit client for the x402 escrow oracle.
 *
 * Builds, signs, and submits:
 *   1. create-ATA (idempotent) — ensures the client has a USDC token account
 *   2. escrow `deposit` instruction — locks USDC into the on-chain escrow PDA
 *
 * Best practices followed:
 *   - Transaction v1 (default for new code)
 *   - Provisory resource limits filled before signing
 *   - Simulation before sending (surface failure rather than waste fees)
 *   - Signature confirmed on-chain before returning (no stale assumptions)
 *   - Explicit `confirmed` commitment everywhere
 *   - Fresh blockhash fetched at each transaction build
 *
 * Env:
 *   CLIENT_WALLET_PATH — path to disposable devnet keypair (default ./client-keypair.json)
 *   SOLANA_RPC_URL     — RPC endpoint (default devnet)
 *   SOLANA_PAY_TO      — beneficiary (oracle operator wallet)
 *   ESCROW_PROGRAM_ID  — deployed escrow program (sanitized for stray chars)
 *   USDC_MINT          — USDC mint on this cluster (defaults to devnet USDC)
 */

import * as fs from "fs";
import * as path from "path";
import "dotenv/config";
import {
  createSolanaRpc,
  createTransactionMessage,
  pipe,
  appendTransactionMessageInstruction,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  createKeyPairSignerFromBytes,
  getProgramDerivedAddress,
  getBase64EncodedWireTransaction,
  getBase58Encoder,
  estimateResourceLimitsFactory,
  estimateAndSetResourceLimitsFactory,
  type Address,
  type Signature,
} from "@solana/kit";
import { AccountRole } from "@solana/instructions";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const CLIENT_WALLET_PATH =
  process.env.CLIENT_WALLET_PATH || path.join(process.cwd(), "client-keypair.json");
const ESCROW_PROGRAM_ID = ((process.env.ESCROW_PROGRAM_ID?.trim().replace(/[.]+$/, "")) ||
  "He1b6VfhTpSzbGpSSL6jDq6TicPqP4WkvQ4xSMPkdy9a") as Address;
const SOLANA_PAY_TO = (process.env.SOLANA_PAY_TO ||
  "6UBWeY293oqa98E5chTJcjZdqwqJL4Y93o56gep2HBMy") as Address;
const USDC_DEVNET_MINT = (process.env.USDC_MINT ||
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU") as Address;

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111" as Address;
const DEPOSIT_DISCRIMINATOR = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);
const COMMITMENT = "confirmed" as const;

const rpc = createSolanaRpc(RPC_URL);

/**
 * Load the disposable devnet client keypair.
 */
export async function loadClient() {
  const raw = fs.readFileSync(CLIENT_WALLET_PATH, "utf-8");
  const secret = Uint8Array.from(JSON.parse(raw));
  const signer = await createKeyPairSignerFromBytes(secret);
  return { signer, address: signer.address as Address };
}

const encoder = getBase58Encoder();
const toBytes = (a: Address) => encoder.encode(a);

/**
 * Derive the associated token account address for the mint.
 */
export async function deriveAta(owner: Address, mint: Address) {
  const [ata] = await getProgramDerivedAddress({
    seeds: [toBytes(owner), toBytes(TOKEN_PROGRAM_ID), toBytes(mint)],
    programAddress: ATA_PROGRAM_ID,
  });
  return ata;
}

/**
 * Derive the escrow PDA for a depositor.
 */
export async function deriveEscrowPda(depositor: Address) {
  const [pda] = await getProgramDerivedAddress({
    seeds: [Buffer.from("escrow"), toBytes(depositor)],
    programAddress: ESCROW_PROGRAM_ID,
  });
  return pda;
}

/**
 * Derive the escrow token account PDA for a depositor.
 */
export async function deriveEscrowTokenPda(depositor: Address) {
  const [pda] = await getProgramDerivedAddress({
    seeds: [Buffer.from("escrow-token"), toBytes(depositor)],
    programAddress: ESCROW_PROGRAM_ID,
  });
  return pda;
}

/**
 * Derive the escrow PDA and token account for a depositor.
 */
export async function deriveEscrow(depositor: Address) {
  const escrow = await deriveEscrowPda(depositor);
  const escrowToken = await deriveEscrowTokenPda(depositor);
  return { escrow, escrowToken };
}

/**
 * Check whether the client's ATA for the mint already exists.
 */
async function ataExists(ata: Address): Promise<boolean> {
  try {
    const info = await rpc.getAccountInfo(ata, { encoding: "jsonParsed", commitment: COMMITMENT }).send();
    return info.value !== null;
  } catch {
    return false;
  }
}

/**
 * Wait for a signature to reach the requested commitment.
 * Polls getSignatureStatuses; throws on timeout or on-chain error.
 */
async function confirmSignature(signature: Signature, timeoutMs = 60_000, pollsMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const statuses = await rpc
      .getSignatureStatuses([signature], { searchTransactionHistory: true })
      .send();
    const status = statuses.value?.[0];

    if (status?.err != null) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized" ||
      (status?.slot != null && Date.now() > deadline - pollsMs)
    ) {
      return signature;
    }
    if (Date.now() > deadline) {
      throw new Error(`Signature not confirmed within ${timeoutMs}ms: ${signature}`);
    }
    await new Promise((r) => setTimeout(r, pollsMs));
  }
}

/**
 * Build a signed v1 transaction from an instruction, estimate + set real
 * resource limits by simulating with max limits, then send (preflight runs
 * a final server-side simulation) and wait for confirmation.
 */
const estimator = estimateResourceLimitsFactory({ rpc });
const estimateAndSetResourceLimits = estimateAndSetResourceLimitsFactory(estimator);

async function signSimulateAndSend(
  signer: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>,
  instruction: {
    programAddress: Address;
    accounts: { address: Address; role: AccountRole }[];
    data: Uint8Array | Buffer;
  }
): Promise<string> {
  // Latest blockhash, confirmed
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: COMMITMENT }).send();

  // Build the v1 message
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstruction(instruction as any, m)
  );

  // Estimate compute-unit and loaded-accounts-data limits from a real simulation
  const withLimits = await estimateAndSetResourceLimits(message);

  // Sign and send (preflight re-simulates server-side with the estimated limits)
  const signed = await signTransactionMessageWithSigners(withLimits);
  const wire = getBase64EncodedWireTransaction(signed);
  const signature = await rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: COMMITMENT }).send();
  await confirmSignature(signature);
  return signature;
}

/**
 * Create the depositor ATA for the mint if it doesn't exist yet.
 * Returns the signature, or null if it already exists.
 */
export async function ensureDepositorAta(mintOverride?: string): Promise<string | null> {
  const { signer, address } = await loadClient();
  const mint = (mintOverride ?? USDC_DEVNET_MINT) as Address;
  const ata = await deriveAta(address, mint);
  if (await ataExists(ata)) {
    console.log(`ATA already exists: ${ata}`);
    return null;
  }

  const createAtaIx = {
    programAddress: ATA_PROGRAM_ID,
    accounts: [
      { address, role: AccountRole.WRITABLE_SIGNER },
      { address: ata, role: AccountRole.WRITABLE },
      { address, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(0),
  };

  const sig = await signSimulateAndSend(signer, createAtaIx);
  console.log(`Created depositor ATA ${ata} (signature: ${sig})`);
  return sig;
}

/**
 * Build the Anchor `deposit` instruction.
 */
function buildDepositInstruction(
  depositor: Address,
  escrow: Address,
  escrowToken: Address,
  depositorToken: Address,
  mint: Address,
  amount: bigint,
  beneficiary: Address
) {
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amount);
  const data = Buffer.concat([DEPOSIT_DISCRIMINATOR, amountBuf]);

  return {
    programAddress: ESCROW_PROGRAM_ID,
    accounts: [
      { address: depositor, role: AccountRole.WRITABLE_SIGNER },
      { address: beneficiary, role: AccountRole.READONLY }, // beneficiary (oracle operator)
      { address: escrow, role: AccountRole.WRITABLE },
      { address: escrowToken, role: AccountRole.WRITABLE },
      { address: depositorToken, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM_ID, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
    ],
    data,
  };
}

/**
 * Perform the real deposit: ensure ATA, then call the escrow `deposit` instruction.
 * `mintAddress`/`beneficiary` override the 402 terms advertised by the server —
 * defaults come from USDC_MINT / SOLANA_PAY_TO for standalone use.
 * Returns the deposit transaction signature (confirmed on-chain).
 */
export async function depositToEscrow(
  amountBaseUnits: bigint,
  mintAddress?: string,
  beneficiary?: string
): Promise<string> {
  const { signer, address } = await loadClient();
  const mint = (mintAddress ?? USDC_DEVNET_MINT) as Address;
  const beneficiaryAddress = (beneficiary ?? SOLANA_PAY_TO) as Address;

  // Ensure depositor ATA exists before attempting the deposit (for this mint)
  await ensureDepositorAta(mintAddress);

  const depositorToken = await deriveAta(address, mint);
  const { escrow, escrowToken } = await deriveEscrow(address);

  // The deposit instruction uses `init` — a deposit fails if this wallet's
  // escrow already exists (one outstanding verification per wallet). Check
  // first so the failure is actionable instead of a cryptic simulation error.
  const existingEscrow = await rpc
    .getAccountInfo(escrow, { encoding: "base64", commitment: COMMITMENT })
    .send();
  if (existingEscrow.value !== null) {
    throw new Error(
      `Depositor escrow PDA ${escrow} already exists on-chain. ` +
        `This wallet has an outstanding verification — settle it first ` +
        `(claim from the dashboard if the outcome was YES/NO, or refund if ` +
        `UNDECIDED) and retry. Check GET /escrow/pending for its proof ID.`
    );
  }

  const depositIx = buildDepositInstruction(
    address,
    escrow,
    escrowToken,
    depositorToken,
    mint,
    amountBaseUnits,
    beneficiaryAddress
  );

  const signature = await signSimulateAndSend(signer, depositIx);
  console.log(`Deposited ${amountBaseUnits} base units of ${mint} to escrow (signature: ${signature})`);
  return signature;
}

/**
 * Get the client's SOL balance (lamports) and token balance (base units).
 */
export async function getBalances(mintOverride?: string) {
  const { address } = await loadClient();
  const mint = (mintOverride ?? USDC_DEVNET_MINT) as Address;
  const sol = await rpc.getBalance(address, { commitment: COMMITMENT }).send();
  const ata = await deriveAta(address, mint);
  let usdc: bigint | null = null;
  try {
    const tokenAccount = await rpc
      .getTokenAccountBalance(ata, { commitment: COMMITMENT })
      .send();
    usdc = BigInt(tokenAccount.value.amount);
  } catch {
    usdc = null; // ATA does not exist or cannot be read
  }
  return { address, solLamports: sol.value, usdcBaseUnits: usdc };
}

// CLI entry points
if (process.argv[1] && process.argv[1].endsWith("deposit-client.ts")) {
  const cmd = process.argv[2];
  (async () => {
    try {
      if (cmd === "address") {
        const { address } = await loadClient();
        console.log("Client address:", address);
      } else if (cmd === "balances") {
        const b = await getBalances();
        console.log("Client:", b.address);
        console.log("SOL:", Number(b.solLamports) / 1e9);
        console.log(
          "USDC:",
          b.usdcBaseUnits === null ? "0 (no ATA)" : `${Number(b.usdcBaseUnits) / 1e6} USDC`
        );
      } else if (cmd === "create-ata") {
        await ensureDepositorAta();
      } else if (cmd === "deposit") {
        const amount = BigInt(process.argv[3] || "10000"); // default $0.01
        const sig = await depositToEscrow(amount);
        console.log("Deposit signature:", sig);
      } else {
        console.log("Usage: npx tsx src/deposit-client.ts [address|balances|create-ata|deposit [amount]]");
      }
    } catch (e) {
      console.error("Error:", (e as Error).message);
      process.exit(1);
    }
  })();
}
