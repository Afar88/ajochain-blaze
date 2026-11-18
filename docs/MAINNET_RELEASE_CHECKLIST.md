# Mainnet release checklist

**Current status: NOT APPROVED FOR REAL-VALUE CIRCLE OPERATIONS.**

External reviewer handoff: [`MAINNET_EXTERNAL_REVIEW_BRIEF.md`](./MAINNET_EXTERNAL_REVIEW_BRIEF.md).

This checklist is a release control, not a list of UI switches. A checkbox may be marked complete only when the evidence is attached to the release and independently reviewed by someone other than the author of the implementation.

## BCH Classic V1

- [ ] Independent review of `contracts/AjoCircle.cash` and the exact compiled artifact deployed by the app.
- [ ] Adversarial tests for genesis/category creation, payout order, empty/duplicate/missing state NFTs, unexpected tokens, dust, fee ceilings, malformed commitments, and completed circles.
- [ ] Confirm the deployed script template and constructor arguments against independently derived test vectors.
- [ ] Mainnet chain reader with at least two independently operated providers; verify the shared genesis header, the BCH-specific fork checkpoint at height 478,559, and the post-BSV-split BCH checkpoint at height 556,767, then verify tip, script history, complete UTXO set, raw previous transactions and reorg handling. Both the browser read quorum and the PUSD API now check the BCH/BTC and BCH/BSV fork checkpoints before trusting Mainnet tips, UTXOs or unspent-state responses. They also compare tip/UTXO/raw previous-transaction data, but do not prove provider-operator independence or replace SPV/consensus validation.
- [ ] Complete dependency provenance and independent review for the exact pinned `@bitauth/libauth` `3.1.0-next.8` prerelease, which is currently used to invoke `createVirtualMachineBch2026` in the wallet and PUSD verification paths. It remains a prerelease, not a stable audited release. The full generic BCH 2026 corpus comparison completed on 2026-11-17: 29,731 Libauth vectors across 164 files passed, and BCHN `v29.2.0`'s native `libauth_tests/upgrade12_2026` passed 1,065,105 assertions ([audit report](https://github.com/Afar88/ajochain-blaze/actions/runs/43994936516)). Add AjoChain-specific fixtures for every exact compiled legacy and guarded covenant artifact intended for Mainnet and run them against both implementations; this remains outstanding, as do provenance and independent consensus reviews.
- [ ] End-to-end create, contribute, payout, failure, reconnect, and confirmation tests with two independently controlled Selene/WizardConnect wallets.
- [ ] Exact signed transaction verification covering every input outpoint, prevout script and value, sequence, signature/sighash policy, output, fee, and change.
- [ ] External security review and written approval for the deployed artifact and wallet transaction path.

## BCH V2 member-credit covenant

- [ ] Port a separately versioned Mainnet-compatible artifact; do not change the Chipnet-only contract's network validation in place.
- [ ] Independent review of the full-cycle escrow state/receipt transition, exact remaining-round threshold, member deposit cap, payout recipient debit, cancellation lock, and terminal completion. Existing fee-v1 circles are separate legacy rolling-credit deployments.
- [ ] Verified funding-address registration and chain-derived receipt attribution. Browser-saved member addresses are not proof of ownership or funding.
- [ ] Test reorgs, duplicate observations, conflicting events, malformed receipts, unknown tokens, and all member-order edge cases.
- [ ] External audit before any real-value deployment.

CI now emits the exact source SHA-256, compiled artifact JSON SHA-256 and compiled bytecode SHA-256 for the Mainnet BCH V3 circle, PUSD V3 circle and PUSD V3 member-escrow contracts. Preserve those fingerprints with the reviewed commit and deployment record. A fingerprint proves which bytes were built; it is not an independent security approval or proof that the constructor arguments are safe.

## BCH V3 automatic future-contribution reserve covenant

- [ ] Independently audit `contracts/AjoCircleV3AutoReserve.cash` and the exact compiled artifact, including current-round debit, member-specific reserve thresholds, recipient reserve arithmetic, terminal state, dust and overflow.
- [ ] Test each payout position: recipient reserve equals all remaining installments; already-paid members retain their full remaining reserve; unpaid members only need the current installment; final recipient reserve is zero.
- [ ] Reconcile every receipt commitment and the state UTXO value after every payout, including duplicate observations, reorgs, missing receipts and conflicting outputs.
- [ ] Verify exact recipient net payout, immutable 1% treasury output, reserve backing and separately funded miner fee in the actual signed transaction.
- [ ] The `fee-v3-auto-reserve-mainnet` adapter uses the Mainnet quorum reader, Mainnet address validation, and the exact shared BCH/PUSD treasury. The Mainnet workspace now has a read-only server preflight for signed genesis, deposit, payout and cancellation transactions: it independently derives the V3 script from the compiled artifact, checks confirmed Electrum-quorum UTXOs, exact lifecycle layout and BCH 2026 VM execution. It never reserves, relays or broadcasts. Independently audit the exact compiled artifact and constructor binding, then complete real two-wallet device tests and the separate reviewed submission path before release.
- [ ] Complete the same external security review, current-consensus VM validation, independent wallet signing and confirmation testing required for all real-value BCH circles.

## PUSD transfers

- [ ] Confirm PUSD issuer identity, category ID, decimals, and token policy against current issuer-controlled sources.
- [ ] Complete test vectors for raw previous transaction parsing, txid/outpoint binding, wallet script derivation, token amount conservation, BCH carrier dust, fee calculation, and change.
- [ ] Prove provider quorum independence and document each operator; two hostnames alone do not prove independent control.
- [ ] Validate that every server-side input and output is checked against the exact signed bytes and live unspent state.
- [ ] Test unknown broadcast results, duplicate submission, mempool conflicts, replacement, confirmation, and reorg reconciliation.
- [ ] Independent review of the browser verifier, API verifier, and broadcast policy.
- [ ] Obtain real Selene/WizardConnect device tests with token-bearing UTXOs and a small controlled test transaction before proposing a production release.

## Wallet, key and user-safety controls

- [ ] WizardConnect pairing, app switching, reload, timeout, reconnect, fresh pairing, and disconnect tested on supported mobile browsers/devices.
- [ ] Address derivation and receive/change paths cross-checked against the address displayed by Selene.
- [ ] No seed phrases or private keys requested, stored, logged, or sent to AjoChain.
- [ ] Exact transaction details and consequences shown before the wallet signature prompt.
- [ ] A wallet-signed transaction that differs from the approved plan is rejected.
- [ ] Clear pending, confirmed, failed, unknown, replaced, and reorged states; never infer confirmation from a successful relay response.

## Production operations

- [ ] Configure `ELECTRUM_SERVERS` and the same-order `ELECTRUM_PROVIDER_OPERATORS` list in the BLAZE server environment. The API rejects missing, duplicate or mismatched operator IDs and reports only the declared IDs in health responses. These labels are not proof: attach operator ownership, hosting/fault-domain and endpoint-control evidence for every provider; verify monitoring, timeouts and failover separately.
- [ ] PUSD API environment configured with the minimum required settings; no private endpoint credentials are exposed to the browser.
- [ ] Shared Upstash Redis rate limiting is configured and tested across multiple Vercel instances; the serverless path fails closed when the shared limiter is unavailable. Local development alone uses the in-memory limiter. Also test request-size limits, origin handling, error handling, alerting, and incident response in the deployed environment.
- [ ] Production build, CI, dependency review, and security scans pass on the exact release commit.
- [ ] Backup/recovery plan for circle invite metadata and clear disclosure that local browser storage is not a durable account.
- [ ] A staged production release and rollback procedure is tested before opening real-value transactions.

## Current hard stops

- BCH Mainnet circle signing/broadcast is locked by `BCH_MAINNET_OPERATIONS_ENABLED = false`.
- PUSD Mainnet spending is locked by `PUSD_MAINNET_SPENDING_ENABLED = false` in the client and `MAINNET_BROADCAST_ENABLED = false` in the API. Runtime environment variables cannot override the API lock.
- V2 full-cycle escrow remains Chipnet-only. BCH V3 now has a read-only server verifier for Selene-signed genesis, deposit, payout and cancellation transactions. The server independently derives the covenant and checks confirmed provider-quorum inputs, lifecycle outputs and BCH 2026 VM execution. This is not a submission path: BCH Mainnet broadcast remains disabled, and no verified transaction is relayed.
- PUSD circle/escrow contracts are prototypes and are not an active product flow.

Do not remove a hard stop until the corresponding section has evidence, independent approval, and a release commit that has passed the complete test suite. Do not mark the product “Mainnet ready” while any required item remains unchecked.
