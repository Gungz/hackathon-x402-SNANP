//! x402 Verification Escrow Program
//!
//! Locks SPL Token / Token-2022 payments (USDT/USDC) for an AI oracle
//! verification request until the oracle completes and the operator claims,
//! or the client reclaims funds when the verification is inconclusive.
//!
//! Instructions:
//!   deposit(amount, beneficiary) — client locks tokens into the escrow PDA
//!   claim()                      — beneficiary (oracle operator) claims tokens
//!   refund()                     — depositor reclaims tokens (UNDECIDED)

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
    /// The depositor transfers `amount` to the escrow PDA's token account.
    /// `beneficiary` is the oracle operator wallet that can claim later.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
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

        msg!("Deposited {} tokens into escrow for verification", amount);
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

        // Verify the escrow account is the correct PDA for the stored depositor
        let expected_pda = Pubkey::create_program_address(
            &[ESCROW_SEED, escrow.depositor.as_ref(), &[escrow.bump]],
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
        let seeds: &[&[u8]] = &[ESCROW_SEED, depositor.as_ref(), &[bump]];
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
    /// Used when the oracle returns UNDECIDED (client not charged) or
    /// when the operator chooses to return funds.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(!escrow.claimed && !escrow.refunded, ErrorCode::EscrowClosed);
        require_keys_eq!(
            escrow.depositor,
            ctx.accounts.depositor.key(),
            ErrorCode::Unauthorized
        );

        // Verify the escrow account is the correct PDA for the stored depositor
        let expected_pda = Pubkey::create_program_address(
            &[ESCROW_SEED, escrow.depositor.as_ref(), &[escrow.bump]],
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
        let seeds: &[&[u8]] = &[ESCROW_SEED, depositor.as_ref(), &[bump]];
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
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    /// The oracle operator that will claim on success
    pub beneficiary: SystemAccount<'info>,
    #[account(
        init,
        payer = depositor,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, depositor.key().as_ref()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        init,
        payer = depositor,
        seeds = [ESCROW_TOKEN_SEED, depositor.key().as_ref()],
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
    }
}

use error::ErrorCode;
