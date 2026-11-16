# Mainnet reader freshness policy

The browser BCH Mainnet quorum reader and the server-side Mainnet API now reject a tip header more than **30 minutes old**. Both use the same time window so the browser cannot display a tip that the API would consider too stale (or vice versa).

A 30-minute freshness cutoff is a fail-closed availability policy, not proof of chain validity or a replacement for independent provider/chain-work verification. The quorum still requires exact agreement on the current tip/header and UTXO snapshots. It does not yet validate a continuous header chain, proof of work/chainwork, or SPV inclusion proofs. Endpoint operator independence also remains an external trust assumption.

Regression coverage in `src/core/mainnet-quorum-provider.test.ts` now rejects a 31-minute-old tip.
