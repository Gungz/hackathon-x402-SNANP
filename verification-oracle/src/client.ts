/**
 * x402 V2 payment-aware fetch client for VerificationOracle.
 *
 * For V0 demo purposes, this client:
 * 1. Sends a request to the verification endpoint
 * 2. On 402 Payment Required, parses the PAYMENT-REQUIRED header
 * 3. Performs a real on-chain deposit to the escrow program (pays the fee,
 *    locks the USDC) via ./deposit-client
 * 4. Retries with the deposit transaction's PAYMENT-SIGNATURE header
 * 5. Returns the verified result with the PAYMENT-RESPONSE header
 */

export interface PaymentRequirement {
  scheme: string;
  network: string;
  payTo: string;
  amount: string;
  asset: string;
  maxTimeoutSeconds: number;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequired {
  x402Version: number;
  accepts: PaymentRequirement[];
}

export interface PaymentResponse {
  x402Version: number;
  success: boolean;
  network: string;
  payTo: string;
  amount: string;
  asset: string;
  refundable?: boolean;
  escrowStatus?: "claimable" | "refundable" | string;
  depositSignature?: string;
  depositor?: string | null;
  escrowPda?: string | null;
  nonce?: string | null;
  attested?: boolean;
  memoryStored?: boolean;
  depositTransactionUrl?: string;
}

export interface EvidenceItem {
  source: string;
  url?: string;
  title?: string;
  excerpt?: string;
}

export interface VerifyResult {
  outcome: string;
  evidence: EvidenceItem[];
  confidence: number;
  payment: PaymentResponse;
  proofId: string;
  timestamp: string;
  escrowStatus?: string;
  llmProvider?: string;
  reasoning?: string;
}

const BASE_URL = process.env.VERIFICATION_ORACLE_URL || "http://127.0.0.1:4021";

/**
 * Parse a base64-encoded header into a JSON object of type T.
 * Used for both PAYMENT-REQUIRED and PAYMENT-RESPONSE headers.
 */
function parseBase64Json<T>(header: string): T {
  const json = Buffer.from(header, "base64").toString("utf-8");
  return JSON.parse(json) as T;
}

function parsePaymentRequired(header: string): PaymentRequired {
  return parseBase64Json<PaymentRequired>(header);
}

/**
 * Encode a PaymentResponse object into a base64-encoded PAYMENT-RESPONSE header.
 */
function encodePaymentResponse(response: PaymentResponse): string {
  return Buffer.from(JSON.stringify(response)).toString("base64");
}

/**
 * Verify an event through the x402-protected verification endpoint.
 * Handles the full payment flow: request → 402 → pay → retry → 200.
 */
export async function verifyEvent(
  question: string,
  criteria: string,
  allowedSources?: string[]
): Promise<VerifyResult> {
  const response = await fetch(`${BASE_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, criteria, allowedSources }),
  });

  // If payment is required, perform a real deposit to the escrow program
  if (response.status === 402) {
    const paymentRequiredHeader = response.headers.get("PAYMENT-REQUIRED");
    if (!paymentRequiredHeader) {
      throw new Error("402 response missing PAYMENT-REQUIRED header");
    }

    const paymentRequired: PaymentRequired = parsePaymentRequired(paymentRequiredHeader);
    const requirement = paymentRequired.accepts[0];
    const amount = BigInt(requirement.amount ?? "10000");

    console.log(
      `Payment required: ${requirement.amount} base units on ${requirement.network} to ${requirement.payTo}`
    );
    console.log("Depositing to escrow on Solana Devnet…");

    const { depositToEscrow } = await import("./deposit-client");
    const deposit = await depositToEscrow(amount, requirement.asset, requirement.payTo);
    const paymentSignature = deposit.signature;
    console.log(`Nonce: ${deposit.nonce}`);
    console.log(`Escrow PDA: ${deposit.escrowPda}`);
    console.log(
      `Deposit transaction: https://explorer.solana.com/tx/${paymentSignature}?cluster=devnet\n`
    );

    const retryResponse = await fetch(`${BASE_URL}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": paymentSignature,
      },
      body: JSON.stringify({ question, criteria, allowedSources }),
    });

    if (!retryResponse.ok) {
      throw new Error(`Payment retry failed: ${retryResponse.status}`);
    }

    const paymentResponseHeader = retryResponse.headers.get("PAYMENT-RESPONSE");
    const paymentResponse: PaymentResponse = paymentResponseHeader
      ? parseBase64Json<PaymentResponse>(paymentResponseHeader) // same base64+JSON structure
      : {
          x402Version: 2,
          success: true,
          network: requirement.network,
          payTo: requirement.payTo,
          amount: requirement.amount,
          asset: requirement.asset,
        };

    const body = (await retryResponse.json()) as {
      outcome: string;
      evidence: EvidenceItem[];
      confidence: number;
      proofId: string;
      timestamp: string;
      escrowStatus?: string;
      llmProvider?: string;
      reasoning?: string;
    };

    return {
      ...body,
      payment: paymentResponse,
    };
  }

  if (!response.ok) {
    throw new Error(`Verification request failed: ${response.status}`);
  }

  return (await response.json()) as VerifyResult;
}

export { BASE_URL };
