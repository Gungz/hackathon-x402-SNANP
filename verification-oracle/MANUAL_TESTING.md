# Manual End-to-End Testing Guide — VerificationOracle V0

**Read this first.** This is the honest truth about what is real and what is not.
Every step below uses real Solana Devnet transactions once the disposable client
keypair is funded with SOL + dUSD (demo token) or USDC. Unit tests mock the RPC by design; the e2e
test covers the real flow and skips gracefully when the wallet is unfunded.

---

## Part 0 — What you need before testing

### The disposable test wallet (created by the build)

**Public address:** `7bsn4jyj5S23bpdJUhTF949pqj6UrNvQWbavCBWsDtFT`

**Keypair file:** `verification-oracle/client-keypair.json` (gitignored)

This is a disposable devnet keypair generated during the build. Do NOT use it
on mainnet — devnet only.

### 1. Fund it with SOL (transaction fees + PDA rent)

Option A — Solana CLI (retry if rate-limited):

```bash
solana airdrop 2 7bsn4jyj5S23bpdJUhTF949pqj6UrNvQWbavCBWsDtFT --url devnet
```

Option B — Web airdrop when CLI is rate-limited:

- https://faucet.solana.com — paste the public address → 2 SOL per day

### 2. Fund it with tokens (for the deposit)

Two options — the self-minted demo token is the one that works without a
CAPTCHA-gated faucet:

**Option A — Self-minted demo token (dUSD) — already done for this wallet**

A dUSD mint was created on devnet and 1,000,000 dUSD were minted to the
client's ATA (see `demo-token.json`):

- Mint: `BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc`
- Client ATA: `EDt5jYJA4K3nrzdxVwusGmjuun2Xby3tVC2KPMJVbFNV`
- Mint authority: the disposable client keypair (devnet only)

To recreate or mint more:

```bash
cd verification-oracle
npx tsx src/create-demo-token.ts   # creates mint + ATA + 1,000,000 dUSD
```

Use it by exporting `USDC_MINT` pointing at the dUSD mint — for the server,
the CLI, and the client:

```bash
export USDC_MINT=BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc
npm run dev                     # server verifies deposits of dUSD
npx tsx src/cli.ts verify ... --yes
```

> The deposit flow is SPL Token mint-agnostic — dUSD exercises the exact same
> code path as USDC. It is NOT real USDC; label it honestly in the demo.

**Option B — Circle's devnet USDC faucet (official Solana USDC faucet)**

1. Go to https://faucet.circle.com
2. Choose **Solana** → **Devnet**
3. Paste: `7bsn4jyj5S23bpdJUhTF949pqj6UrNvQWbavCBWsDtFT`
4. Request USDC (typically 10–50 USDC)

> Note: the faucet sits behind a reCAPTCHA that blocks bots — if it reports
> "unusual traffic", complete it manually in your browser.

### 3. Create the client's token account (ATA)

The ATA already exists for dUSD (created by `create-demo-token.ts`). For a
fresh token/mint (e.g. Circle USDC after Option B):

```bash
cd verification-oracle
USDC_MINT=<mint-address> npx tsx src/deposit-client.ts create-ata
```

### 4. Verify balances

```bash
USDC_MINT=BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc npx tsx src/deposit-client.ts balances
```

Expected: SOL > 0, dUSD > 0 (1,000,000 for this wallet).

---

## Part 1 — Step-by-step manual testing

### 0. Start the server

```bash
export USDC_MINT=BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc
npm run dev

# stop it later (kills the npm wrapper AND the tsx child on port 4021):
npm run stop            # preview first: npm run stop -- --dry-run
```

The server verifies deposits of the dUSD mint when `USDC_MINT` is set; without
it it expects Circle's devnet USDC.

### 1. Unpaid request returns 402

```bash
curl -i http://127.0.0.1:4021/verify \
  -X POST -H "Content-Type: application/json" \
  -d '{"question":"Test?","criteria":"Test"}'
```

Expect: HTTP 402 + `PAYMENT-REQUIRED` header (base64 x402 V2 terms) + JSON body.

### 2. Stub signature is now rejected

```bash
curl -i http://127.0.0.1:4021/verify \
  -X POST -H "Content-Type: application/json" \
  -H "PAYMENT-SIGNATURE: made-up-signature" \
  -d '{"question":"Test?","criteria":"Test"}'
```

Expect: HTTP 402 with `error: "payment_invalid"`. No verification runs.

### 3. REAL on-chain flow — CLI payment + verification

```bash
cd verification-oracle
export USDC_MINT=BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc
npx tsx src/cli.ts verify \
  --question "Did Arsenal beat Chelsea in April 2024?" \
  --criteria "Final score after 90 minutes from official sources" \
  --yes
```

**Prerequisite:** this wallet can only have one outstanding escrow. If a
previous verification was never settled, the deposit fails with "Depositor
 escrow PDA … already exists". Settle it first — check
`curl http://127.0.0.1:4021/escrow/pending`; claim (YES/NO) or refund
(UNDECIDED) via the dashboard, then re-run the command.

What happens (all real):

1. CLI calls `GET /verify` → gets 402 with payment terms
2. CLI builds an Anchor `deposit` transaction via `@solana/kit` → **signs and
   submits it to Solana Devnet** — creates the escrow PDA + deposits dUSD (demo token)
3. CLI retries `POST /verify` with the deposit's **real transaction signature**
4. Server verifies the transaction on-chain via Devnet RPC (`getTransaction`):
   program = escrow, instruction = `deposit`, amount matches
5. Server runs TinyFish Search → TinyFish Fetch → Groq LLM → YES/NO/UNDECIDED
6. Truth Receipt returned with evidence + escrow status `claimable` / `refundable`

Output includes:
- `Deposit transaction: https://explorer.solana.com/tx/<sig>?cluster=devnet`
- `Outcome`, `Confidence`, `Proof ID`, evidence source URLs

**Cross-check on https://explorer.solana.com/?cluster=devnet** — the deposit
transaction is visible with the escrow PDA in account keys.

### 4. Replay protection (same deposit twice)

Take the transaction signature printed by step 3:

```bash
curl -s http://127.0.0.1:4021/verify -X POST -H "Content-Type: application/json" \
  -H "PAYMENT-SIGNATURE: <paste-transaction-signature>" \
  -d '{"question":"Test?","criteria":"Test"}'
```

Expect: HTTP 402 with `error: "payment_replay"` — the same deposit transaction
cannot be used twice.

### 5. Dashboard end-to-end

Open `http://127.0.0.1:4021/`

1. Click **Connect Wallet** (Phantom/Solflare on Devnet)
2. In section 1, submit the question — set a question and criteria, click **Verify Event**
3. The dashboard builds a **real `deposit` transaction** (0.01 dUSD → escrow PDA)
   and asks your wallet to sign it
4. On approval, the dashboard retries `POST /verify` with the transaction signature
5. The result appears with outcome, confidence, and evidence sources
6. Section 2 **Pending Claims** lists the claimable escrow record with your Proof ID
7. Click **Claim** → wallet signs the `claim` instruction → dUSD moves from the
   escrow PDA to the operator's wallet. Check balance before/after.
   The server reconciles `escrow-records.json` against chain on every
   `/escrow/pending` call; the HTTP claim/refund endpoints independently verify
   the settlement transaction on-chain when a `signature` is provided.

### 6. Test suites

```bash
npm test          # 33 unit tests (RPC mocked — fast)
npm run test:e2e  # 3 e2e tests (real APIs; real deposit skipped if unfunded)
```

---

## Part 2 — What is mocked and what is real

| Component | Mocked? | Notes |
|---|---|---|
| TinyFish Search API | ❌ | Real, via `TINYFISH_API_KEY` |
| TinyFish Fetch API | ❌ | Real, via `TINYFISH_API_KEY` |
| Groq LLM (openai/gpt-oss-120b) | ❌ | Real, via `GROQ_API_KEY` |
| Gemini fallback | ❌ | Real, via `GEMINI_API_KEY` |
| Solana Devnet RPC `getTransaction` | ❌ in prod paths | Real HTTP call in server |
| Devnet RPC in unit tests | ✅ By design | Unit tests mock RPC; e2e doesn't skip |
| **Payment verification in `npm test`** | ✅ By design | Uses mocked RPC response — deterministic |
| **Payment verification in production flow** | ❌ | Real `getTransaction` call to Devnet RPC |
| Deposit transaction submission (`src/deposit-client.ts`) | ❌ | Real on-chain transaction (needs funded keypair) |
| Escrow program | ❌ | Deployed to Devnet, real |
| Dashboard claim/refund | ❌ | Real — requires the deposit to exist first |
| Proof history | ❌ | Real file on disk (`proofs.json`) |
| Escrow settlement records | ❌ | Real file on disk (`escrow-records.json`), reconciled against chain |
| `proofs.json` reset | n/a | Delete before demo to clear |

**Do NOT claim anything beyond this.** The demo credibility comes from doing
steps 1–5 live, not from what's in this section.

---

## Part 3 — What still needs your action

- [x] ~~Fund `7bsn4jyj5S23bpdJUhTF949pqj6UrNvQWbavCBWsDtFT` with SOL~~ (5 SOL present)
- [x] ~~Fund it with devnet USDC~~ → **replaced by self-minted dUSD** (mint
      `BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc`, 1,000,000 minted to client ATA)
- [ ] `USDC_MINT=BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc npm run dev`
      + `USDC_MINT=BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc npx tsx src/cli.ts verify ... --yes`
- [x] **REAL deposit executed** — signature
      `5u1ZCoT9Gq78EUPNwK9Rqphfqm3JWk8eKmp32t6xcxThGL1x4BtavQUiXG4FF5LqdxRQaG7W72hV3uKMYn7PboG1`
      (https://explorer.solana.com/tx/5u1ZCoT9Gq78EUPNwK9Rqphfqm3JWk8eKmp32t6xcxThGL1x4BtavQUiXG4FF5LqdxRQaG7W72hV3uKMYn7PboG1?cluster=devnet)
      YES 99% confidence, escrow claimable, tx confirmed on-chain (escrow program instruction)
- [ ] Set `ESCROW_PROGRAM_ID=He1b6VfhTpSzbGpSSL6jDq6TicPqP4WkvQ4xSMPkdy9a`
      in `verification-oracle/.env` (without trailing period — I sanitize it,
      but clean values are better)
- [ ] Delete `proofs.json` if you want a fresh demo
- [ ] Commit the code to a public repo (required for hackathon submission)
