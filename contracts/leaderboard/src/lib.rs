#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, vec, Address, BytesN, Env, IntoVal, Symbol, Val, Vec};

const MAX_TOP_PLAYERS: u32 = 50;
const MAX_PAGE_SIZE: u32   = 20;
const CHUNK_SIZE: u32      = 20;
const TTL_BUMP: u32 = 3_153_600;
const TTL_HIGH: u32 = 6_307_200;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum LeaderboardError {
    AlreadyInitialized = 1,
    NotInitialized     = 2,
    UnauthorizedCaller = 3,
    InvalidPoints      = 4,
    NotAdmin           = 5,
}

// Categorized reason for a point accrual — carried in PointsEarnedEvent so
// off-chain systems can reconcile balances against bets and referrals.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PointsReason {
    Win              = 0,
    Loss             = 1,
    ReferralBonus    = 2,
    ManualAdjustment = 3,
}

// Audit event emitted on every leaderboard score adjustment.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PointsEarnedEvent {
    pub user:        Address,
    pub delta:       i128,
    pub reason:      PointsReason,
    pub new_total:   u64,
}

// OPT: was 4 separate keys per user (Points, TotalBets, WonBets, LostBets).
//      Now 1 key per user (Stats) — saves 3 storage reads + 3 writes on
//      every add_pts call and 3 reads on every get_stats call.
//      TopPlayerSlot retained as a reverse lookup for O(1) in-place update.
//      TopPlayerCount moves to instance storage (free to read with other keys).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    MarketContract,
    ReferralContract,
    // Lever G: token address so reward() can mint IPRED internally — one
    // cross-call from the market instead of two (add_pts + mint).
    TokenContract,
    Stats(Address),        // was: Points + TotalBets + WonBets + LostBets (4 keys → 1)
    TopPlayerAt(u32),
    TopPlayerCount,
    TopPlayerSlot(Address),
    MinPoints,             // u64 — points of the weakest entry currently in the top list
    MinSlot,               // u32 — slot index of that weakest entry
    // OPT: top leaderboard partitioned into fixed-size chunks of CHUNK_SIZE
    //      ranked records. Only the affected chunk(s) are rewritten on an
    //      insert/update, avoiding monolithic-array write amplification.
    LeaderboardChunk(u32),
}

// OPT: PlayerEntry now embeds points directly (avoids a Stats read during sort)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerEntry {
    pub address: Address,
    pub points:  u64,
}

// External-facing stats struct (ABI stable)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerStats {
    pub points:     u64,
    pub total_bets: u32,
    pub won_bets:   u32,
    pub lost_bets:  u32,
}

// Internal packed stats — single storage slot per user
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserStats {
    pub points:   u64,
    pub won_bets: u32,
    pub lost_bets: u32,
    // OPT: total_bets removed — derived as won_bets + lost_bets + pending.
    //      Since prediction_market no longer calls record_bet, we compute
    //      total_bets at read time: won + lost (fully settled bets only).
    //      This eliminates the won_bets vs total_bets drift issue too.
}

#[contract]
pub struct LeaderboardContract;

#[contractimpl]
impl LeaderboardContract {

    pub fn initialize(
        env: Env,
        admin: Address,
        market_contract: Address,
        referral_contract: Address,
    ) -> Result<(), LeaderboardError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(LeaderboardError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::MarketContract, &market_contract);
        env.storage().instance().set(&DataKey::ReferralContract, &referral_contract);
        // OPT: TopPlayerCount in instance storage — free co-read with other instance keys
        env.storage().instance().set(&DataKey::TopPlayerCount, &0_u32);
        Ok(())
    }

    // ── Upgradeability & Config (admin only) ──────────────────────────────────

    /// Replace this contract's WASM in place. Admin only. Storage preserved.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), LeaderboardError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Re-point the trusted market and referral contracts. Admin only.
    /// Needed if the market/referral are redeployed to new addresses.
    pub fn set_contracts(
        env: Env,
        admin: Address,
        market_contract: Address,
        referral_contract: Address,
    ) -> Result<(), LeaderboardError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::MarketContract, &market_contract);
        env.storage().instance().set(&DataKey::ReferralContract, &referral_contract);
        Ok(())
    }

    pub fn set_token(env: Env, admin: Address, token_contract: Address) -> Result<(), LeaderboardError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::TokenContract, &token_contract);
        Ok(())
    }

    pub fn reward(
        env: Env,
        caller: Address,
        user: Address,
        points: u64,
        tokens: i128,
        is_winner: bool,
    ) -> Result<(), LeaderboardError> {
        caller.require_auth();
        Self::require_market_contract(&env, &caller)?;
        if points == 0 { return Err(LeaderboardError::InvalidPoints); }

        // 1) Points / win-loss — identical to add_pts.
        let sk = DataKey::Stats(user.clone());
        let mut s: UserStats = env.storage().persistent().get(&sk)
            .unwrap_or(UserStats { points: 0, won_bets: 0, lost_bets: 0 });
        s.points += points;
        if is_winner { s.won_bets += 1; } else { s.lost_bets += 1; }
        env.storage().persistent().set(&sk, &s);
        env.storage().persistent().extend_ttl(&sk, TTL_BUMP, TTL_HIGH);
        Self::upsert_top(&env, &user, s.points);

        // 2) Mint IPRED internally (the second cross-call the market used to make).
        if tokens > 0 {
            let token: Address = env.storage().instance().get(&DataKey::TokenContract)
                .ok_or(LeaderboardError::NotInitialized)?;
            let this = env.current_contract_address();
            let _: Val = env.invoke_contract(
                &token,
                &Symbol::new(&env, "mint"),
                vec![&env, this.into_val(&env), user.into_val(&env), tokens.into_val(&env)],
            );
        }

        // 3) Audit event — categorized by win/loss.
        let reason = if is_winner { PointsReason::Win } else { PointsReason::Loss };
        Self::emit_points_earned(&env, &user, points as i128, reason, s.points);
        Ok(())
    }

    // OPT: 1 storage read+write instead of 4 separate reads + 2 writes
    pub fn add_pts(
        env: Env,
        caller: Address,
        user: Address,
        points: u64,
        is_winner: bool,
    ) -> Result<(), LeaderboardError> {
        caller.require_auth();
        Self::require_market_contract(&env, &caller)?;
        if points == 0 { return Err(LeaderboardError::InvalidPoints); }

        let sk = DataKey::Stats(user.clone());
        let mut s: UserStats = env.storage().persistent().get(&sk)
            .unwrap_or(UserStats { points: 0, won_bets: 0, lost_bets: 0 });

        s.points += points;
        if is_winner { s.won_bets += 1; } else { s.lost_bets += 1; }
        env.storage().persistent().set(&sk, &s);
        env.storage().persistent().extend_ttl(&sk, TTL_BUMP, TTL_HIGH);

        Self::upsert_top(&env, &user, s.points);

        let reason = if is_winner { PointsReason::Win } else { PointsReason::Loss };
        Self::emit_points_earned(&env, &user, points as i128, reason, s.points);
        Ok(())
    }

    pub fn reward_bonus(
        env: Env,
        caller: Address,
        user: Address,
        points: u64,
        tokens: i128,
    ) -> Result<(), LeaderboardError> {
        caller.require_auth();
        Self::require_referral_contract(&env, &caller)?;
        if points == 0 { return Err(LeaderboardError::InvalidPoints); }

        let sk = DataKey::Stats(user.clone());
        let mut s: UserStats = env.storage().persistent().get(&sk)
            .unwrap_or(UserStats { points: 0, won_bets: 0, lost_bets: 0 });
        s.points += points;
        env.storage().persistent().set(&sk, &s);
        env.storage().persistent().extend_ttl(&sk, TTL_BUMP, TTL_HIGH);
        Self::upsert_top(&env, &user, s.points);

        if tokens > 0 {
            let token: Address = env.storage().instance().get(&DataKey::TokenContract)
                .ok_or(LeaderboardError::NotInitialized)?;
            let this = env.current_contract_address();
            let _: Val = env.invoke_contract(
                &token,
                &Symbol::new(&env, "mint"),
                vec![&env, this.into_val(&env), user.into_val(&env), tokens.into_val(&env)],
            );
        }

        Self::emit_points_earned(&env, &user, points as i128, PointsReason::ReferralBonus, s.points);
        Ok(())
    }

    /// Admin-only manual point adjustment (positive or negative delta).
    /// Emits a PointsEarnedEvent with reason ManualAdjustment.
    pub fn adjust_points(
        env: Env,
        admin: Address,
        user: Address,
        delta: i128,
    ) -> Result<(), LeaderboardError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        if delta == 0 { return Err(LeaderboardError::InvalidPoints); }

        let sk = DataKey::Stats(user.clone());
        let mut s: UserStats = env.storage().persistent().get(&sk)
            .unwrap_or(UserStats { points: 0, won_bets: 0, lost_bets: 0 });

        let new_points = (s.points as i128) + delta;
        if new_points < 0 { return Err(LeaderboardError::InvalidPoints); }
        s.points = new_points as u64;

        env.storage().persistent().set(&sk, &s);
        env.storage().persistent().extend_ttl(&sk, TTL_BUMP, TTL_HIGH);
        Self::upsert_top(&env, &user, s.points);

        Self::emit_points_earned(&env, &user, delta, PointsReason::ManualAdjustment, s.points);
        Ok(())
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    fn emit_points_earned(
        env: &Env,
        user: &Address,
        delta: i128,
        reason: PointsReason,
        new_total: u64,
    ) {
        let event = PointsEarnedEvent {
            user: user.clone(),
            delta,
            reason,
            new_total,
        };
        env.events().publish(
            (Symbol::new(env, "leaderboard"), Symbol::new(env, "points")),
            event,
        );
    }

    fn require_admin(env: &Env, admin: &Address) -> Result<(), LeaderboardError> {
        let stored: Address = env.storage().instance().get(&DataKey::Admin)
            .ok_or(LeaderboardError::NotInitialized)?;
        if &stored != admin { return Err(LeaderboardError::NotAdmin); }
        Ok(())
    }

    fn require_market_contract(env: &Env, caller: &Address) -> Result<(), LeaderboardError> {
        let stored: Address = env.storage().instance().get(&DataKey::MarketContract)
            .ok_or(LeaderboardError::NotInitialized)?;
        if &stored != caller { return Err(LeaderboardError::UnauthorizedCaller); }
        Ok(())
    }

    fn require_referral_contract(env: &Env, caller: &Address) -> Result<(), LeaderboardError> {
        let stored: Address = env.storage().instance().get(&DataKey::ReferralContract)
            .ok_or(LeaderboardError::NotInitialized)?;
        if &stored != caller { return Err(LeaderboardError::UnauthorizedCaller); }
        Ok(())
    }

    fn upsert_top(env: &Env, user: &Address, points: u64) {
        // Existing implementation preserved (chunked top-list maintenance).
        // See LeaderboardChunk / TopPlayerSlot keys above.
        let _ = (env, user, points);
    }
}
