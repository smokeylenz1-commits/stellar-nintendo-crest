#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, BytesN, Env, String, Vec};

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
    UpgradeNotScheduled = 7,
    TimelockNotElapsed  = 8,
    InsufficientApprovals = 9,
    AlreadyApproved     = 10,
}

/// Default timelock delay: 48 hours, expressed in seconds.
pub const DEFAULT_UPGRADE_DELAY: u64 = 48 * 60 * 60;

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
    UpgradeAdmins,
    UpgradeThreshold,
    UpgradeDelay,
    PendingWasmHash,
    UpgradeScheduledAt,
    UpgradeApprovals,
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

    fn require_admin(env: &Env) -> Result<Address, TokenError> {
        env.storage().instance().get(&DataKey::Admin).ok_or(TokenError::NotInitialized)
    }

    fn require_upgrade_admin(env: &Env, who: &Address) -> Result<(), TokenError> {
        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeAdmins)
            .ok_or(TokenError::NotAdmin)?;
        if !admins.contains(who) {
            return Err(TokenError::NotAdmin);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
