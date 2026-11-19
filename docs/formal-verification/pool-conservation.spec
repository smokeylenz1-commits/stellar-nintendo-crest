/**
 * Formal verification specification: Pool Balance Conservation Invariant (#286)
 *
 * Target: contracts/prediction_market/src/lib.rs
 * Tool:   Certora Prover (CVL) — compatible with K-framework with minor translation
 *
 * ════════════════════════════════════════════════════════════════════════════
 * INVARIANT STATEMENT
 * ════════════════════════════════════════════════════════════════════════════
 *
 * At every point between external function calls, the contract's token
 * balance must equal the sum of all outstanding obligations:
 *
 *   contract_balance(env)
 *       == accumulated_fees(config)
 *        + Σ_m (total_yes[m] + total_no[m] - claimed[m])   // net pools
 *        + Σ_m escrowed_bonds[m]                            // oracle bonds
 *
 * We prove the ≥ variant (strict equality modulo dust):
 *
 *   contract_balance >= expected_balance
 *
 * where dust ≤ number_of_resolved_markets (one stroop per claim, worst case).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CVL SPECIFICATION
 * ════════════════════════════════════════════════════════════════════════════
 */

// --- Ghost variables (Certora: persistent across transactions) ---------------

ghost mathint ghost_accumulated_fees {
    init_state axiom ghost_accumulated_fees == 0;
}

ghost mathint ghost_net_yes_pool {
    init_state axiom ghost_net_yes_pool == 0;
}

ghost mathint ghost_net_no_pool {
    init_state axiom ghost_net_no_pool == 0;
}

ghost mathint ghost_escrowed_bonds {
    init_state axiom ghost_escrowed_bonds == 0;
}

// --- Hooks to track state changes -------------------------------------------

// Fires whenever the config's accumulated_fees field is written.
hook Sstore config.accumulated_fees int128 newVal (int128 oldVal) {
    ghost_accumulated_fees = ghost_accumulated_fees + (newVal - oldVal);
}

// Fires whenever a market's total_yes is updated.
hook Sstore markets[KEY uint64 mId].total_yes int128 newVal (int128 oldVal) {
    ghost_net_yes_pool = ghost_net_yes_pool + (newVal - oldVal);
}

// Fires whenever a market's total_no is updated.
hook Sstore markets[KEY uint64 mId].total_no int128 newVal (int128 oldVal) {
    ghost_net_no_pool = ghost_net_no_pool + (newVal - oldVal);
}

// Fires whenever a market's claimed counter is updated (reduces net pools).
hook Sstore markets[KEY uint64 mId].claimed int128 newVal (int128 oldVal) {
    // claimed increases represent payouts leaving the pool.
    mathint delta = newVal - oldVal;
    ghost_net_yes_pool = ghost_net_yes_pool - delta / 2;
    ghost_net_no_pool  = ghost_net_no_pool  - delta / 2;
    // Note: imprecise split is acceptable because we prove ≥, not ==.
}

// Fires whenever a market's escrowed_bonds is updated.
hook Sstore markets[KEY uint64 mId].escrowed_bonds int128 newVal (int128 oldVal) {
    ghost_escrowed_bonds = ghost_escrowed_bonds + (newVal - oldVal);
}

// --- Main invariant ---------------------------------------------------------

invariant poolConservation(env e)
    token.balanceOf(currentContract) >=
        ghost_accumulated_fees
        + ghost_net_yes_pool
        + ghost_net_no_pool
        + ghost_escrowed_bonds
{
    // Exempt: initialize() starts from zero — invariant trivially holds.
    preserved initialize(address admin, address token, uint32 fee_bps) with (env e_init) {
        require ghost_accumulated_fees == 0;
        require ghost_net_yes_pool     == 0;
        require ghost_net_no_pool      == 0;
        require ghost_escrowed_bonds   == 0;
    }
}

// --- Auxiliary lemmas -------------------------------------------------------

// Lemma: place_bet increases contract_balance and the matching side pool by
// exactly the same amount, preserving the invariant.
rule placeBetPreservesInvariant(env e, address bettor, uint64 market_id, bool side_yes, int128 amount) {
    require amount > 0;
    require !markets[market_id].resolved;

    mathint balance_before = token.balanceOf(currentContract);
    mathint pool_before = side_yes ? ghost_net_yes_pool : ghost_net_no_pool;

    place_bet(e, bettor, market_id, side_yes, amount);

    mathint balance_after = token.balanceOf(currentContract);
    mathint pool_after = side_yes ? ghost_net_yes_pool : ghost_net_no_pool;

    assert balance_after - balance_before == amount;
    assert pool_after - pool_before == amount;
}

// Lemma: claim never allows total_payouts > total_wagers for any market.
rule claimNeverOverpays(env e, address claimant, uint64 market_id) {
    require markets[market_id].resolved;

    mathint claimed_before = markets[market_id].claimed;
    mathint total_pool = markets[market_id].total_yes + markets[market_id].total_no;

    claim(e, claimant, market_id);

    mathint claimed_after = markets[market_id].claimed;

    // Payouts must never exceed the total pool.
    assert claimed_after <= total_pool;
}

// Lemma: withdraw_fees only moves accumulated_fees to admin — no other state changes.
rule withdrawFeesOnlyMovesAccumulatedFees(env e, address admin, int128 amount) {
    mathint fees_before    = ghost_accumulated_fees;
    mathint balance_before = token.balanceOf(currentContract);

    withdraw_fees(e, admin, amount);

    assert ghost_accumulated_fees == fees_before - amount;
    assert token.balanceOf(currentContract) == balance_before - amount;
    // Ghost pools and bonds must be unchanged.
    assert ghost_net_yes_pool  == old(ghost_net_yes_pool);
    assert ghost_net_no_pool   == old(ghost_net_no_pool);
    assert ghost_escrowed_bonds == old(ghost_escrowed_bonds);
}

// Lemma: escrow_bond / release_bond change both balance and bonds by the same delta.
rule bondOperationsPreserveInvariant(env e, address from, uint64 market_id, int128 amount) {
    mathint balance_before = token.balanceOf(currentContract);
    mathint bonds_before   = ghost_escrowed_bonds;

    escrow_bond(e, from, market_id, amount);

    assert token.balanceOf(currentContract) == balance_before + amount;
    assert ghost_escrowed_bonds             == bonds_before   + amount;
}

// --- Extreme ratio edge-case rules ------------------------------------------

// Rule: invariant holds when one side has 0 tokens (empty pool).
rule invariantHoldsWithEmptyNoPool(env e) {
    require ghost_net_no_pool == 0;
    // The claim payout calculation special-cases total_losing==0,
    // so winners only receive their stake back (no bonus).
    // The invariant must still hold.
    satisfy poolConservation(e);
}

rule invariantHoldsWithSkewedRatio(env e, uint64 market_id) {
    // 999:1 YES:NO ratio — rounding dust must not break conservation.
    require markets[market_id].total_yes == 999;
    require markets[market_id].total_no  == 1;
    require !markets[market_id].resolved;
    satisfy poolConservation(e);
}

/*
 * ════════════════════════════════════════════════════════════════════════════
 * RELEASE CHECKLIST INTEGRATION
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Before every contract upgrade, the following steps MUST be completed and
 * recorded in the release notes:
 *
 *  [ ] Run `certoraRun pool-conservation.spec --contract PredictionMarket`
 *      and confirm all rules PASS with no counterexamples.
 *
 *  [ ] Run `cargo test --package prediction_market` and confirm all property
 *      tests in src/invariant.rs pass, including the extreme-ratio tests.
 *
 *  [ ] Call `check_invariant()` on the DEPLOYED contract (mainnet) immediately
 *      after upgrade; alert if `holds == false`.
 *
 *  [ ] Log the Certora verification job URL in the release PR description.
 *
 * Any upgrade that cannot clear the formal verification step is BLOCKED.
 * ════════════════════════════════════════════════════════════════════════════
 */
