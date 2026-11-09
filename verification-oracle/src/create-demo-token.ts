/**
 * Creates a self-minted devnet SPL token ("dUSD") for hackathon demos where
 * the Circle devnet USDC faucet is unavailable.
 *
 * Usage:
 *   npx tsx src/create-demo-token.ts
 *
 * Performs two real devnet transactions signed by the disposable client
 * keypair (CLIENT_WALLET_PATH, default ./client-keypair.json):
 *   1. createAccount + InitializeMint2 — new mint, decimals = 6,
 *      mint authority = the disposable client wallet
 *   2. create-ATA (idempotent) + MintTo — mints 1,000,000 dUSD to the client's ATA
 *
 * The mint address is printed and written to ./demo-token.json so later runs
 * (server, CLI) can point USDC_MINT at it:
 *
 *   USDC_MINT=<mint> npx tsx src/cli.ts verify --question ... --criteria ... --yes
 *   USDC_MINT=<mint> npm run dev
 *
 * Devnet only. The mint authority stays with the disposable keypair —
 * never reuse this mint or keypair on mainnet.
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import {
  createSolanaRpc,
  createTransactionMessage,
  pipe,
  appendTransactionMessageInstruction,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  estimateResourceLimitsFactory,
  estimateAndSetResourceLimitsFactory,
  type Address,
  type Signature,
} from "@solana/kit";
import {
  getCreateAccountInstruction,
  SYSTEM_PROGRAM_ADDRESS,
} from "@solana-program/system";
import {
  getInitializeMint2Instruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { loadClient, deriveAta } from "./deposit-client";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const COMMITMENT = "confirmed" as const;
const DECIMALS = 6;
const SUPPLY_UI = 1_000_000n; // 1,000,000 dUSD
const SUPPLY_BASE_UNITS = SUPPLY_UI * 10n ** BigInt(DECIMALS);
const MINT_SPACE = 82n;

const rpc = createSolanaRpc(RPC_URL);

async function confirmSignature(signature: Signature, timeoutMs = 60_000, pollMs = 1500) {
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
      (status?.slot != null && Date.now() > deadline - pollMs)
    ) {
      return signature;
    }
    if (Date.now() > deadline) {
      throw new Error(`Signature not confirmed within ${timeoutMs}ms: ${signature}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

const estimator = estimateResourceLimitsFactory({ rpc });
const estimateAndSetResourceLimits = estimateAndSetResourceLimitsFactory(estimator);

async function signSimulateSendConfirm(
  feePayer: Awaited<ReturnType<typeof loadClient>>["signer"],
  instructions: any[]
): Promise<Signature> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: COMMITMENT }).send();

  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => instructions.reduce((msg, ix) => appendTransactionMessageInstruction(ix, msg), m)
  );

  // Estimate resource limits from a real simulation (max limits → measure → set)
  const withLimits = await estimateAndSetResourceLimits(message);

  const signed = await signTransactionMessageWithSigners(withLimits as any);
  const wire = getBase64EncodedWireTransaction(signed);
  const signature = await rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: COMMITMENT }).send();
  await confirmSignature(signature);
  return signature;
}

(async () => {
  try {
    const { signer: payer, address: payerAddress } = await loadClient();
    console.log(`Payer / mint authority: ${payerAddress}`);

    // 1. Fresh mint keypair (not persisted — not needed after initialization)
    const mint = await generateKeyPairSigner();
    const mintAddress = mint.address as Address;
    console.log(`\nStep 1 — create + initialize mint (${mintAddress})`);

    const rent = await rpc.getMinimumBalanceForRentExemption(MINT_SPACE).send();
    const createMintIx = getCreateAccountInstruction({
      payer,
      newAccount: mint,
      lamports: rent,
      space: MINT_SPACE,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    });
    const initMintIx = getInitializeMint2Instruction({
      mint: mintAddress,
      decimals: DECIMALS,
      mintAuthority: payerAddress,
    });
    const createSig = await signSimulateSendConfirm(payer, [createMintIx, initMintIx]);
    console.log(`Mint initialized (signature: ${createSig})`);

    // 2. ATA + mint supply to the payer wallet
    console.log(`\nStep 2 — create ATA + mint ${SUPPLY_UI} dUSD`);
    const ata = await deriveAta(payerAddress, mintAddress);
    const createAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer,
      owner: payerAddress,
      mint: mintAddress,
    });
    const mintToIx = getMintToInstruction({
      mint: mintAddress,
      token: ata,
      mintAuthority: payer,
      amount: SUPPLY_BASE_UNITS,
    });
    const mintSig = await signSimulateSendConfirm(payer, [createAtaIx, mintToIx]);
    console.log(`Minted ${SUPPLY_UI} dUSD to ATA ${ata} (signature: ${mintSig})`);

    // Persist the mint info for docs and later runs
    const info = {
      name: "Demo US Dollar",
      symbol: "dUSD",
      decimals: DECIMALS,
      mint: mintAddress,
      ata,
      mintAuthority: payerAddress,
      supply: SUPPLY_UI.toString(),
      createSignature: createSig,
      mintSignature: mintSig,
      createdAt: new Date().toISOString(),
      note: "Self-minted devnet demo token. Devnet only — not USDC.",
    };
    const outPath = path.join(process.cwd(), "demo-token.json");
    fs.writeFileSync(outPath, JSON.stringify(info, null, 2) + "\n");
    console.log(`\nWrote ${outPath}`);
    console.log(`\nUse it:`);
    console.log(`  USDC_MINT=${mintAddress} npm run dev`);
    console.log(`  USDC_MINT=${mintAddress} npx tsx src/cli.ts verify --question "..." --criteria "..." --yes`);
  } catch (e) {
    console.error("Error:", (e as Error).message);
    process.exit(1);
  }
})();
