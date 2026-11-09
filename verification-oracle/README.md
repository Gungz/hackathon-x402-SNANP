# VerificationOracle V0

Pay-per-proof event verification API using x402 on **Solana Devnet**, with an **on-chain Anchor escrow program**, **TinyFish** web search and content extraction, and **Groq** LLM reasoning.

## What it does

A `POST /verify` endpoint accepts a question and resolution criteria, negotiates x402 V2 payment, and runs a real verification pipeline:

1. **TinyFish Search API** — ranked web results (allowlisted domains only)
2. **TinyFish Fetch API** — extract clean page content from top results
3. **Groq LLM** (`openai/gpt-oss-120b`) — reason about the evidence → YES / NO / UNDECIDED
4. **Gemini** fallback if Groq rate-limits
5. **Truth Receipt** — outcome, confidence, evidence URLs, payment reference, escrow status

```
Client SDK ──▶ POST /verify ──▶ 402 Payment Required
                                    │
                 Client deposits SPL tokens (USDC/USDT/dUSD) to escrow PDA (on-chain)
                                    │
                Retry with PAYMENT-SIGNATURE (proof of deposit)
                                    │
                                    ▼
                    TinyFish Search → TinyFish Fetch → Groq LLM
                                    │
                            YES / NO / UNDECIDED
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
              YES / NO                        UNDECIDED
                    │                               │
          Escrow: claimable              Escrow: refundable
                    │                               │
        Operator claims via             Client refunds via
        dashboard + wallet              dashboard + wallet
```

## Quick Start

### Prerequisites

- Node.js 24+
- Rust + Solana CLI + Anchor CLI (for the escrow program)
- Solana CLI configured for **Devnet** with a wallet

### Install

```bash
cd verification-oracle
npm install
```

### Fund the disposable client keypair (real payment flow)

A disposable devnet keypair was generated during build:

**Public address:** `7bsn4jyj5S23bpdJUhTF949pqj6UrNvQWbavCBWsDtFT`
(`client-keypair.json`, gitignored)

1. Fund with SOL (devnet faucet):
   ```bash
   solana airdrop 2 7bsn4jyj5S23bpdJUhTF949pqj6UrNvQWbavCBWsDtFT --url devnet
   # or https://faucet.solana.com
   ```
2. Fund with tokens — two options:
   - **Self-minted demo token (dUSD) — done**: mint `BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc`,
     1,000,000 dUSD minted to the client ATA (`demo-token.json`). Run everything with
     `export USDC_MINT=BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc`.
     (`npx tsx src/create-demo-token.ts` recreates it if needed.)
   - **Circle devnet USDC**: https://faucet.circle.com → select **Solana** → **Devnet** → paste
     address. (The faucet sits behind a reCAPTCHA that blocks bots — complete it manually.)
3. Create the token account (ATA) — dUSD ATA already exists; for a fresh mint:
   ```bash
   USDC_MINT=<mint-address> npx tsx src/deposit-client.ts create-ata
   ```
4. Verify balances:
   ```bash
   USDC_MINT=BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc npx tsx src/deposit-client.ts balances
   ```

### `.env` template

Create `verification-oracle/.env` — **never commit this file**:

```env
# TinyFish (search + fetch) — https://agent.tinyfish.ai/api-keys
TINYFISH_API_KEY=...

# Groq (LLM reasoning, free tier) — https://console.groq.com/keys
GROQ_API_KEY=...

# Gemini (fallback LLM) — https://aistudio.google.com/apikey
GEMINI_API_KEY=...

# Solana Devnet — oracle operator wallet (public key; receives escrow claims)
SOLANA_PAY_TO=...

# Escrow program (deployed) — no trailing period
ESCROW_PROGRAM_ID=He1b6VfhTpSzbGpSSL6jDq6TicPqP4WkvQ4xSMPkdy9a

# Demo: self-minted devnet token (dUSD) — omit to accept Circle's devnet USDC
# USDC_MINT=BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc

# Client keypair used by CLI to sign and submit real deposits
CLIENT_WALLET_PATH=./client-keypair.json

# Server
PORT=4021
X402_NETWORK=solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1
X402_PRICE_USD=0.01
ALLOWED_DOMAINS=bbc.com,espn.com,reuters.com,apnews.com
```

> **No private key is needed** by the server. The operator claims or refunds
> escrow earnings through the web dashboard with their own wallet
> (Phantom/Solflare), signing the transaction client-side.
> The client keypair (`client-keypair.json`) is used only by the CLI to sign
> real `deposit` transactions from the client side.

### Run the server

```bash
# dUSD demo token:
USDC_MINT=BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc npm run dev

# (with Circle devnet USDC in .env instead, just `npm run dev`)
```

Server starts on `http://127.0.0.1:4021`.

### Open the dashboard

`http://127.0.0.1:4021/`

### Use the CLI

```bash
# Signs + submits a real devnet deposit (0.01 dUSD in the demo):
USDC_MINT=BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc npm run verify -- \
  --question "Did Manchester City win the 2023-24 Premier League title?" \
  --criteria "Winner declared by the Premier League for the 2023-24 season" \
  --yes
```

`--yes` is required — it is the explicit approval to sign and submit the
deposit transaction (W009-style agent approval gate).

### Run the demo seed

```bash
npx tsx scripts/seed.ts
```

## Escrow Smart Contract (Anchor, Solana Devnet)

A minimal SPL Token escrow program located at `verification-oracle/escrow/`:

| Instruction | Signer | Effect |
|---|---|---|
| `deposit(amount, beneficiary)` | Client | Client locks SPL tokens into the escrow PDA |
| `claim()` | Beneficiary (oracle) | Releases locked tokens to the operator wallet |
| `refund()` | Depositor (client) | Returns locked tokens to the client wallet |

- Built against the original **SPL Token** program (`Tokenkeg...`) — same program
  USDT uses on Solana mainnet. Token-2022 not required.
- Uses TokenInterface-compatible transfers internally as well (compatible with
  both SPL Token and Token-2022 mints where applicable).
- Deployed to **Devnet** at program ID `He1b6VfhTpSzbGpSSL6jDq6TicPqP4WkvQ4xSMPkdy9a`.

Deploy again with:

```bash
npm run deploy:escrow
```

## Tests

```bash
# Unit tests (RPC/TinyFish/Groq mocked) — 33 tests
npm test

# E2E tests (full server, real API calls) — 3 tests
npm run test:e2e
```

## Payment flow (on-chain, real)

```
Client (CLI) ──▶ POST /verify ──▶ 402 (x402 V2 payment terms, SPL-token base units, escrow program)
                                      │
                       Client builds + signs Anchor `deposit` transaction
                       (creates escrow PDA, locks the token in the escrow token account)
                                      │
                       Retry with PAYMENT-SIGNATURE = deposit tx signature
                                      │
                                      ▼
                       Server verifies the deposit on-chain via devnet RPC:
                         • invoked program == escrow program
                         • instruction == `deposit`, data discriminator valid
                         • amount matches x402 requirement, depositor == fee payer
                         • token mint present in account keys
                         • escrow PDA exists, owned by program, amount matches, not settled
                         • escrow token account holds ≥ amount, authority == escrow PDA
                         • signature not already spent (replay protection)
                                      │
                    TinyFish Search → TinyFish Fetch → Groq LLM
                                      │
                            YES / NO / UNDECIDED
                                      │
                    ┌───────────────┴───────────────┐
                    │                               │
              YES / NO                        UNDECIDED
                    │                               │
          Escrow: claimable              Escrow: refundable
                    │                               │
        Operator claims via             Client refunds via
        dashboard + wallet              dashboard + wallet
```

**No wallet funding needed for the AI verification itself — but the deposit is
a real on-chain Devnet transaction and requires the steps above (dUSD works
without the Circle faucet).**

### Escrow semantics — read this

- One outstanding escrow **per depositor wallet**: the escrow PDA is seeded
  `["escrow", depositor]` and uses `init`, so a second parallel deposit from the
  same wallet **fails on-chain** until the first escrow is claimed or refunded.
- Different depositors can verify in parallel.
- Funds never merge: `init` cannot deposit into an existing escrow.
- Production design: seed the escrow with a depositor-supplied nonce
  (`["escrow", depositor, nonce]`) to support concurrent verifications per wallet.

## API

### `POST /verify`

Request:

```json
{
  "question": "Did Arsenal beat Chelsea in their April 2024 match?",
  "criteria": "Final score after 90 minutes from official match reports",
  "allowedSources": ["https://www.espn.com/soccer/match/_/gameId/671312"]
}
```

**Unverified** → `402 Payment Required` with `PAYMENT-REQUIRED` header.

**Verified** → `200 OK` with the Truth Receipt:

```json
{
  "outcome": "YES",
  "confidence": 0.99,
  "evidence": [{ "source": "www.espn.com", "url": "...", "title": "Arsenal 5-0 Chelsea...", "excerpt": "..." }],
  "proofId": "1794155446934-RGlkIE1hbmNo",
  "payment": {
    "x402Version": 2,
    "success": true,
    "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    "payTo": "...",
    "amount": "10000",
    "asset": "BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc",
    "refundable": false,
    "escrowStatus": "claimable",
    "depositSignature": "5u1ZCoT9Gq78EUPNwK9Rqphfqm3JWk8eKmp32t6xcxThGL1x4BtavQUiXG4FF5LqdxRQaG7W72hV3uKMYn7PboG1",
    "depositor": "7bsn4jyj5S23bpdJUhTF949pqj6UrNvQWbavCBWsDtFT",
    "depositTransactionUrl": "https://explorer.solana.com/tx/5u1Z…?cluster=devnet"
  },
  "timestamp": "2026-11-08T16:30:46.934Z",
  "escrowStatus": "claimable",
  "llmProvider": "groq",
  "reasoning": "..."
}
```

### `GET /escrow/pending`

Returns claimable and refundable escrow records.

## How claims work

The operator opens the dashboard, connects their Solana wallet, reviews
pending claims, and signs the `claim` (or `refund`) transaction from the
browser. No private key ever touches the server.

Settlement bookkeeping is kept honest two ways:

- **On every `GET /escrow/pending`**, the server checks each pending record's
  escrow PDA on-chain; a closed escrow means the claim/refund already landed
  and the record is marked `claimed`/`refunded` automatically.
- **`POST /escrow/:proofId/claim|refund`** accepts a settlement transaction
  signature and verifies it on-chain (program, claim/refund discriminator,
  escrow PDA match, signer is the beneficiary/depositor) before flipping the
  record. Records persist to `escrow-records.json` across restarts.

## Hackathon track mapping

- **Solana AI Track** — x402 machine payments + AI verification oracle + on-chain escrow
- **Tatum × Walrus Total Recall** — Truth Receipts in Walrus Memory feed agent accuracy learning loops
- **Nimiq Mini Apps** — Consumer verification shell inside Nimiq Pay (NIM/USDT via EVM)
- **PayPal AI Hackathon** — PayPal-funded treasury top-up for bot verification credits

## Project structure

```
verification-oracle/
├── src/
│   ├── server.ts          # Express server, /verify, /escrow/*, payment middleware
│   ├── client.ts          # x402 payment-aware fetch client
│   ├── cli.ts             # Agent CLI (--yes approval gate before signing)
│   ├── deposit-client.ts  # Real devnet deposit builder (v1 tx, estimate limits, confirm)
│   ├── create-demo-token.ts # Self-minted dUSD demo token creator
│   ├── payment-verify.ts  # On-chain deposit verification (escrow PDA + token checks)
│   ├── search.ts          # TinyFish Search API
│   ├── fetch-content.ts   # TinyFish Fetch API
│   ├── llm-reason.ts      # Groq LLM + Gemini fallback
│   ├── llm-extractor.ts   # LLM extraction helpers
│   ├── allowlist.ts       # Domain allowlist
│   ├── proofs.ts          # Local JSON proof-history
│   └── parsers.ts         # Deterministic source parsers
├── escrow/                # Anchor workspace (programs/escrow/src/lib.rs)
├── tests/{unit,e2e}/      # node:test suites (unit mocks RPC; e2e hits real APIs/devnet)
├── scripts/seed.ts        # Demo seed (3 preset verifications)
├── demo-token.json        # dUSD mint/ATA record (no secrets)
└── public/index.html      # Web dashboard
```
