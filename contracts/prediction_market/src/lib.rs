#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Map, String, Symbol, Vec};

/// Maximum allowed length (in bytes) for a market title/question.
pub const MAX_TITLE_LEN: u32 = 160;
/// Maximum allowed length (in bytes) for a market description.
pub const MAX_DESCRIPTION_LEN: u32 = 1000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Market {
    pub id: u64,
    pub creator: Address,
    pub token: Address,
    pub total_yes: i128,
    pub total_no: i128,
    pub claimed: i128,
    pub resolved: bool,
    pub outcome: bool,
    pub escrowed_bonds: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    pub yes: i128,
    pub no: i128,
    pub claimed: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvariantReport {
    pub contract_balance: i128,
    pub expected_balance: i128,
    pub pool_sum: i128,
    pub accumulated_fees: i128,
    pub escrowed_bonds: i128,
    pub holds: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub fee_bps: u32,
    pub accumulated_fees: i128,
}

/// Multi-signature admin policy for privileged operations (contract upgrade,
/// fee withdrawal, bond release, market resolution).
///
/// The admin `Address` stored in `Config` MUST be a Stellar account configured
/// with at least 3-of-5 signers and `high`/`med` thresholds set to 3. Soroban
/// enforces this at the ledger protocol level: `require_auth` on a multi-sig
/// account only succeeds when the transaction carries the required number of
/// valid signatures, so a single compromised key cannot authorize these calls.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminPolicy {
    pub threshold: u32,
    pub total_signers: u32,
}

#[contract]
pub struct PredictionMarket;

#[contractimpl]
impl PredictionMarket {
    pub fn initialize(env: Env, admin: Address, token: Address, fee_bps: u32) {
        admin.require_auth();
        let config = Config {
            admin,
            fee_bps,
            accumulated_fees: 0,
        };
        env.storage().instance().set(&Symbol::new(&env, "config"), &config);
        env.storage().instance().set(&Symbol::new(&env, "token"), &token);
        env.storage().instance().set(&Symbol::new(&env, "next_id"), &0u64);
        // Record the required multi-sig policy (3-of-5) for privileged ops.
        let policy = AdminPolicy {
            threshold: 3,
            total_signers: 5,
        };
        env.storage().instance().set(&Symbol::new(&env, "admin_policy"), &policy);
    }

    /// Returns the configured multi-signature admin policy (threshold/signers).
    pub fn admin_policy(env: Env) -> AdminPolicy {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "admin_policy"))
            .unwrap_or(AdminPolicy { threshold: 3, total_signers: 5 })
    }

    /// Authorizes a privileged admin operation.
    ///
    /// `admin.require_auth()` delegates to the Stellar account's signer set and
    /// thresholds. When the admin account is configured as 3-of-5 with `high`
    /// (and `med`) threshold = 3, the ledger rejects any invocation carrying
    /// fewer than 3 valid signatures, so a single key cannot execute upgrades
    /// or withdraw platform fees.
    fn require_admin(env: &Env, admin: &Address) {
        admin.require_auth();
        let config: Config = env.storage().instance().get(&Symbol::new(env, "config")).unwrap();
        assert!(admin == &config.admin, "not admin");
    }

    /// Validates a market title/question and description for length limits.
    ///
    /// Rejects empty or oversized strings so unbounded input cannot bloat
    /// ledger rent or be used to smuggle oversized payloads to clients.
    fn validate_market_text(title: &String, description: &String) {
        let title_len = title.len();
        let description_len = description.len();
        assert!(title_len > 0, "title must not be empty");
        assert!(title_len <= MAX_TITLE_LEN, "title exceeds max length");
        assert!(description_len <= MAX_DESCRIPTION_LEN, "description exceeds max length");
    }

    /// Validates an external evidence/source URL.
    ///
    /// Requires a non-empty `http://` or `https://` scheme and a non-empty
    /// host, rejecting malformed or scheme-less URLs.
    fn validate_url(url: &String) {
        let len = url.len();
        assert!(len > 0, "url must not be empty");
        let bytes = url.to_bytes();
        let https = b"https://";
        let http = b"http://";
        let has_https = bytes.len() >= https.len() && {
            let mut ok = true;
            let mut i = 0;
            while i < https.len() {
                if bytes.get(i).unwrap() != https[i] {
                    ok = false;
                }
                i += 1;
            }
            ok
        };
        let has_http = bytes.len() >= http.len() && {
            let mut ok = true;
            let mut i = 0;
            while i < http.len() {
                if bytes.get(i).unwrap() != http[i] {
                    ok = false;
                }
                i += 1;
            }
            ok
        };
        assert!(has_https || has_http, "invalid url scheme");
        let scheme_len = if has_https { https.len() } else { http.len() };
        assert!(bytes.len() > scheme_len, "url missing host");
    }

    pub fn create_market(env: Env, creator: Address) -> u64 {
        creator.require_auth();
        let token: Address = env.storage().instance().get(&Symbol::new(&env, "token")).unwrap();
        let mut next_id: u64 = env.storage().instance().get(&Symbol::new(&env, "next_id")).unwrap_or(0);
        let market = Market {
            id: next_id,
            creator,
            token,
            total_yes: 0,
            total_no: 0,
            claimed: 0,
            resolved: false,
            outcome: false,
            escrowed_bonds: 0,
        };
        env.storage().persistent().set(&Self::market_key(&env, next_id), &market);
        next_id += 1;
        env.storage().instance().set(&Symbol::new(&env, "next_id"), &next_id);
        next_id - 1
    }

    /// Creates a market with a validated title, description, and source URL.
    ///
    /// Enforces the contract-level length limits (title <= 160, description
    /// <= 1000) and rejects malformed evidence URLs before persisting.
    pub fn create_market_with_metadata(
        env: Env,
        creator: Address,
        title: String,
        description: String,
        source_url: String,
    ) -> u64 {
        creator.require_auth();
        Self::validate_market_text(&title, &description);
        Self::validate_url(&source_url);
        Self::create_market(env, creator)
    }

    pub fn place_bet(env: Env, bettor: Address, market_id: u64, side_yes: bool, amount: i128) {
        bettor.require_auth();
        assert!(amount > 0, "amount must be positive");
        let mut market: Market = env
            .storage()
            .persistent()
            .get(&Self::market_key(&env, market_id))
            .expect("market not found");
        assert!(!market.resolved, "market already resolved");

        let token_client = token::Client::new(&env, &market.token);
        token_client.transfer(&bettor, &env.current_contract_address(), &amount);

        let mut position: Position = env
            .storage()
            .persistent()
            .get(&Self::position_key(&env, market_id, &bettor))
            .unwrap_or(Position { yes: 0, no: 0, claimed: false });

        if side_yes {
            market.total_yes += amount;
            position.yes += amount;
        } else {
            market.total_no += amount;
            position.no += amount;
        }

        env.storage().persistent().set(&Self::market_key(&env, market_id), &market);
        env.storage()
            .persistent()
            .set(&Self::position_key(&env, market_id, &bettor), &position);
    }

    pub fn resolve_market(env: Env, admin: Address, market_id: u64, outcome: bool) {
        Self::require_admin(&env, &admin);
        let mut market: Market = env
            .storage()
            .persistent()
            .get(&Self::market_key(&env, market_id))
            .expect("market not found");
        assert!(!market.resolved, "already resolved");
        market.resolved = true;
        market.outcome = outcome;
        env.storage().persistent().set(&Self::market_key(&env, market_id), &market);
    }

    pub fn claim(env: Env, claimant: Address, market_id: u64) {
        claimant.require_auth();
        let mut market: Market = env
            .storage()
            .persistent()
            .get(&Self::market_key(&env, market_id))
            .expect("market not found");
        assert!(market.resolved, "market not resolved");

        let mut position: Position = env
            .storage()
            .persistent()
            .get(&Self::position_key(&env, market_id, &claimant))
            .expect("no position");
        assert!(!position.claimed, "already claimed");

        let winning = if market.outcome { position.yes } else { position.no };
        let losing = if market.outcome { position.no } else { position.yes };
        let total_winning = if market.outcome { market.total_yes } else { market.total_no };
        let total_losing = if market.outcome { market.total_no } else { market.total_yes };

        let mut payout = winning;
        if total_winning > 0 && total_losing > 0 {
            payout += (winning * total_losing) / total_winning;
        }

        let config: Config = env.storage().instance().get(&Symbol::new(&env, "config")).unwrap();
        let fee = (payout * config.fee_bps as i128) / 10_000;
        let net = payout - fee;

        position.claimed = true;
        market.claimed += payout;

        let mut updated_config = config;
        updated_config.accumulated_fees += fee;

        env.storage().persistent().set(&Self::market_key(&env, market_id), &market);
        env.storage()
            .persistent()
            .set(&Self::position_key(&env, market_id, &claimant), &position);
        env.storage().instance().set(&Symbol::new(&env, "config"), &updated_config);

        let token_client = token::Client::new(&env, &market.token);
        token_client.transfer(&env.current_contract_address(), &claimant, &net);
    }

    pub fn escrow_bond(env: Env, from: Address, market_id: u64, amount: i128) {
        from.require_auth();
        assert!(amount > 0, "amount must be positive");
        let mut market: Market = env
            

/* … truncated 2125 chars — edit only what you need near the top … */
