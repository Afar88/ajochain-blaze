# Mainnet transaction flow and release gates

## Product rule

Mainnet is a separate, explicitly gated operating mode—not a network label that turns on transaction actions. Until all release evidence is independently recorded, the app must remain read-only on mainnet. Wallet connection, a selected Mainnet tab, a locally saved circle, or a successful transaction simulation is never sufficient authorization.

The executable fail-closed policy is in `src/core/mainnet-flow.ts`. It is a readiness guard, not a replacement for wallet, chain, contract, or transaction verification.

## Required user journey

1. **Select network** — display Bitcoin Cash Mainnet explicitly. Verify chain identity against an independent mainnet source; never infer it from the address prefix alone.
2. **Connect wallet** — use WizardConnect, confirm the active session and wallet identity, derive the correct receive/change paths, and verify the address/network shown in Selene. A reconnecting or stale session blocks progress.
3. **Load circle** — discover the circle contract and its state/receipt NFTs from confirmed chain data. Validate contract bytecode/version, token category, NFT commitments, member order, contribution amount, fee policy, and current round. Browser storage is only a cache.
4. **Reconcile member accounting** — reconcile every member receipt against confirmed deposits and prior payouts. Check payment uniqueness, ownership, per-member credit, current-round due, carry-forward credit, and payout order. Any missing, duplicated, or inconsistent receipt blocks the circle.
5. **Calculate the action** — distinguish contribution, payout, circle creation, and closure. Calculate in integer base units. Produce a deterministic plan including every input, prevout, output, token, NFT commitment, fee, and change output.
6. **Human transaction review** — show the action, network, contract, recipient, amount, fees, change, token details, and consequences in plain language. The user must explicitly approve this exact plan.
7. **Wallet signature** — ask WizardConnect/Selene to sign only the reviewed transaction. Do not request or retain seed phrases or private keys.
8. **Inspect exact signed bytes** — independently decode the returned raw transaction. Verify network context, all input outpoints and prevout scripts/values, input sequence, signatures and sighash policy, contract bytecode, every BCH/CashToken output, NFT category/capability/commitment, fee, and change. Compare byte-for-byte semantic intent with the reviewed plan. Any mismatch fails closed.
9. **Broadcast** — only after all release gates pass. Broadcast once with an idempotency key; never auto-retry a possibly accepted transaction without checking the chain first.
10. **Confirm and reconcile** — fetch the transaction independently, verify txid and confirmation status, then update the activity feed and member ledger from confirmed chain facts. Pending, failed, replaced, and confirmed states must remain distinct.

## Release gates

All keys in `MAINNET_GATE_KEYS` must be true before broadcast eligibility:

- `networkIdentityVerified`
- `consensusVmVerified`
- `walletSessionVerified`
- `circleStateReconciled`
- `memberAccountingVerified`
- `contractAuditApproved`
- `tokenPolicyVerified`
- `transactionPlanReviewed`
- `signedTransactionInspected`
- `relayAndConfirmationVerified`

These are evidence requirements, not checkboxes that a user can toggle. Evidence must come from the corresponding independent verification step. The initial state is all gates closed.

## Scope and safety limits

- Current BCH and PUSD Mainnet workspaces can validate drafts, prepare unsigned genesis previews, and read chain state for saved circle identities. Their lifecycle planners can prepare unsigned deposit, payout and pre-payout cancellation previews. They do not deploy, sign or broadcast transactions. A saved circle identity is a local reference, not proof that a contract exists.
- The WizardConnect adapter can request signatures for supported experimental paths and inspect selected transaction intent. Mainnet circle preview buttons do not call it. A complete Mainnet signed-byte verifier for every prevout, script, value, fee/change rule, token output and covenant invariant is still outstanding.
- Mainnet broadcast remains disabled by the BCH and PUSD fail-closed guards.
- The BCH V2 contract is experimental and not independently audited. PUSD is not implemented by that covenant.
- Never label the app mainnet-ready until the contract, wallet, chain reconciliation, signed-transaction inspection, and operational gates have evidence and independent review.

## Operational failure handling

- **Wallet disconnect before signing:** discard the pending plan and require fresh session verification.
- **Wallet disconnect after signing:** retain the raw signed transaction only for safe local inspection; do not broadcast automatically.
- **Unknown broadcast result:** query the transaction/inputs before retrying to avoid duplicate spends.
- **Chain reorganization:** mark affected activity as unconfirmed/reorged and rebuild the view from chain data.
- **State mismatch or stale UTXO:** invalidate the plan and restart from circle-state reconciliation.
- **Any verification exception:** fail closed, explain the failed check, and keep broadcast unavailable.
