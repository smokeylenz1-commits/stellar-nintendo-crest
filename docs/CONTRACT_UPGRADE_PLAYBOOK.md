# Contract Upgrade Playbook

Operational runbook for upgrading the live Soroban prediction-market contract
(`contracts/prediction_market`) that holds user funds. Follow every step in
order. Do **not** skip the simulation or hash-verification gates.

> Scope: this playbook covers the `upgrade(admin, new_wasm_hash)` entrypoint
> already exposed by the contract. It does not change contract code.

---

## 0. Preconditions

- [ ] Change is reviewed and merged; CI is green on the release commit.
- [ ] You have the exact commit SHA / tag to deploy (record it below).
- [ ] Admin key is available via the multi-sig (never a single hot key).
- [ ] A maintenance window is agreed; on-call is aware.
- [ ] A rollback WASM (current live hash) is recorded before you start.

Record before starting:

```
RELEASE_COMMIT=<git sha or tag>
CURRENT_WASM_HASH=<sha256 of currently deployed wasm>
NEW_WASM_HASH=<filled in during step 2>
```

---

## 1. Build the optimized WASM

Build a reproducible, optimized artifact from the release commit.

```bash
cd contracts/prediction_market
cargo build --target wasm32-unknown-unknown --release
stellar contract optimize \
  --wasm target/wasm32-unknown-unknown/release/prediction_market.wasm
```

The optimized artifact is written next to the input, e.g.
`.../prediction_market.optimized.wasm`. Use **only** the optimized artifact
from here on.

---

## 2. Compute the SHA-256 hash

```bash
sha256sum prediction_market.optimized.wasm
```

- [ ] Record the output as `NEW_WASM_HASH`.
- [ ] Confirm the build is reproducible: rebuild from the same commit on a
      clean checkout and confirm the hash matches byte-for-byte.

---

## 3. Deploy WASM to Stellar Testnet

Upload the WASM to Testnet and capture the returned wasm hash.

```bash
stellar contract upload \
  --wasm prediction_market.optimized.wasm \
  --source <testnet-admin> \
  --network testnet
```

- [ ] The hash returned by `upload` must equal `NEW_WASM_HASH`.

---

## 4. Run automated migration tests on Testnet

Point the test suite at the Testnet deployment and run the migration tests.

```bash
# from repo root
cargo test --workspace --features testnet-migration
```

- [ ] All migration tests pass.
- [ ] Exercise the upgrade path on Testnet first:

```bash
stellar contract invoke \
  --id <testnet-contract-id> \
  --source <testnet-admin> \
  --network testnet \
  -- upgrade \
  --admin <testnet-admin-address> \
  --new_wasm_hash <NEW_WASM_HASH>
```

- [ ] Verify existing markets/bets are still readable after the Testnet upgrade
      (storage is preserved; only the executable changes).

---

## 5. Verify byte-for-byte hash identity

Before touching Mainnet, prove the deployed WASM is identical to the local build.

```bash
# Fetch the deployed wasm from Testnet and hash it
stellar contract fetch \
  --id <testnet-contract-id> \
  --network testnet \
  --out deployed.wasm
sha256sum deployed.wasm
```

- [ ] `sha256sum deployed.wasm` == `NEW_WASM_HASH` (byte-for-byte).
- [ ] If the hashes differ, **STOP**. Do not proceed to Mainnet. Rebuild and
      re-upload; investigate toolchain/optimizer version drift.

---

## 6. Execute the multi-sig admin upgrade on Mainnet

Only after steps 1–5 pass.

1. Upload the WASM to Mainnet:

   ```bash
   stellar contract upload \
     --wasm prediction_market.optimized.wasm \
     --source <mainnet-admin> \
     --network mainnet
   ```

   - [ ] Returned hash == `NEW_WASM_HASH`.

2. Build the `upgrade` invocation and collect multi-sig signatures:

   ```bash
   stellar contract invoke \
     --id <mainnet-contract-id> \
     --source <mainnet-admin> \
     --network mainnet \
     -- upgrade \
     --admin <mainnet-admin-address> \
     --new_wasm_hash <NEW_WASM_HASH>
   ```

   - [ ] All required signers approve the transaction.
   - [ ] Submit and confirm the transaction hash.

3. Confirm the on-chain wasm hash now equals `NEW_WASM_HASH`.

---

## 7. Verify event indexing resumes

- [ ] Confirm the indexer is caught up to the upgrade ledger.
- [ ] Confirm new events (bets, resolutions, claims) are indexed after the
      upgrade ledger.
- [ ] Spot-check a post-upgrade bet and claim end-to-end.
- [ ] Confirm no gaps in the event stream around the upgrade ledger.

---

## 8. Rollback procedure

If the upgrade misbehaves, revert to the previously deployed WASM.

1. The old WASM is still on-chain (uploaded previously). Re-run `upgrade`
   pointing at the **previous** hash:

   ```bash
   stellar contract invoke \
     --id <mainnet-contract-id> \
     --source <mainnet-admin> \
     --network mainnet \
     -- upgrade \
     --admin <mainnet-admin-address> \
     --new_wasm_hash <CURRENT_WASM_HASH>
   ```

2. Collect multi-sig signatures and submit.
3. Re-run step 7 verification.
4. If the previous WASM is not available on-chain, re-upload it from the
   recorded artifact and then run the `upgrade` call above.

---

## 9. Abort contingency

Abort **before** the Mainnet `upgrade` transaction is submitted if any gate
fails (hash mismatch, failing migration tests, missing signers).

- Aborting pre-submission is safe: no on-chain state changes.
- If the Mainnet `upgrade` transaction is submitted but not yet confirmed,
  do not re-submit; wait for finality, then verify the resulting hash.
- If the upgrade succeeded but is faulty, follow the rollback procedure (step 8).
- Escalate to on-call and freeze further upgrades until root cause is known.

---

## 10. Post-upgrade checklist

- [ ] On-chain wasm hash == `NEW_WASM_HASH`.
- [ ] Event indexing verified (step 7).
- [ ] Rollback hash recorded and confirmed reachable.
- [ ] Upgrade transaction hash and ledger recorded in the incident/change log.
