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
    AlreadyInitialized  = 1,
    NotInitialized      = 2,
    UnauthorizedMinter  = 3,
    InsufficientBalance = 4,
    InvalidAmount       = 5,
    NotAdmin            = 6,
    /// Caller is not the registered market contract address.
    UnauthorizedCaller  = 7,
}

/// Default timelock delay: 48 hours, expressed in seconds.
pub const DEFAULT_UPGRADE_DELAY: u64 = 48 * 60 * 60;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    /// The one market contract address allowed to call `mint_rewards`.
    MarketContract,
    AuthorizedMinter(Address),
    Balance(Address),
    TotalSupply,
    Name,
    Symbol,
    Decimals,
    Vesting(Address),
}

/// Linear vesting schedule for council reward tokens (#198).
/// Tokens unlock linearly from `start` over `duration` seconds; `claimed`
/// tracks how much of the vested amount has already been paid out.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingSchedule {
    pub start: u64,
    pub duration: u64,
    pub total: i128,
    pub claimed: i128,
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

    /// Configure the multi-sig upgrade authority. Admin only. `admins` is the set of
    /// addresses that must approve upgrades; `threshold` is how many approvals are
    /// required. `delay` is the timelock in seconds (defaults to 48h if 0).
    pub fn set_upgrade_admins(
        env: Env,
        admins: Vec<Address>,
        threshold: u32,
        delay: u64,
    ) -> Result<(), TokenError> {
        let admin: Address = Self::require_admin(&env)?;
        admin.require_auth();
        if threshold == 0 || threshold as u32 > admins.len() {
            return Err(TokenError::InvalidAmount);
        }
        let effective_delay = if delay == 0 { DEFAULT_UPGRADE_DELAY } else { delay };
        env.storage().instance().set(&DataKey::UpgradeAdmins, &admins);
        env.storage().instance().set(&DataKey::UpgradeThreshold, &threshold);
        env.storage().instance().set(&DataKey::UpgradeDelay, &effective_delay);
        Ok(())
    }

    /// Schedule a WASM upgrade. Requires multi-sig approval to schedule; the upgrade
    /// cannot be executed until the timelock delay has elapsed.
    pub fn schedule_upgrade(
        env: Env,
        approver: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), TokenError> {
        Self::require_upgrade_admin(&env, &approver)?;
        approver.require_auth();

        let mut approvals: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeApprovals)
            .unwrap_or_else(|| Vec::new(&env));
        if approvals.contains(&approver) {
            return Err(TokenError::AlreadyApproved);
        }
        approvals.push_back(approver.clone());

        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeThreshold)
            .unwrap_or(1);
        if approvals.len() < threshold {
            env.storage().instance().set(&DataKey::UpgradeApprovals, &approvals);
            return Ok(());
        }

        let now = env.ledger().timestamp();
        env.storage().instance().set(&DataKey::PendingWasmHash, &new_wasm_hash);
        env.storage().instance().set(&DataKey::UpgradeScheduledAt, &now);
        env.storage().instance().set(&DataKey::UpgradeApprovals, &Vec::<Address>::new(&env));

        env.events().publish(
            (String::from_str(&env, "token"), String::from_str(&env, "UpgradeScheduled")),
            (new_wasm_hash, now),
        );
        Ok(())
    }

    /// Execute a previously scheduled upgrade. Requires multi-sig approval and that
    /// the timelock delay has elapsed since scheduling.
    pub fn execute_upgrade(env: Env, approver: Address) -> Result<(), TokenError> {
        Self::require_upgrade_admin(&env, &approver)?;
        approver.require_auth();

        let new_wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::PendingWasmHash)
            .ok_or(TokenError::UpgradeNotScheduled)?;
        let scheduled_at: u64 = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeScheduledAt)
            .ok_or(TokenError::UpgradeNotScheduled)?;

        let delay: u64 = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeDelay)
            .unwrap_or(DEFAULT_UPGRADE_DELAY);
        let now = env.ledger().timestamp();
        if now < scheduled_at.saturating_add(delay) {
            return Err(TokenError::TimelockNotElapsed);
        }

        let mut approvals: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeApprovals)
            .unwrap_or_else(|| Vec::new(&env));
        if approvals.contains(&approver) {
            return Err(TokenError::AlreadyApproved);
        }
        approvals.push_back(approver.clone());

        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeThreshold)
            .unwrap_or(1);
        if approvals.len() < threshold {
            env.storage().instance().set(&DataKey::UpgradeApprovals, &approvals);
            return Ok(());
        }

        env.storage().instance().remove(&DataKey::PendingWasmHash);
        env.storage().instance().remove(&DataKey::UpgradeScheduledAt);
        env.storage().instance().remove(&DataKey::UpgradeApprovals);

        env.deployer().update_current_contract_wasm(new_wasm_hash.clone());

        env.events().publish(
            (String::from_str(&env, "token"), String::from_str(&env, "UpgradeExecuted")),
            (new_wasm_hash, now),
        );
        Ok(())
    }

    /// Register the one market contract address permitted to call `mint_rewards`.
    /// Only the admin can set this. Replaces any previously stored address.
    pub fn set_market_contract(env: Env, admin: Address, market: Address) -> Result<(), TokenError> {
        let stored: Address = env.storage().instance().get(&DataKey::Admin)
            .ok_or(TokenError::NotInitialized)?;
        if admin != stored { return Err(TokenError::NotAdmin); }
        admin.require_auth();
        env.storage().instance().set(&DataKey::MarketContract, &market);
        Ok(())
    }

    /// Returns the registered market contract address, if any.
    pub fn get_market_contract(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::MarketContract)
    }

    /// Mint tokens as a reward from the market contract.
    ///
    /// This entry-point is restricted to the address stored as `MarketContract`.
    /// The check is enforced via `env.current_contract_address()` authorization
    /// semantics: the caller must be the exact address stored at initialization
    /// time, so direct external calls or calls from any other contract address
    /// are rejected with `UnauthorizedCaller` before any state is mutated.
    ///
    /// Unlike the general `mint` (which accepts any `AuthorizedMinter`), this
    /// function provides a named, narrowly-scoped entry-point to prevent
    /// unauthorized token minting from external callers.
    pub fn mint_rewards(env: Env, caller: Address, to: Address, amount: i128) -> Result<(), TokenError> {
        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }
        // `caller` must be the stored market contract — rejects any external
        // address that is not the registered market contract.
        caller.require_auth();
        Self::require_market_contract(&env, &caller)?;

        let balance = Self::balance(env.clone(), to.clone());
        env.storage().persistent().set(&DataKey::Balance(to), &(balance + amount));
        let supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalSupply, &(supply + amount));
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

    /// Creates a linear vesting schedule for `beneficiary` (#198). Admin only.
    /// `duration` is configurable (e.g. 30 days for council rewards). The vested
    /// tokens are minted into the contract's own balance so they can be claimed
    /// progressively via `claim_vested`.
    pub fn create_vesting_schedule(
        env: Env,
        beneficiary: Address,
        total: i128,
        duration: u64,
    ) -> Result<(), TokenError> {
        let admin: Address = Self::require_admin(&env)?;
        admin.require_auth();
        if total <= 0 || duration == 0 {
            return Err(TokenError::InvalidAmount);
        }
        let schedule = VestingSchedule {
            start: env.ledger().timestamp(),
            duration,
            total,
            claimed: 0,
        };
        env.storage().persistent().set(&DataKey::Vesting(beneficiary.clone()), &schedule);
        let contract_balance = Self::balance(env.clone(), env.current_contract_address());
        env.storage().persistent().set(
            &DataKey::Balance(env.current_contract_address()),
            &(contract_balance + total),
        );
        let supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalSupply, &(supply + total));
        Ok(())
    }

    /// Returns the beneficiary's vesting schedule, if any.
    pub fn vesting_schedule(env: Env, beneficiary: Address) -> Option<VestingSchedule> {
        env.storage().persistent().get(&DataKey::Vesting(beneficiary))
    }

    /// Total amount vested (unlocked) so far for `beneficiary`.
    pub fn vested_balance(env: Env, beneficiary: Address) -> i128 {
        match env.storage().persistent().get::<DataKey, VestingSchedule>(&DataKey::Vesting(beneficiary)) {
            Some(s) => Self::compute_vested(&env, &s),
            None => 0,
        }
    }

    /// Amount currently claimable (vested minus already claimed).
    pub fn claimable_balance(env: Env, beneficiary: Address) -> i128 {
        match env.storage().persistent().get::<DataKey, VestingSchedule>(&DataKey::Vesting(beneficiary)) {
            Some(s) => Self::compute_vested(&env, &s) - s.claimed,
            None => 0,
        }
    }

    /// Transfers the currently claimable vested amount to `beneficiary`.
    pub fn claim_vested(env: Env, beneficiary: Address) -> Result<i128, TokenError> {
        beneficiary.require_auth();
        let mut schedule: VestingSchedule = env.storage().persistent()
            .get(&DataKey::Vesting(beneficiary.clone()))
            .ok_or(TokenError::NoVestingSchedule)?;
        let vested = Self::compute_vested(&env, &schedule);
        let claimable = vested - schedule.claimed;
        if claimable <= 0 {
            return Err(TokenError::NothingToClaim);
        }
        let contract = env.current_contract_address();
        let contract_balance = Self::balance(env.clone(), contract.clone());
        if contract_balance < claimable {
            return Err(TokenError::InsufficientBalance);
        }
        env.storage().persistent().set(&DataKey::Balance(contract), &(contract_balance - claimable));
        let beneficiary_balance = Self::balance(env.clone(), beneficiary.clone());
        env.storage().persistent().set(
            &DataKey::Balance(beneficiary.clone()),
            &(beneficiary_balance + claimable),
        );
        schedule.claimed += claimable;
        env.storage().persistent().set(&DataKey::Vesting(beneficiary.clone()), &schedule);
        env.events().publish(
            (String::from_str(&env, "token"), String::from_str(&env, "vested_claimed")),
            (beneficiary, claimable),
        );
        Ok(claimable)
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

    fn compute_vested(env: &Env, schedule: &VestingSchedule) -> i128 {
        let now = env.ledger().timestamp();
        if now <= schedule.start {
            return 0;
        }
        let elapsed = now - schedule.start;
        if elapsed >= schedule.duration {
            return schedule.total;
        }
        (schedule.total * (elapsed as i128)) / (schedule.duration as i128)
    }

    fn require_admin(env: &Env) -> Result<Address, TokenError> {
        env.storage().instance().get(&DataKey::Admin).ok_or(TokenError::NotInitialized)
    }

    /// Verifies that `caller` matches the stored `MarketContract` address.
    /// Returns `UnauthorizedCaller` if the market contract has not been set
    /// or if `caller` does not match the registered address.
    fn require_market_contract(env: &Env, caller: &Address) -> Result<(), TokenError> {
        let market: Address = env.storage().instance()
            .get(&DataKey::MarketContract)
            .ok_or(TokenError::UnauthorizedCaller)?;
        if *caller != market {
            return Err(TokenError::UnauthorizedCaller);
        }
        Ok(())
    }
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
