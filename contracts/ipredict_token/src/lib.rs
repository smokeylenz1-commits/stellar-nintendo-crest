#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, BytesN, Env, String};

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
    NoVestingSchedule   = 7,
    NothingToClaim      = 8,
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
}

#[cfg(test)]
mod tests;
