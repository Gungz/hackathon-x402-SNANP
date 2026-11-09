/**
 * Local JSON proof-history store.
 *
 * Appends each verification result to a JSON file for auditability.
 * In production, this would be replaced by Walrus Memory or a durable database.
 */

import * as fs from "fs";
import * as path from "path";

const PROOFS_FILE = path.join(process.cwd(), "proofs.json");

export interface ProofRecord {
  proofId: string;
  timestamp: string;
  question: string;
  criteria: string;
  outcome: string;
  confidence: number;
  refundable: boolean;
  evidenceCount: number;
  payment: {
    network: string;
    payTo: string;
    amount: string;
    asset: string;
    refundable: boolean;
    depositSignature?: string;
    nonce?: string | null;
    attested?: boolean;
  };
}

/**
 * Load existing proof records from the JSON file.
 */
function loadProofs(): ProofRecord[] {
  try {
    if (!fs.existsSync(PROOFS_FILE)) {
      return [];
    }
    const data = fs.readFileSync(PROOFS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/**
 * Save proof records to the JSON file.
 */
function saveProofs(proofs: ProofRecord[]): void {
  fs.writeFileSync(PROOFS_FILE, JSON.stringify(proofs, null, 2));
}

/**
 * Append a new proof record to the history file.
 */
export function appendProof(record: Omit<ProofRecord, "proofId" | "timestamp"> & { proofId: string; timestamp: string }): void {
  const proofs = loadProofs();
  proofs.push(record as ProofRecord);
  saveProofs(proofs);
}

/**
 * Get all proof records.
 */
export function getProofs(): ProofRecord[] {
  return loadProofs();
}
