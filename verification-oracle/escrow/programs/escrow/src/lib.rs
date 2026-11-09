//! x402 Verification Escrow Program (V1 — multi-payment + attestation)
//!
//! Locks SPL Token / Token-2022 payments (USDT/USDC) for an AI oracle
//! verification request until the oracle completes and the operator claims,
//! or the client reclaims funds when the verification is inconclusive.
//!
//! V1 changes (BREAKING account layout — V0 escrows must be settled first):
//!   - Escrow PDA is seeded with a client-supplied nonce: one depositor can
//!     hold many concurrent escrows. Reusing a nonce fails on-chain (init).
//!   - `attest(deposit_tx_signature)` records the deposit transaction
//!     signature inside the escrow account. A program cannot read its own
//!     transaction's signature during execution (it commits to the message),
//!     so attestation is a separate, client-submitted instruction right
//!     after the deposit confirms. First write wins; re-attesting with the
//!     same 64 bytes is a no-op; a different signature fails.
//!   - `claim` / `refund` re-derive the escrow PDA from the stored
//!     depositor + stored nonce. Refund stays depositor-signed only and
//!     ignores attestation so funds can never be stranded by a failed
//!     attestation.
//!
//! Instructions:
//!   deposit(amount, nonce)      — client locks tokens into the nonce-seeded escrow PDA
//!   attest(deposit_tx_signature) — record the deposit transaction signature (required for settlement audit)
//!   claim()                     — beneficiary (oracle operator) claims tokens
//!   refund()                    — depositor reclaims tokens (UNDECIDED / failed attest)

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use anchor_spl::token;

declare_id!("He1b6VfhTpSzbGpSSL6jDq6TicPqP4WkvQ4xSMPkdy9a");

pub mod constants {
    pub const ESCROW_SEED: &[u8] = b"escrow";
    pub const ESCROW_TOKEN_SEED: &[u8] = b"escrow-token";
}

use constants::*;

#[program]
pub mod escrow {
    use super::*;

    /// Deposit an SPL token payment into escrow.
    /// The depositor transfers `amount` to the nonce-seeded escrow PDA's token
    /// account. `beneficiary` is the oracle operator wallet that can claim later.
    /// A fresh `nonce` lets the same depositor hold many concurrent escrows.
    pub fn deposit(ctx: Context<Deposit>, amount: u64, nonce: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(amount > 0, ErrorCode::InvalidAmount);

        // Transfer tokens from the depositor's account to the escrow token account
        let cpi_accounts = token::Transfer {
            from: ctx.accounts.depositor_token_account.to_account_info(),
            to: ctx.accounts.escrow_token_account.to_account_info(),
            authority: ctx.accounts.depositor.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        escrow.depositor = ctx.accounts.depositor.key();
        escrow.beneficiary = ctx.accounts.beneficiary.key();
        escrow.amount = amount;
        escrow.claimed = false;
        escrow.refunded = false;
        escrow.bump = ctx.bumps.escrow;
        escrow.nonce = nonce;
        escrow.deposit_tx_signature = [0u8; 64];

        msg!(
            "Deposited {} tokens into escrow (nonce {}) for verification",
            amount,
            nonce
        );
        Ok(())
    }

    /// Record the deposit transaction signature inside the escrow account.
    /// Called by the client right after the deposit transaction confirms.
    /// First write wins; the same 64 bytes are a no-op; anything else fails.
    pub fn attest(ctx: Context<Attest>, deposit_tx_signature: [u8; 64]) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        if escrow.deposit_tx_signature == [0u8; 64] {
            escrow.deposit_tx_signature = deposit_tx_signature;
            msg!("Attested deposit signature for escrow (nonce {})", escrow.nonce);
        } else if escrow.deposit_tx_signature != deposit_tx_signature {
            return Err(error!(ErrorCode::AttestationMismatch));
        }
        Ok(())
    }

    /// Claim the escrowed tokens. Only the beneficiary (oracle operator) may claim.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(!escrow.claimed && !escrow.refunded, ErrorCode::EscrowClosed);
        require_keys_eq!(
            escrow.beneficiary,
            ctx.accounts.beneficiary.key(),
            ErrorCode::Unauthorized
        );

        // Verify the escrow account is the correct PDA for the stored depositor + nonce
        let expected_pda = Pubkey::create_program_address(
            &[
                ESCROW_SEED,
                escrow.depositor.as_ref(),
                &escrow.nonce.to_le_bytes(),
                &[escrow.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(ErrorCode::Unauthorized))?;
        require_keys_eq!(ctx.accounts.escrow.key(), expected_pda, ErrorCode::Unauthorized);
        require_keys_eq!(
            ctx.accounts.escrow_token_account.owner,
            ctx.accounts.escrow.key(),
            ErrorCode::InvalidTokenAccount
        );

        let depositor = escrow.depositor;
        let bump = escrow.bump;
        let nonce = escrow.nonce;
        let seeds: &[&[u8]] = &[
            ESCROW_SEED,
            depositor.as_ref(),
            &nonce.to_le_bytes(),
            &[bump],
        ];
        let seed_binding = [seeds];

        let cpi_accounts = token::Transfer {
            from: ctx.accounts.escrow_token_account.to_account_info(),
            to: ctx.accounts.beneficiary_token_account.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, &seed_binding);
        token::transfer(cpi_ctx, escrow.amount)?;

        // Close the escrow token account and return the rent to the beneficiary
        let close_accounts = token::CloseAccount {
            account: ctx.accounts.escrow_token_account.to_account_info(),
            destination: ctx.accounts.beneficiary.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        };
        let close_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.key(), close_accounts, &seed_binding);
        token::close_account(close_ctx)?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.claimed = true;
        msg!("Beneficiary claimed {} tokens from escrow", escrow.amount);
        Ok(())
    }

    /// Refund the escrowed tokens to the depositor.
    /// Used when the oracle returns UNDECIDED (client not charged) or when the
    /// client wants to reclaim a deposit whose attestation failed. Signed by
    /// the depositor only — the operator cannot refund on a client's behalf.
    /// Refund ignores attestation state on purpose: a failed attestation must
    /// never strand funds.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(!escrow.claimed && !escrow.refunded, ErrorCode::EscrowClosed);
        require_keys_eq!(
            escrow.depositor,
            ctx.accounts.depositor.key(),
            ErrorCode::Unauthorized
        );

        // Verify the escrow account is the correct PDA for the stored depositor + nonce
        let expected_pda = Pubkey::create_program_address(
            &[
                ESCROW_SEED,
                escrow.depositor.as_ref(),
                &escrow.nonce.to_le_bytes(),
                &[escrow.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(ErrorCode::Unauthorized))?;
        require_keys_eq!(ctx.accounts.escrow.key(), expected_pda, ErrorCode::Unauthorized);
        require_keys_eq!(
            ctx.accounts.escrow_token_account.owner,
            ctx.accounts.escrow.key(),
            ErrorCode::InvalidTokenAccount
        );

        let depositor = escrow.depositor;
        let bump = escrow.bump;
        let nonce = escrow.nonce;
        let seeds: &[&[u8]] = &[
            ESCROW_SEED,
            depositor.as_ref(),
            &nonce.to_le_bytes(),
            &[bump],
        ];
        let seed_binding = [seeds];

        let cpi_accounts = token::Transfer {
            from: ctx.accounts.escrow_token_account.to_account_info(),
            to: ctx.accounts.depositor_token_account.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, &seed_binding);
        token::transfer(cpi_ctx, escrow.amount)?;

        // Close the escrow token account and return the rent to the depositor
        let close_accounts = token::CloseAccount {
            account: ctx.accounts.escrow_token_account.to_account_info(),
            destination: ctx.accounts.depositor.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        };
        let close_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.key(), close_accounts, &seed_binding);
        token::close_account(close_ctx)?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.refunded = true;
        msg!("Depositor reclaimed {} tokens from escrow", escrow.amount);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(amount: u64, nonce: u64)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    /// The oracle operator that will claim on success
    pub beneficiary: SystemAccount<'info>,
    #[account(
        init,
        payer = depositor,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, depositor.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        init,
        payer = depositor,
        seeds = [ESCROW_TOKEN_SEED, depositor.key().as_ref(), &nonce.to_le_bytes()],
        bump,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = depositor,
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Attest<'info> {
    // Any valid escrow account — the stored depositor/nonce identify it; the
    // account's owner (the escrow program) and discriminator are checked by
    // Anchor's Account<'info, Escrow> deserialization.
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut, close = beneficiary)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, token::authority = escrow)]
    pub escrow_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub beneficiary_token_account: Account<'info, TokenAccount>,
    pub beneficiary: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut, close = depositor)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, token::authority = escrow)]
    pub escrow_token_account: Account<'info, TokenAccount>,
    #[account(mut, token::authority = depositor)]
    pub depositor_token_account: Account<'info, TokenAccount>,
    pub depositor: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub depositor: Pubkey,
    pub beneficiary: Pubkey,
    pub amount: u64,
    pub claimed: bool,
    pub refunded: bool,
    pub bump: u8,
    /// Client-supplied nonce — allows multiple concurrent escrows per depositor
    pub nonce: u64,
    /// Deposit transaction signature (64 bytes, zeroed = unattested).
    /// Written by `attest` after the deposit confirms — a program cannot read
    /// its own transaction's signature during execution.
    pub deposit_tx_signature: [u8; 64],
}

pub mod error {
    use super::*;

    #[error_code]
    pub enum ErrorCode {
        #[msg("Only the escrow beneficiary can claim or the depositor can refund")]
        Unauthorized,
        #[msg("Escrow already claimed or refunded")]
        EscrowClosed,
        #[msg("Amount must be greater than zero")]
        InvalidAmount,
        #[msg("Invalid token account for this escrow")]
        InvalidTokenAccount,
        #[msg("Escrow already attested with a different deposit signature")]
        AttestationMismatch,
    }
}

use error::ErrorCode;
