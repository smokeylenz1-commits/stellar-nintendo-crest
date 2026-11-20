#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Bytes, BytesN, Env, String};

/// Standardized contract error code ranges (#203).
///
/// Each workspace contract owns a non-overlapping discriminant range so that
/// client-side decoding can attribute an error to its originating contract:
///
/// - `100-199` Market
/// - `200-299` Token
/// - `300-399` Referral
/// - `400-499` Leaderboard
///
/// These values are part of the public ABI and MUST NOT shift across builds.
pub mod error_codes {
    pub const MARKET_BASE: u32 = 100;
    pub const TOKEN_BASE: u32 = 200;
    pub const REFERRAL_BASE: u32 = 300;
    pub const LEADERBOARD_BASE: u32 = 400;
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TokenError {
    AlreadyInitialized  = 201,
    NotInitialized      = 202,
    UnauthorizedMinter  = 203,
    InsufficientBalance = 204,
    InvalidAmount       = 205,
    NotAdmin            = 206,
    SignatureExpired    = 207,
    InvalidSignature    = 208,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    AuthorizedMinter(Address),
    Balance(Address),
    TotalSupply,
    Name,
    Symbol,
    Decimals,
    OracleMaxAge,
}

#[contract]
pub struct IPredictTokenContract;

#[contractimpl]
impl IPredictTokenContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        name: String,
        symbol: String,
        decimals: u32,
    ) -> Result<(), TokenError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(TokenError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);
        env.storage().instance().set(&DataKey::Decimals, &decimals);
        env.storage().instance().set(&DataKey::TotalSupply, &0_i128);
        Ok(())
    }

    /// Replace this contract's WASM in place. Admin only. Balances preserved.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), TokenError> {
        let stored: Address = env.storage().instance().get(&DataKey::Admin)
            .ok_or(TokenError::NotInitialized)?;
        if admin != stored { return Err(TokenError::NotAdmin); }
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Authorises `minter` to mint. Any number of minters can be authorised, and each one
    /// is checked on its own in `mint`. The admin revokes one with `remove_minter` (#14).
    pub fn set_minter(env: Env, minter: Address) -> Result<(), TokenError> {
        let admin: Address = Self::require_admin(&env)?;
        admin.require_auth();
        env.storage().persistent().set(&DataKey::AuthorizedMinter(minter), &true);
        Ok(())
    }

    pub fn remove_minter(env: Env, minter: Address) -> Result<(), TokenError> {
        let admin: Address = Self::require_admin(&env)?;
        admin.require_auth();
        env.storage().persistent().remove(&DataKey::AuthorizedMinter(minter));
        Ok(())
    }

    pub fn mint(env: Env, minter: Address, to: Address, amount: i128) -> Result<(), TokenError> {
        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }
        minter.require_auth();
        let is_minter: bool = env.storage().persistent()
            .get(&DataKey::AuthorizedMinter(minter))
            .unwrap_or(false);
        if !is_minter {
            return Err(TokenError::UnauthorizedMinter);
        }
        let balance = Self::balance(env.clone(), to.clone());
        env.storage().persistent().set(&DataKey::Balance(to), &(balance + amount));
        let supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalSupply, &(supply + amount));
        Ok(())
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<(), TokenError> {
        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }
        from.require_auth();
        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            return Err(TokenError::InsufficientBalance);
        }
        env.storage().persistent().set(&DataKey::Balance(from), &(from_balance - amount));
        let to_balance = Self::balance(env.clone(), to.clone());
        env.storage().persistent().set(&DataKey::Balance(to), &(to_balance + amount));
        Ok(())
    }

    pub fn burn(env: Env, from: Address, amount: i128) -> Result<(), TokenError> {
        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }
        from.require_auth();
        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            return Err(TokenError::InsufficientBalance);
        }
        env.storage().persistent().set(&DataKey::Balance(from.clone()), &(from_balance - amount));
        let supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalSupply, &(supply - amount));
        env.events().publish(
            (String::from_str(&env, "token"), String::from_str(&env, "burned")),
            (from, amount),
        );
        Ok(())
    }

    pub fn balance(env: Env, account: Address) -> i128 {
        env.storage().persistent().get(&DataKey::Balance(account)).unwrap_or(0)
    }

    pub fn total_supply(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0)
    }

    pub fn name(env: Env) -> String {
        env.storage().instance().get(&DataKey::Name)
            .unwrap_or_else(|| String::from_str(&env, "IPREDICT"))
    }

    pub fn symbol(env: Env) -> String {
        env.storage().instance().get(&DataKey::Symbol)
            .unwrap_or_else(|| String::from_str(&env, "IPRED"))
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Decimals).unwrap_or(7)
    }

    /// Compute the required challenger dispute bond for a market resolution (#201).
    ///
    /// The bond decays linearly from `base_bond` at the start of the resolution
    /// window down to `min_bond` as the window approaches expiration, encouraging
    /// legitimate late challenges while preserving a Sybil-resistant floor.
    ///
    /// `base_bond * (remaining_time / total_window)`, clamped to `[min_bond, base_bond]`.
    pub fn dispute_bond(
        env: Env,
        base_bond: i128,
        min_bond: i128,
        window_start: u64,
        window_end: u64,
    ) -> i128 {
        Self::compute_dispute_bond(&env, base_bond, min_bond, window_start, window_end)
    }

    fn compute_dispute_bond(
        env: &Env,
        base_bond: i128,
        min_bond: i128,
        window_start: u64,
        window_end: u64,
    ) -> i128 {
        if base_bond <= 0 {
            return 0;
        }
        let floor = if min_bond < 0 { 0 } else { min_bond };
        if window_end <= window_start {
            return floor.min(base_bond);
        }
        let now = env.ledger().timestamp();
        if now <= window_start {
            return base_bond;
        }
        if now >= window_end {
            return floor.min(base_bond);
        }
        let total = (window_end - window_start) as i128;
        let remaining = (window_end - now) as i128;
        let decayed = base_bond.saturating_mul(remaining) / total;
        if decayed < floor {
            floor.min(base_bond)
        } else if decayed > base_bond {
            base_bond
        } else {
            decayed
        }
    }

    /// Configure the maximum age (in seconds) an oracle signature may have (#202).
    /// Admin only. Defaults to 300s when unset.
    pub fn set_oracle_max_age(env: Env, max_age: u64) -> Result<(), TokenError> {
        let admin: Address = Self::require_admin(&env)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::OracleMaxAge, &max_age);
        Ok(())
    }

    /// Verify an Ed25519 signature over an oracle submission payload (#202).
    ///
    /// The signed message is the canonical encoding of
    /// `(market_id, outcome, timestamp)`. Signatures older than the configured
    /// max-age threshold are rejected. On success an `OracleSignatureVerified`
    /// telemetry event is emitted.
    pub fn verify_oracle

/* … truncated 1146 chars — edit only what you need near the top … */
