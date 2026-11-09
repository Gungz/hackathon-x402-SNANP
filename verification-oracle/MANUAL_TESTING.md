# Manual End-to-End Testing Guide — VerificationOracle V1

**Read this first.** This is the honest truth about what is real and what is not.
Every step below uses real Solana Devnet transactions once the disposable client
keypair is funded with SOL + dUSD (demo token) or USDC. Unit tests mock the RPC by design; the e2e
suite covers the real flow and skips gracefully when the wallet is unfunded.

**V1 changes vs V0 — read this or the test steps make no sense:**
- Escrow is seeded per **deposit**, not per wallet: `["escrow", depositor, nonce]`.
  A wallet can hold many concurrent unsettled escrows. Nonce reuse fails on-chain.
- After the deposit confirms, the CLI (or the dashboard) submits an `attest`
  instruction writing the deposit transaction signature into the escrow account.
  **Attestation is REQUIRED** — the server will not verify an unattested escrow
  (it answers `402 attestation_required`). A program cannot know its own
  transaction's signature, which is why `attest` is a separate instruction.
- The escrow program was upgraded in place on 2026-11-09 (same program ID
  `He1b6VfhTpSzbGpSSL6jDq6TicPqP4WkvQ4xSMPkdy9a`; a ~15,000-byte program extend was needed).
- Settlement (claim/refund) is per deposit transaction. Batch claim (one
  transaction, N `claim` instructions, ≤4 per tx) exists on the dashboard.

---

## Part 0 — What you need before testing

### The disposable test wallet (created by the build)

**Public address:** `7bsn4jyj5S23bpdJUhTF949pqj6UrNvQWbavCBWsDtFT`

**Keypair file:** `verification-oracle/client-keypair.json` (gitignored)

This is a disposable devnet keypair generated during the build. Do NOT use it
on mainnet — devnet only.

### 1. Fund it with SOL (transaction fees + PDA rent)

```bash
solana airdrop 2 7bsn4jyj5S23bpdJUhTF949pqj6UrNvQWbavCBWsDtFT --url devnet
```

Or https://faucet.solana.com — paste the public address → 2 SOL per day.

### 2. Fund it with tokens (for the deposit)

**Option A — Self-minted demo token (dUSD) — already done for this wallet**

Mint `BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc`, 1,000,000 dUSD minted to the client ATA `EDt5jYJA4K3nrzdxVwusGmjuun2Xby3tVC2KPMJVbFNV`.

```bash
cd verification-oracle
export USDC_MINT=BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc
npx tsx src/deposit-client.ts balances
```

Expected: SOL > 0, dUSD ~1,000,000 (minus any deposits).

**Option B — Circle's devnet USDC faucet** — same as before; reCAPTCHA may block automation, complete it manually.

> dUSD is NOT real USDC — label it honestly in the demo.

### 3. `.env` — what must be set

```env
TINYFISH_API_KEY=...
GROQ_API_KEY=...
GEMINI_API_KEY=...            # optional fallback
SOLANA_PAY_TO=...             # operator wallet (public key) — receives claims
ESCROW_PROGRAM_ID=He1b6VfhTpSzbGpSSL6jDq6TicPqP4WkvQ4xSMPkdy9a
PORT=4021
X402_NETWORK=solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1
X402_PRICE_USD=0.01
ALLOWED_DOMAINS=bbc.com,espn.com,reuters.com,apnews.com
```

> The server needs NO operator private key. The operator claims in the browser with
> their own wallet (Phantom/Solflare). `SOLANA_PRIVATE_KEY` may exist in `.env` for
> local scripts — never copy it onto the host (see `.env.example`).

---

## Part 1 — Step-by-step manual testing

### 0. Start the server

```bash
export USDC_MINT=BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc
npm run dev
```

Stop it later with `npm run stop`. The first replay writes `spent-signatures.json`
— delete it only if you want to reset replay protection locally.

### 1. Unpaid request returns 402

```bash
curl -i http://127.0.0.1:4021/verify \
  -X POST -H "Content-Type: application/json" \
  -d '{"question":"Test?","criteria":"Test"}'
```

Expect: HTTP 402 + `PAYMENT-REQUIRED` header (base64 x402 V2 terms) + JSON body.

### 2. Stub signature is rejected

```bash
curl -i http://127.0.0.1:4021/verify \
  -X POST -H "Content-Type: application/json" \
  -H "PAYMENT-SIGNATURE: made-up-signature" \
  -d '{"question":"Test?","criteria":"Test"}'
```

Expect: HTTP 402 with `error: "payment_invalid"`. No verification runs.

### 3. REAL on-chain flow — deposit + attest + verification, one CLI run

```bash
cd verification-oracle
export USDC_MINT=BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc
npx tsx src/cli.ts verify \
  --question "Did Arsenal beat Chelsea in April 2024?" \
  --criteria "Final score after 90 minutes from official sources" \
  --yes
```

V1 change: there is no "one outstanding escrow per wallet" limit anymore. Each
deposit gets a fresh nonce; concurrent escrows are independent.

What happens (all real):

1. CLI calls `GET /verify` → 402 terms
2. CLI picks a nonce, builds the Anchor `deposit` tx, **signs and submits it** — creates the escrow PDA `["escrow", depositor, nonce]` + moves dUSD into the escrow token account
3. CLI immediately submits **`attest`** with the deposit transaction signature (second wallet approval) — writes the signature into the escrow account
4. CLI retries `POST /verify` with the real deposit signature as `PAYMENT-SIGNATURE`
5. Server verifies on-chain (`getTransaction`): program, `deposit` discriminator, amount, depositor == fee payer, **escrow PDA matches depositor+nonce**, escrow token account authority, and the escrow account **records exactly this signature** (attestation gate)
6. TinyFish Search → TinyFish Fetch → Groq (Gemini fallback) → YES/NO/UNDECIDED
7. Truth Receipt with evidence URLs + deposit signature + nonce + `attested: true` + escrow status `claimable` / `refundable`

Output includes: deposit tx link, attest tx link, nonce, escrow PDA, outcome/confidence, and full evidence URLs (dashboard renders them as clickable links; the CLI prints title + URL per source).

**Cross-check on https://explorer.solana.com/?cluster=devnet** — the deposit transaction is visible with the escrow PDA in account keys, and `getAccountInfo` on the escrow shows your deposit signature bytes at offset 91.

**Attest failure path:** if step 3 fails, the CLI stops BEFORE retry and prints the deposit signature + nonce. Recover with `npm run attest -- <depositSignature> <nonce>`, then re-run the verify command.

### 4. Replay protection (same deposit twice)

Take the deposit signature printed by step 3:

```bash
curl -s http://127.0.0.1:4021/verify -X POST -H "Content-Type: application/json" \
  -H "PAYMENT-SIGNATURE: <paste-deposit-signature>" \
  -d '{"question":"Test?","criteria":"Test"}'
```

Expect: HTTP 402 with `error: "payment_replay"` — and the spent-signature set is now persisted (`spent-signatures.json`), so it survives restarts.

### 5. Dashboard end-to-end (two approvals per verification)

Open `http://127.0.0.1:4021/`

1. Click **Connect Wallet** (Phantom/Solflare on Devnet)
2. Section 1 — submit question + criteria → **Verify Event**. The dashboard builds the real `deposit` tx; wallet approves it
3. Dashboard waits for confirmation, then builds the **`attest`** tx — second wallet approval
4. Dashboard retries `POST /verify` → result appears with outcome, confidence, evidence, deposit tx link, escrow PDA, nonce
5. Section 2 lists **one row per deposit transaction** with: short signature + explorer link, nonce, amount, depositor, `✔ attested` badge (or `⚠ attestation pending`)
6. **Batch claim:** tick the checkboxes on the claimable rows → **Claim selected (N)** → ONE transaction with N `claim` instructions (≤4 claims per transaction; larger selections fan out into sequential transactions). The server then reconciles bookkeeping in `escrow-records.json`
7. Per-row **Claim** works too (signs one `claim` instruction)
8. **Refund** is per-row and **depositor-signed only** — an operator wallet cannot produce a valid refund; the button is disabled unless the connected wallet equals the record's depositor
9. **Unattested rows** show `⚠ attestation pending`, hide Claim, keep Refund available (depositor can always get the money back)
10. The `attest` approval can also be retried from CLI: `npm run attest -- <depositSignature> <nonce>`

### 6. Unattested manual test (negative path)

If you want to see the attestation gate reject a payment:

1. `npx tsx src/deposit-client.ts deposit 10000` — it deposits AND attests; instead, build an attest-less deposit by temporarily skipping the attest call (or use `deposit-client.ts` source as a reference), then copy the deposit signature
2. `curl -s -X POST http://127.0.0.1:4021/verify -H "Content-Type: application/json" -H "PAYMENT-SIGNATURE: <sig>" -d '{"question":"q","criteria":"c"}'`
3. Expect: `402` with `attestation_required`

### 7. Refund via CLI (depositor keypair — works regardless of attestation)

```bash
export USDC_MINT=BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc
npx tsx src/deposit-client.ts refund <nonce>
```

Sends the depositor-signed `refund` transaction for THAT escrow only (sibling escrows untouched), closes the escrow token account, returns rent to the depositor.

### 8. Test suites

```bash
npm test          # 34 unit tests (RPC mocked — fast)
npm run test:e2e  # e2e tests (real APIs; real deposit skipped if unfunded)
```

Verified 2026-11-09: 34/34 unit tests green; live deposit+attest+verify returned YES 98% (proof 1794203571507); live refund ran (escrow JCZHdv… closed).

---

## Part 2 — What is mocked and what is real

| Component | Mocked? | Notes |
|---|---|---|
| TinyFish Search API | ❌ | Real, via `TINYFISH_API_KEY` |
| TinyFish Fetch API | ❌ | Real, via `TINYFISH_API_KEY` |
| Groq LLM (openai/gpt-oss-120b) | ❌ | Real, via `GROQ_API_KEY` |
| Gemini fallback | ❌ | Real, via `GEMINI_API_KEY` |
| Solana Devnet RPC `getTransaction` | ❌ in prod paths | Real HTTP call in server |
| Devnet RPC in unit tests | ✅ By design | Unit tests mock RPC |
| **Attestation gate in `npm test`** | ✅ By design | Mock escrow records the submitted signature |
| **Payment verification in production flow** | ❌ | Real `getTransaction` call to Devnet RPC |
| Deposit + attest submission (`src/deposit-client.ts`) | ❌ | Real on-chain transactions (funded keypair required) |
| Escrow program | ❌ | Deployed to Devnet, real (V1: nonce-seeded, `attest`, attestation-gated) |
| Batch claim in browser | ❌ | Real wallet signing — **test it in the browser during manual QA** (tasks 4.2/4.3 open) |
| Vault of proofs (`proofs.json`) | ❌ | Real file on disk |
| Escrow settlement records (`escrow-records.json`) | ❌ | Real file, reconciled against chain on every `/escrow/pending` |
| Replay set (`spent-signatures.json`) | ❌ | Real file on disk since V1 |

**Do NOT claim anything beyond this.** The demo credibility comes from doing steps 1–5 live.

---

## Part 3 — Status (2026-11-09)

- [x] ~~Fund `7bsn4jyj5S23bpdJUhTF949pqj6UrNvQWbavCBWsDtFT` with SOL~~ (5 SOL present)
- [x] ~~Fund with devnet USDC~~ → dUSD (mint `BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc`)
- [x] **V1 program deployed in place** (same program ID; extend 15,000 bytes) — 2026-11-09
- [x] **Live V1 run: deposit+attest+verify** — deposit `3Lbh5aX2…`, attest `5fbgrkjs…`, YES 98%, escrow `3jmFV5…` claimable (proof `1794203571507-RGlkIE1hbmNo`)
- [x] **Live refund** — deposit `JCZHdvpo…` (nonce 1794203587823178) → refunded `3zaFEcom…`, account closed on-chain
- [ ] Manual QA from this document (browser: deposit → attest → claim; batch claim; refund)
- [ ] `npm run dev` + demo run
- [ ] Deploy to host (render.yaml present — see README "Deploy")
- [ ] Delete `proofs.json` if you want a fresh demo
