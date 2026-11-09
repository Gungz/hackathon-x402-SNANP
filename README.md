# VerificationOracle

**Pay-per-proof event verification for AI agents — x402 machine payments on Solana, an on-chain Anchor escrow, and an AI verdict over allowlisted web evidence, returned as an auditable Truth Receipt.**

Built for the **Encode Club × Solana Foundation — Solana Hackathon 2026** (prize track: *Best Use of x402 on Solana*). Submission links:

- **Live demo (dashboard):** see the `verification-oracle` deploy (see *Deploy* below)
- **Presentation deck:** `https://<deployed-app>/presentation.html`
- **Demo video:** linked in the Encode submission form
- **App & docs:** [`verification-oracle/`](./verification-oracle/) · **Manual testing guide:** [`verification-oracle/MANUAL_TESTING.md`](./verification-oracle/MANUAL_TESTING.md) · **Deploy:** [`verification-oracle/README.md#deploy-live-demo`](./verification-oracle/README.md)

## The 30-second version

An autonomous agent POSTs a question + resolution criteria to `POST /verify`. The server answers `402 Payment Required` with x402 V2 terms; the client deposits 0.01 USDC-equivalent (self-minted dUSD on devnet) into a nonce-seeded Anchor escrow PDA on Solana Devnet and — after the deposit confirms — submits an `attest` instruction recording the deposit transaction's signature **inside** the escrow account (a program cannot read its own signature during execution). The server then verifies the deposit on-chain (program, instruction discriminator, amount, depositor == fee payer, nonce-derived PDA, token-account authority, and the **required attestation match**), runs TinyFish Search → TinyFish Fetch → Groq LLM (`openai/gpt-oss-120b`, Gemini fallback), and returns a **Truth Receipt**: outcome (YES/NO/UNDECIDED), confidence, cited evidence URLs, the deposit transaction link, and escrow status — claimable (YES/NO) or refundable (UNDECIDED) — settleable only by wallet-signed transactions (operator claims, depositor refunds). No private key ever touches the server.

## Repo layout

```
verification-oracle/        # the product (Express API + dashboard + Anchor escrow program)
│  src/                     # server, x402 middleware, deposit/attest/refund client, CLI
│  escrow/                  # Anchor workspace — programs/escrow/src/lib.rs (V1: nonce PDA + attest)
│  public/                  # dashboard + Encode presentation deck (presentation.html)
│  tests/                   # 34 unit tests (RPC-mocked) + devnet e2e suite
│  MANUAL_TESTING.md        # honest, step-by-step manual verification guide
openspec/                   # change management (spec-driven): v0 archive + verification-oracle-v1
INSTALLATION_PLAN.md        # original hackathon research/install notes (pre-build)
```

## Quick start

```bash
cd verification-oracle
npm install
npm test                 # 34 unit tests (no network needed)
cp .env.example .env     # fill three keys (TinyFish, Groq, Gemini) + SOLANA_PAY_TO
export USDC_MINT=BUMDmMChHnBuzE7yzVegoojKDgz383zMwNAxb3Lgd8uc   # demo dUSD
npm run dev              # http://127.0.0.1:4021
npm run verify -- --question "Did Manchester City win the 2023-24 Premier League title?" \
  --criteria "Winner declared by the Premier League for the 2023-24 season" --yes
```

Full walkthrough — incl. the 402 → deposit → attest → verify flow, dashboard batch-claim, refund, and replay protection — is in [`verification-oracle/MANUAL_TESTING.md`](./verification-oracle/MANUAL_TESTING.md).

## Built for agentic payments

Track focus: **Best Use of x402 on Solana**. The whole loop is machine-native: no API keys, no accounts, no human in the payment path — a program-verifiable deposit on Solana gates a paid AI capability; settlement is a signature, not a wire transfer process.

## Status / honest limitations

- **Devnet only.** The escrow program and all token flows run on Solana Devnet with a self-minted demo token (**dUSD**), because Circle's devnet faucet blocks automation behind a CAPTCHA. The deposit code path is mint-agnostic — swapping `USDC_MINT` uses Circle devnet USDC or mainnet USDC unchanged.
- **Not audited.** Experimental code for a hackathon; do not secure real value with it yet.
- **Devnet dev tokens.** Never commit `client-keypair.json` or `.env` (both gitignored); the host needs only read-path keys.

## License

MIT — see [LICENSE](./LICENSE).
