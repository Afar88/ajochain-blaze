# Mainnet transaction flow and per-path release gates

## Product rule

BLAZE reads circle identity and current state from BCH. On-chain discovery is not dependent on a central server registry or application database. Wallet connection, a selected Mainnet tab, a locally saved circle or a successful simulation is never proof of membership, payment or confirmation.

Mainnet transaction paths are version-specific and have separate gates. Do not use the Classic BCH gate to disable or describe the dedicated BCH V3 path, and do not confuse BCH V3 status with the separately gated PUSD path.

## Current path status

- **BCH V3 Mainnet:** on-chain discovery plus a dedicated Selene signing and broadcast path. The client `BCH_MAINNET_CIRCLE_SEND_ENABLED` and API `BCH_MAINNET_CIRCLE_BROADCAST_ENABLED` gates are enabled in the current code.
- **Classic BCH Mainnet:** controlled by `BCH_MAINNET_OPERATIONS_ENABLED`; this generic legacy path remains disabled.
- **PUSD V3 Mainnet circles:** genesis/deposit/payout/cancel signed-byte verification and the separate durable-ledger-backed broadcast route are implemented; `PUSD_MAINNET_CIRCLE_BROADCAST_ENABLED` is true in code.
- **Ordinary PUSD Mainnet transfers:** remain separately locked by `PUSD_MAINNET_SPENDING_ENABLED = false` and `MAINNET_BROADCAST_ENABLED = false`. Do not conflate this transfer lock with the PUSD circle route.

An enabled code path is not the same as an independent security audit or complete operational assurance. Validate the exact action and contract version, but do not accidentally disable a separate working path through an unrelated guard.

## Required user journey

1. **Select network** — display Bitcoin Cash Mainnet explicitly. Verify the shared genesis header, the BCH-specific checkpoint at height 478,559, and the post-BSV-split BCH checkpoint at height 556,767, then compare the current tip against the configured sources.
2. **Connect wallet** — use WizardConnect, confirm the active session and wallet identity, derive the correct receive/change paths, and verify the address/network shown in Selene. A stale session blocks signing.
3. **Discover/load circle** — read wallet script history and candidate transaction data from BCH through Electrum. Check raw transaction bytes against their TXIDs, parse the discovery note, validate token category/state/receipt/member-marker outputs, rebuild the expected covenant and confirm that the connected wallet is an on-chain member. Invite links are convenience references, not source-of-truth records.
4. **Reconcile circle state** — derive contract version, state/receipt NFTs, escrow outputs, confirmed contributions and prior payouts from chain data. Browser storage is a cache only.
5. **Calculate the action** — distinguish create, contribution, payout and closure. Calculate in integer base units and build a deterministic plan with inputs, previous outputs, token commitments, recipient outputs, fee and change.
6. **Human transaction review** — show the action, network, contract, recipient, amount, fees, change, token details and consequences in plain language. The user must approve the exact plan.
7. **Wallet signature** — ask Selene/WizardConnect to sign only the reviewed transaction. Do not request or retain seed phrases or private keys.
8. **Inspect exact signed bytes** — decode the returned raw transaction and compare the signed transaction with the approved plan, including prevouts, scripts, values, signatures/sighashes, contract bytecode, token outputs, fees and change.
9. **Broadcast through the matching path** — BCH V3 uses its dedicated Mainnet route and gate. Classic BCH and PUSD must continue to use their own separate guards. Never bypass a failed exact-byte verification.
10. **Confirm and reconcile** — fetch the transaction independently, verify its TXID and chain status, then update activity and member accounting from confirmed BCH facts. A wallet response or relay acceptance alone is not confirmation.

## Chain-provider role

Electrum endpoints provide history, UTXOs, raw transactions, fee estimates and tip data. They are chain-data providers, not a circle database, registry or application backend. A provider quorum improves consistency checks but does not prove independent operator ownership or local SPV/chainwork validation.

## PUSD verification and submission

The PUSD verification route (`POST /api/pusd/circle/verify`) checks the exact signed transaction against authenticated previous outputs, compiled circle/escrow artifacts and BCH VM execution, then discards the signed bytes without broadcasting. The separate PUSD V3 circle route (`POST /api/pusd/circle/broadcast`) repeats the checks, atomically reserves the transaction and input outpoints in the durable Upstash ledger, then relays once. The ordinary PUSD wallet-transfer route remains separately disabled. The ledger is an idempotency/reconciliation safeguard only; it is never the source of circle identity or member state.

## Operational failure handling

- **Wallet disconnect before signing:** discard the pending plan and require a fresh wallet session.
- **Wallet disconnect after signing:** do not silently mutate the reviewed transaction or broadcast a different one.
- **Unknown broadcast result:** query the exact TXID and raw transaction across providers before any manual retry. An unknown result is not proof of failure.
- **Chain reorganisation:** mark affected activity unconfirmed/reorged and rebuild the view from chain data.
- **State mismatch or stale UTXO:** invalidate the plan and restart from on-chain state reconciliation.
- **Verification exception:** explain the failed check and do not submit that transaction.

This document distinguishes the BCH V3, Classic BCH and PUSD Mainnet paths. Their gates and current status must never be merged into one global on/off statement.
