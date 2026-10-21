# Security Audit: Contract Balance Invariant

## Scope

This document records the formal invariant audit for the prediction market
contract's token accounting. The contract custodies all user deposits,
platform fees, and referral allocations in a single Soroban token balance
(XLM). A discrepancy between the on-chain balance and the sum of internal
accounting would allow excess withdrawals and eventual insolvency.

## Formal Invariant

Let `ContractBalance(XLM)` be the token balance held by the contract at any
ledger close. The following invariant must hold at all times:

```
ContractBalance(XLM) ==
      sum(market.total_yes + market.total_no - market.claimed)
    + AccumulatedFees
    + sum(escrowed_bonds)
```

Where:

- `market.total_yes` / `market.total_no` are the cumulative stakes placed on
  each outcome of a market.
- `market.claimed` is the cumulative amount already paid out to winners.
- `AccumulatedFees` is the platform fee balance not yet withdrawn.
- `escrowed_bonds` are bonds locked by market creators / disputers that have
  not yet been released or slashed.

Intuitively, the contract balance is exactly the sum of:

1. outstanding (unclaimed) stakes across all markets,
2. accrued but unwithdrawn platform fees, and
3. outstanding escrowed bonds.

## Verification Approach

### Property-based testing (`proptest`)

Automated property tests in Rust drive arbitrary sequences of user actions
(`place_bet`, `claim`, `cancel`, fee accrual, bond escrow/release) and assert
the invariant after every step. The generator produces random bet amounts,
outcomes, and interleavings of operations so that the invariant is checked
across a wide space of reachable states rather than a handful of fixtures.

Key properties exercised:

- **Placement:** placing a bet increases both the contract balance and the
  corresponding `total_yes`/`total_no` by the same amount.
- **Claim:** a winning claim decreases the contract balance and increases
  `market.claimed` by the same amount.
- **Fees:** fee accrual increases `AccumulatedFees` while leaving the
  outstanding-stake term unchanged.
- **Bonds:** escrowing a bond increases both the contract balance and
  `escrowed_bonds`; releasing it decreases both.
- **Composition:** arbitrary interleavings of the above preserve the
  invariant at every step.

### Ledger-history assertion

The verification script replays ledger history, recomputing the right-hand
side of the invariant from contract storage and comparing it against the
observed token balance at each ledger close. Any divergence is reported with
the offending ledger sequence and the delta.

## Findings

- The invariant holds for all generated action sequences covered by the
  property tests.
- No path was found that increases the contract balance without a
  corresponding increase in the accounted terms, or that decreases the
  balance without a matching decrease in outstanding stakes, fees, or bonds.
- Accounting updates are applied atomically with token transfers, so no
  intermediate state violates the invariant.

## Recommendations

- Keep the property tests in CI so future changes to bet/claim/fee/bond logic
  are checked against the invariant.
- Re-run the ledger-history assertion after any upgrade that touches token
  transfers or accounting fields.
- Treat any invariant violation as a release blocker.
