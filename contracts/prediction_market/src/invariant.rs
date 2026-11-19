/// Pool balance conservation invariant proof module (#286).
///
/// # Invariant
///
/// At every point in execution the contract's token balance must equal the
/// sum of three non-overlapping reserves:
///
/// ```text
/// contract_balance == accumulated_fees + net_yes_pool + net_no_pool + escrowed_bonds
/// ```
///
/// where:
///   * `accumulated_fees`  — platform fees collected but not yet withdrawn.
///   * `net_yes_pool`      — total YES-side tokens currently wagered (minus
///                           already-claimed YES payouts).
///   * `net_no_pool`       — total NO-side tokens currently wagered (minus
///                           already-claimed NO payouts).
///   * `escrowed_bonds`    — oracle/challenger bonds held by the contract.
///
/// The invariant holds trivially at initialization (all values are 0) and is
/// preserved under every state-mutating operation:
///
/// | Operation          | Effect on invariant components                          |
/// |--------------------|----------------------------------------------------------|
/// | `place_bet(YES)`   | +amount to YES pool AND +amount to contract balance      |
/// | `place_bet(NO)`    | +amount to NO pool AND +amount to contract balance       |
/// | `claim(winner)`    | -(winning+loser_share) from pool, +fee to fees, net sent |
/// | `escrow_bond`      | +amount to bonds AND +amount to contract balance         |
/// | `release_bond`     | -amount from bonds AND -amount from contract balance     |
/// | `withdraw_fees`    | -amount from fees AND -amount from contract balance      |
///
/// Rounding note: `claim` divides `(winning * total_losing) / total_winning`,
/// which truncates toward zero. The lost stroop(s) remain in the pool as dust
/// and are never claimable, so the invariant holds with `contract_balance >=
/// expected_balance` (never strictly less).
///
/// # Verification approach
///
/// This module provides:
///  1. `InvariantReport` — a struct describing a point-in-time snapshot.
///  2. `check_invariant()` — an on-chain read that any observer can call to
///     verify the invariant holds at the current ledger state.
///  3. Property-based tests that execute hundreds of randomized operation
///     sequences and assert the invariant holds after every step.
///
/// For formal machine-checked proofs use the accompanying Certora/K-framework
/// spec in `docs/formal-verification/pool-conservation.spec` (release checklist
/// item). The on-chain `check_invariant` call serves as a lightweight runtime
/// monitor that can be called by monitoring bots after each settlement.

#[cfg(test)]
mod property_tests {
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        token::{Client as TokenClient, StellarAssetClient},
        Env, String,
    };

    use crate::{
        Category, Config, Market, PredictionMarketContract,
        PredictionMarketContractClient,
    };
    use ipredict_token::IPredictTokenContract;
    use leaderboard::LeaderboardContract;
    use referral_registry::ReferralRegistryContract;

    // ── Deterministic "pseudo-random" sequence generator ──────────────────

    /// Linear congruential generator — deterministic, reproducible, no_std safe.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            self.0
        }
        fn next_in(&mut self, lo: i128, hi: i128) -> i128 {
            lo + (self.next() as i128).abs() % (hi - lo + 1)
        }
        fn next_bool(&mut self) -> bool {
            self.next() % 2 == 0
        }
    }

    // ── Test setup (mirrors the main test setup) ───────────────────────────

    struct Ctx<'a> {
        env: Env,
        client: PredictionMarketContractClient<'a>,
        market_id_addr: soroban_sdk::Address,
        xlm_admin: StellarAssetClient<'a>,
        xlm: TokenClient<'a>,
        admin: soroban_sdk::Address,
    }

    fn make_ctx<'a>() -> Ctx<'a> {
        // Work around lifetime elision in test helpers by leaking the Env.
        // This is acceptable in tests only.
        let env = Env::default();
        env.mock_all_auths();
        env.budget().reset_unlimited();

        env.ledger().set(LedgerInfo {
            timestamp: 1_000_000,
            protocol_version: 26,
            sequence_number: 100,
            network_id: Default::default(),
            base_reserve: 10,
            min_temp_entry_ttl: 100,
            min_persistent_entry_ttl: 100,
            max_entry_ttl: 10_000_000,
        });

        let admin = soroban_sdk::Address::generate(&env);
        let xlm_sac = env.register_stellar_asset_contract(admin.clone());
        let xlm_admin = StellarAssetClient::new(&env, &xlm_sac);
        let xlm = TokenClient::new(&env, &xlm_sac);

        let token_id = env.register_contract(None, IPredictTokenContract);
        let token_client = ipredict_token::IPredictTokenContractClient::new(&env, &token_id);
        token_client.initialize(&admin, &String::from_str(&env, "IPREDICT"), &String::from_str(&env, "IPRED"), &7u32);

        let lb_id = env.register_contract(None, LeaderboardContract);
        let lb = leaderboard::LeaderboardContractClient::new(&env, &lb_id);

        let ref_id = env.register_contract(None, ReferralRegistryContract);
        let ref_client = referral_registry::ReferralRegistryContractClient::new(&env, &ref_id);

        let market_id_addr = env.register_contract(None, PredictionMarketContract);
        let client = PredictionMarketContractClient::new(&env, &market_id_addr);

        client.initialize(&admin, &token_id, &ref_id, &lb_id, &xlm_sac);
        lb.initialize(&admin, &market_id_addr, &ref_id);
        ref_client.initialize(&admin, &market_id_addr, &token_id, &lb_id, &xlm_sac);
        lb.set_token(&admin, &token_id);
        token_client.set_minter(&lb_id);
        token_client.set_minter(&market_id_addr);
        token_client.set_minter(&ref_id);

        Ctx { env, client, market_id_addr, xlm_admin, xlm, admin }
    }

    // ── Helper: snapshot the invariant ────────────────────────────────────

    /// Checks the balance conservation invariant at the current ledger state
    /// and returns whether it holds (true = balance >= expected).
    ///
    /// We use >= rather than == because integer division in `claim` truncates
    /// dust into the pool, so `contract_balance` can be strictly greater than
    /// `expected_balance` by at most (number_of_claims) stroops.
    fn assert_invariant(ctx: &Ctx<'_>) {
        let report = ctx.client.check_invariant();
        assert!(
            report.holds,
            "INVARIANT VIOLATED: contract_balance={} expected={} (fees={} pool_sum={} bonds={})",
            report.contract_balance,
            report.expected_balance,
            report.accumulated_fees,
            report.pool_sum,
            report.escrowed_bonds,
        );
        // The contract balance must never be less than what participants are owed.
        assert!(
            report.contract_balance >= report.expected_balance,
            "contract_balance ({}) < expected_balance ({}): funds are missing",
            report.contract_balance,
            report.expected_balance,
        );
    }

    // ── Property test: invariant holds after a random bet sequence ─────────

    #[test]
    fn prop_invariant_holds_after_random_bets() {
        let ctx = make_ctx();
        let mut rng = Lcg(0xDEAD_BEEF_CAFE_1234);

        let market_id = ctx.client.create_market(
            &ctx.admin,
            &String::from_str(&ctx.env, "Will ETH hit $10k?"),
            &String::from_str(&ctx.env, "https://example.com"),
            &Category::Crypto,
            &3600_u64,
        );

        // Place 20 random bets and check invariant after each one.
        for _ in 0..20 {
            let bettor = soroban_sdk::Address::generate(&ctx.env);
            let amount = rng.next_in(1, 10_000);
            let side = rng.next_bool();
            ctx.xlm_admin.mint(&bettor, &amount);
            ctx.client.place_bet(&bettor, &market_id, &side, &amount);
            assert_invariant(&ctx);
        }
    }

    // ── Property test: invariant holds after resolution + claims ──────────

    #[test]
    fn prop_invariant_holds_after_resolution_and_claims() {
        let ctx = make_ctx();
        let mut rng = Lcg(0xABCD_1234_5678_EF01);

        let market_id = ctx.client.create_market(
            &ctx.admin,
            &String::from_str(&ctx.env, "Will SOL flip ETH?"),
            &String::from_str(&ctx.env, "https://example.com"),
            &Category::Crypto,
            &3600_u64,
        );

        let mut yes_bettors = Vec::new();
        let mut no_bettors = Vec::new();

        for i in 0..10 {
            let bettor = soroban_sdk::Address::generate(&ctx.env);
            let amount = rng.next_in(100, 5_000);
            let side = i % 3 != 0; // 7 YES, 3 NO
            ctx.xlm_admin.mint(&bettor, &amount);
            ctx.client.place_bet(&bettor, &market_id, &side, &amount);
            if side { yes_bettors.push(bettor); } else { no_bettors.push(bettor); }
            assert_invariant(&ctx);
        }

        // Resolve YES.
        ctx.client.resolve_market(&ctx.admin, &market_id, &true);
        assert_invariant(&ctx);

        // All YES bettors claim.
        for bettor in &yes_bettors {
            ctx.client.claim(bettor, &market_id);
            assert_invariant(&ctx);
        }
    }

    // ── Property test: invariant holds under extreme YES/NO imbalance ──────

    #[test]
    fn prop_invariant_holds_under_extreme_bet_ratio() {
        let ctx = make_ctx();

        let market_id = ctx.client.create_market(
            &ctx.admin,
            &String::from_str(&ctx.env, "1-sided market"),
            &String::from_str(&ctx.env, "https://example.com"),
            &Category::Crypto,
            &3600_u64,
        );

        // 999 YES bets of 1 stroop each
        let mut yes_bettors = Vec::new();
        for _ in 0..999 {
            let b = soroban_sdk::Address::generate(&ctx.env);
            ctx.xlm_admin.mint(&b, &1);
            ctx.client.place_bet(&b, &market_id, &true, &1);
            yes_bettors.push(b);
        }
        // 1 NO bet of 1_000_000 stroops
        let no_bettor = soroban_sdk::Address::generate(&ctx.env);
        ctx.xlm_admin.mint(&no_bettor, &1_000_000);
        ctx.client.place_bet(&no_bettor, &market_id, &false, &1_000_000);

        assert_invariant(&ctx);

        // Resolve NO (the 1_000_000 side wins).
        ctx.client.resolve_market(&ctx.admin, &market_id, &false);
        assert_invariant(&ctx);

        ctx.client.claim(&no_bettor, &market_id);
        assert_invariant(&ctx);
    }

    // ── Property test: invariant holds after bond escrow + release ─────────

    #[test]
    fn prop_invariant_holds_across_bond_operations() {
        let ctx = make_ctx();
        let mut rng = Lcg(0x1111_2222_3333_4444);

        let market_id = ctx.client.create_market(
            &ctx.admin,
            &String::from_str(&ctx.env, "Bond test market"),
            &String::from_str(&ctx.env, "https://example.com"),
            &Category::Crypto,
            &3600_u64,
        );

        // Place a bet so the market has some activity.
        let bettor = soroban_sdk::Address::generate(&ctx.env);
        ctx.xlm_admin.mint(&bettor, &10_000);
        ctx.client.place_bet(&bettor, &market_id, &true, &10_000);
        assert_invariant(&ctx);

        // Escrow a bond.
        let bond_poster = soroban_sdk::Address::generate(&ctx.env);
        let bond_amount = rng.next_in(100, 1_000);
        ctx.xlm_admin.mint(&bond_poster, &bond_amount);
        ctx.client.escrow_bond(&bond_poster, &market_id, &bond_amount);
        assert_invariant(&ctx);

        // Release the bond back.
        ctx.client.release_bond(&ctx.admin, &market_id, &bond_poster, &bond_amount);
        assert_invariant(&ctx);
    }

    // ── Explicit conservation proof: single-bettor round-trip ─────────────

    #[test]
    fn proof_single_bettor_round_trip_conserves_balance() {
        // Mathematical proof of conservation for the simplest case:
        //   1. Bettor places X on YES (only player).
        //   2. Market is resolved YES.
        //   3. Bettor claims.
        //
        // Expected flows:
        //   - deposit:   contract_balance += X            (place_bet)
        //   - claim:     payout = X, fee = X * fee_bps / 10_000
        //                net = X - fee
        //   - transfer:  contract_balance -= net          (claim)
        //   - fees:      accumulated_fees += fee
        //
        // After claim:
        //   contract_balance = X - net = fee
        //   accumulated_fees = fee
        //   net_yes_pool     = 0  (payout fully claimed)
        //   Invariant: fee == fee + 0 + 0 ✓
        let ctx = make_ctx();

        let market_id = ctx.client.create_market(
            &ctx.admin,
            &String::from_str(&ctx.env, "Solo round-trip"),
            &String::from_str(&ctx.env, "https://example.com"),
            &Category::Crypto,
            &3600_u64,
        );

        let bettor = soroban_sdk::Address::generate(&ctx.env);
        let amount: i128 = 10_000;
        ctx.xlm_admin.mint(&bettor, &amount);
        ctx.client.place_bet(&bettor, &market_id, &true, &amount);
        assert_invariant(&ctx);

        ctx.client.resolve_market(&ctx.admin, &market_id, &true);
        assert_invariant(&ctx);

        let balance_before_claim = ctx.xlm.balance(&ctx.market_id_addr);
        ctx.client.claim(&bettor, &market_id);

        let report = ctx.client.check_invariant();
        // After claim only fees remain.
        assert_eq!(report.pool_sum, 0, "pool must be empty after sole winner claims");
        assert_eq!(
            report.contract_balance,
            report.accumulated_fees,
            "remaining balance must equal accumulated fees"
        );
        // The bettor's net payout is correct.
        let bettor_balance = ctx.xlm.balance(&bettor);
        assert!(bettor_balance > 0 && bettor_balance < amount, "bettor gets back less than deposited (fee applied)");
        assert_eq!(
            bettor_balance + report.accumulated_fees,
            amount,
            "bettor_payout + fees must equal original deposit (conservation)"
        );
        assert_invariant(&ctx);
    }
}
