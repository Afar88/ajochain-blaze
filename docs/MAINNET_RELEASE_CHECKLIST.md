# Mainnet release checklist

**Current status: NOT APPROVED FOR REAL-VALUE CIRCLE OPERATIONS.**

This checklist is a release control, not a list of UI switches. A checkbox may be marked complete only when the evidence is attached to the release and independently reviewed by someone other than the author of the implementation.

## BCH Classic V1

- [ ] Independent review of `contracts/AjoCircle.cash` and the exact compiled artifact deployed by the app.
- [ ] Adversarial tests for genesis/category creation, payout order, empty/duplicate/missing state NFTs, unexpected tokens, dust, fee ceilings, malformed commitments, and completed circles.
- [ ] Confirm the deployed script template and constructor arguments against independently derived test vectors.
- [ ] Mainnet chain reader with at least two independently operated providers; verify chain identity, tip, script history, complete UTXO set, raw previous transactions and reorg handling. The new browser quorum reader cross-checks chain tips, UTXO snapshots and previous-transaction bytes, but does not prove provider operator independence or replace SPV/consensus validation.
- [ ] Use a stable verifier that implements the active 15 May 2026 BCH consensus rules (BCH_2026_05); record the exact package/version and consensus test evidence. The currently pinned stable Libauth 3.0.0 exposes the BCH 2023 VM; the Libauth BCH 2026 VM is currently in its 3.1.0-next prerelease line. Do not authorize real-value signing/broadcast with the older VM or adopt an unreleased prerelease dependency without independent review.
- [ ] End-to-end create, contribute, payout, failure, reconnect, and confirmation tests with two independently controlled Selene/WizardConnect wallets.
- [ ] Exact signed transaction verification covering every input outpoint, prevout script and value, sequence, signature/sighash policy, output, fee, and change.
- [ ] External security review and written approval for the deployed artifact and wallet transaction path.

## BCH V2 member-credit covenant

- [ ] Port a separately versioned Mainnet-compatible artifact; do not change the Chipnet-only contract's network validation in place.
- [ ] Independent review of state NFT and each member receipt transition, including payout recipient debit, overpayment carry-forward, cancellation lock, and final-circle completion.
- [ ] Verified funding-address registration and chain-derived receipt attribution. Browser-saved member addresses are not proof of ownership or funding.
- [ ] Test reorgs, duplicate observations, conflicting events, malformed receipts, unknown tokens, and all member-order edge cases.
- [ ] External audit before any real-value deployment.

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

- [ ] Mainnet provider endpoints and their operators are independently verified, monitored, and covered by timeouts/failover tests.
- [ ] PUSD API environment configured with the minimum required settings; no private endpoint credentials are exposed to the browser.
- [ ] Rate limiting, request-size limits, origin handling, error handling, alerting, and incident response tested in the deployed environment.
- [ ] Production build, CI, dependency review, and security scans pass on the exact release commit.
- [ ] Backup/recovery plan for circle invite metadata and clear disclosure that local browser storage is not a durable account.
- [ ] A staged production release and rollback procedure is tested before opening real-value transactions.

## Current hard stops

- BCH Mainnet circle signing/broadcast is locked by `BCH_MAINNET_OPERATIONS_ENABLED = false`.
- PUSD Mainnet spending is locked by `PUSD_MAINNET_SPENDING_ENABLED = false` in the client and `MAINNET_BROADCAST_ENABLED = false` in the API. Runtime environment variables cannot override the API lock.
- V2 fee/member-credit circles are Chipnet-only.
- PUSD circle/escrow contracts are prototypes and are not an active product flow.

Do not remove a hard stop until the corresponding section has evidence, independent approval, and a release commit that has passed the complete test suite. Do not mark the product “Mainnet ready” while any required item remains unchecked.
