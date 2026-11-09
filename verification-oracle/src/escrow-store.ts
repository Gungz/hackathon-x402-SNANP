/**
 * Persistent store for escrow settlement records.
 *
 * Mirrors proofs.ts: records survive server restarts, so the dashboard's
 * pending panel does not silently lose claimable/refundable state when the
 * server restarts (the previous in-memory-only design did).
 *
 * Devnet demo store — a production deployment would read settlement state
 * from chain instead of maintaining a parallel record file.
 */

import * as fs from "fs";
import * as path from "path";

const STORE_FILE = process.env.ESCROW_RECORDS_FILE || path.join(process.cwd(), "escrow-records.json");

export interface EscrowRecordStored {
  proofId: string;
  status: "claimable" | "refundable" | "claimed" | "refunded";
  amount: string;
  clientWallet: string;
  depositor: string | null;
  /** Escrow PDA extracted from the deposit instruction — used for chain reconciliation */
  escrowPda?: string | null;
  /** Client-supplied nonce that seeds the escrow PDA (V1) */
  nonce?: number | null;
  /** True once the escrow account records the deposit transaction signature (attest landed — REQUIRED in V1) */
  attested?: boolean;
  /** Settlement (claim) transaction signatures, in order — batch claims append one per transaction */
  claimTxSignatures?: string[];
  depositSignature?: string;
  timestamp: string;
}

export function loadEscrowRecords(): EscrowRecordStored[] {
  try {
    if (!fs.existsSync(STORE_FILE)) return [];
    const data = fs.readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? (parsed as EscrowRecordStored[]) : [];
  } catch {
    return [];
  }
}

export function saveEscrowRecords(records: EscrowRecordStored[]): void {
  fs.writeFileSync(STORE_FILE, JSON.stringify(records, null, 2));
}

/** Append (or replace) a record and persist. */
export function upsertEscrowRecord(record: EscrowRecordStored): void {
  const records = loadEscrowRecords();
  const idx = records.findIndex((r) => r.proofId === record.proofId);
  if (idx >= 0) records[idx] = record;
  else records.push(record);
  saveEscrowRecords(records);
}
