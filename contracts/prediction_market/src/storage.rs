use soroban_sdk::{Address, Env, String};

use crate::types::{DataKey, Market, MarketPool, MarketStatic};

/// Persist immutable market metadata once at creation time.
pub fn set_market_static(env: &Env, id: u64, market_static: &MarketStatic) {
    env.storage()
        .persistent()
        .set(&DataKey::MarketStatic(id), market_static);
}

/// Load immutable market metadata.
pub fn get_market_static(env: &Env, id: u64) -> Option<MarketStatic> {
    env.storage()
        .persistent()
        .get(&DataKey::MarketStatic(id))
}

/// Persist the dynamic pool totals for a market.
pub fn set_market_pool(env: &Env, id: u64, pool: &MarketPool) {
    env.storage()
        .persistent()
        .set(&DataKey::MarketPool(id), pool);
}

/// Load the dynamic pool totals for a market.
pub fn get_market_pool(env: &Env, id: u64) -> Option<MarketPool> {
    env.storage()
        .persistent()
        .get(&DataKey::MarketPool(id))
}

/// Write both the static metadata and the initial pool totals at creation.
pub fn set_market(env: &Env, id: u64, market: &Market) {
    let market_static = MarketStatic {
        question: market.question.clone(),
        creator: market.creator.clone(),
        deadline: market.deadline,
    };
    let pool = MarketPool {
        yes_pool: market.yes_pool,
        no_pool: market.no_pool,
        resolved: market.resolved,
        outcome: market.outcome,
    };
    set_market_static(env, id, &market_static);
    set_market_pool(env, id, &pool);
}

/// Reassemble a full `Market` from its static metadata and dynamic pool.
pub fn get_market(env: &Env, id: u64) -> Option<Market> {
    let market_static = get_market_static(env, id)?;
    let pool = get_market_pool(env, id)?;
    Some(Market {
        question: market_static.question,
        creator: market_static.creator,
        deadline: market_static.deadline,
        yes_pool: pool.yes_pool,
        no_pool: pool.no_pool,
        resolved: pool.resolved,
        outcome: pool.outcome,
    })
}

/// Update only the dynamic pool totals, leaving static metadata untouched.
pub fn update_market_pool(env: &Env, id: u64, pool: &MarketPool) {
    set_market_pool(env, id, pool);
}

/// Convenience accessor for the market question string.
pub fn get_market_question(env: &Env, id: u64) -> Option<String> {
    get_market_static(env, id).map(|m| m.question)
}

/// Convenience accessor for the market creator address.
pub fn get_market_creator(env: &Env, id: u64) -> Option<Address> {
    get_market_static(env, id).map(|m| m.creator)
}
