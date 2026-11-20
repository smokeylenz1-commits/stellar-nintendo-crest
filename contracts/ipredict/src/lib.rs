//! iPredict contract — granular pause flags circuit breaker (#190).
//!
//! This module exposes a `PauseFlags` bitmask stored in instance storage that
//! lets the admin selectively freeze bet placement, claim resolution, and
//! market creation without pausing the entire contract.

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol};

/// Bitmask controlling which operations are currently paused.
///
/// A set bit means the corresponding operation is *paused* (blocked).
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PauseFlags(pub u32);

impl PauseFlags {
    /// Bet placement is paused.
    pub const BET: u32 = 1 << 0;
    /// Claim resolution is paused.
    pub const CLAIM: u32 = 1 << 1;
    /// Market creation is paused.
    pub const CREATE: u32 = 1 << 2;

    pub fn empty() -> Self {
        PauseFlags(0)
    }

    pub fn is_bet_paused(&self) -> bool {
        self.0 & Self::BET != 0
    }

    pub fn is_claim_paused(&self) -> bool {
        self.0 & Self::CLAIM != 0
    }

    pub fn is_create_paused(&self) -> bool {
        self.0 & Self::CREATE != 0
    }
}

const PAUSE_FLAGS_KEY: Symbol = symbol_short!("PAUSEFLAGS");
const ADMIN_KEY: Symbol = symbol_short!("ADMIN");

#[contract]
pub struct IPredictContract;

#[contractimpl]
impl IPredictContract {
    /// Initialize the contract with an admin. Stores empty pause flags.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&ADMIN_KEY) {
            panic!("already initialized");
        }
        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage()
            .instance()
            .set(&PAUSE_FLAGS_KEY, &PauseFlags::empty());
    }

    /// Returns the current pause flags bitmask.
    pub fn get_pause_flags(env: Env) -> PauseFlags {
        env.storage()
            .instance()
            .get(&PAUSE_FLAGS_KEY)
            .unwrap_or(PauseFlags::empty())
    }

    /// Admin-only: replace the pause flags bitmask and emit `PauseFlagsUpdated`.
    pub fn set_pause_flags(env: Env, admin: Address, flags: PauseFlags) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("not initialized");
        if admin != stored_admin {
            panic!("unauthorized");
        }

        env.storage().instance().set(&PAUSE_FLAGS_KEY, &flags);
        env.events()
            .publish((symbol_short!("PauseFlagsUpdated"),), flags);
    }

    /// Place a bet. Blocked when the BET pause flag is set.
    pub fn place_bet(env: Env, bettor: Address, market_id: u64, amount: i128) {
        bettor.require_auth();
        let flags = Self::get_pause_flags(env.clone());
        if flags.is_bet_paused() {
            panic!("bet placement paused");
        }
        // Existing bet placement logic would continue here.
        let _ = (market_id, amount);
    }

    /// Resolve a claim. Blocked when the CLAIM pause flag is set.
    pub fn claim(env: Env, claimant: Address, market_id: u64) {
        claimant.require_auth();
        let flags = Self::get_pause_flags(env.clone());
        if flags.is_claim_paused() {
            panic!("claim resolution paused");
        }
        // Existing claim resolution logic would continue here.
        let _ = market_id;
    }

    /// Create a market. Blocked when the CREATE pause flag is set.
    pub fn create_market(env: Env, creator: Address, market_id: u64) {
        creator.require_auth();
        let flags = Self::get_pause_flags(env.clone());
        if flags.is_create_paused() {
            panic!("market creation paused");
        }
        // Existing market creation logic would continue here.
        let _ = market_id;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup() -> (Env, IPredictContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, IPredictContract);
        let client = IPredictContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, client, admin)
    }

    #[test]
    fn default_flags_are_empty() {
        let (_env, client, _admin) = setup();
        assert_eq!(client.get_pause_flags(), PauseFlags::empty());
    }

    #[test]
    fn admin_can_set_flags() {
        let (_env, client, admin) = setup();
        client.set_pause_flags(&admin, &PauseFlags(PauseFlags::BET));
        assert!(client.get_pause_flags().is_bet_paused());
        assert!(!client.get_pause_flags().is_claim_paused());
    }

    #[test]
    fn selective_pause_allows_claims() {
        let (env, client, admin) = setup();
        client.set_pause_flags(&admin, &PauseFlags(PauseFlags::BET));

        let bettor = Address::generate(&env);
        let claimant = Address::generate(&env);

        // Bet placement is blocked.
        let bet_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.place_bet(&bettor, &1, &100);
        }));
        assert!(bet_result.is_err());

        // Claims still redeem.
        client.claim(&claimant, &1);
    }

    #[test]
    fn unauthorized_caller_cannot_set_flags() {
        let env = Env::default();
        let contract_id = env.register_contract(None, IPredictContract);
        let client = IPredictContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let attacker = Address::generate(&env);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.set_pause_flags(&attacker, &PauseFlags(PauseFlags::BET));
        }));
        assert!(result.is_err());
        assert_eq!(client.get_pause_flags(), PauseFlags::empty());
    }
}
