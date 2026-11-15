# Mainnet Architecture and Release Gates

## Scope

This is an independent implementation in `Afar88/ajochain-blaze`. The frozen V1 application is not a source dependency and is not modified by this project.

## Mainnet-first architecture

1. **Presentation and review** — network identity, circle state, member obligations, plain-language action summary, fee/change breakdown, explicit approval, and pending/confirmed/failed/reorged status.
2. **WizardConnect wallet adapter** — session lifecycle, wallet capability detection, Selene receive/change path verification, signature request, disconnect handling, and no secret-key custody.
3. **Chain reader and reconciler** — independent mainnet identity, contract bytecode/version, UTXO and CashToken/NFT state, transaction history, confirmations, and reorg detection. Browser state is a cache only.
4. **Circle domain model** — immutable member order, contribution rounds, per-member receipt credit, duplicate-payment prevention, payout recipient, finite completion state, and closure rules.
5. **Transaction planner** — deterministic creation of BCH/CashToken transactions with exact inputs, prevouts, scripts, values, outputs, fee cap, change, token categories, NFT capabilities, and commitments.
6. **Transaction verifier** — decode exact signed bytes and independently verify every input, prevout, signature policy, contract script, output, token, fee, and change against the approved plan.
7. **Broadcast and confirmation adapter** — idempotent broadcast, unknown-result reconciliation, independent tx lookup, confirmation tracking, and reorg recovery.
8. **Evidence and release policy** — fail-closed gates in `src/core/mainnet-flow.ts`; a user-selected network or connected wallet can never open a gate.

## Required mainnet user journey

Network selection → wallet verification → chain-backed circle discovery → member-ledger reconciliation → action calculation → human-readable transaction review → explicit wallet signature → exact signed-byte inspection → gated broadcast → independent confirmation → ledger reconciliation.

A stale wallet session, changed UTXO, duplicate payment, unknown contract version, member credit mismatch, unexpected token/NFT, fee/change deviation, signature mismatch, or uncertain broadcast result must stop the flow and require reconciliation.

## Mainnet transaction invariants

- The transaction targets verified BCH mainnet and the expected contract/script version.
- Every input outpoint, prevout script and value is known and spendable.
- BCH and CashToken amounts use integer base units.
- Every token category, fungible amount, NFT capability and commitment matches the plan.
- Outputs, recipient, fee and change match the approved review.
- The signed transaction is semantically identical to the reviewed plan, apart from permitted unlocking data.
- Wallet authorization is bound to the exact request; no post-approval mutation is possible.
- Broadcast is idempotent and never blindly retried after an ambiguous response.
- UI state changes to confirmed only after independent chain confirmation.

Any mismatch fails closed and prevents broadcast.

## Circle accounting invariants

- A member's payment is credited to that member, never inferred from pooled balance.
- Excess credit remains with its owner.
- Every registered member must satisfy their own round obligation before payout.
- A contribution transaction is credited once, globally, and only to its verified member.
- Circle totals reconcile to member receipts and confirmed on-chain activity.
- Membership and payout order cannot rewrite historical records.
- The current V2 prototype terminates after the final member payout; it does not loop into a new cycle.

## Release gates

The executable guard starts with every gate closed. Evidence must be independently generated; no UI checkbox can authorize mainnet broadcast.

| Gate | Evidence required | Status |
|---|---|---|
| Network identity | Independent mainnet chain identity and endpoint verification | Blocked |
| Wallet | WizardConnect/Selene device E2E, reconnect and signing tests | Blocked |
| Circle state | Contract version, state NFT and all receipt UTXOs reconciled | Blocked |
| Member accounting | Per-member credit, duplicate/replay and round invariants | Blocked |
| Contract | CashScript compilation, adversarial tests and independent audit | Blocked |
| Token policy | BCH and CashToken category/amount/NFT/change tests; PUSD scope defined | Blocked |
| Transaction plan | Exact inputs, prevouts, outputs, fee and change reviewed | Blocked |
| Signed transaction | Exact raw bytes decoded and compared with approved intent | Blocked |
| Broadcast/confirmation | Idempotent relay and independent confirmation/reorg tests | Blocked |

## Current implementation boundary

The app currently provides a local draft UI and a WizardConnect connection adapter. It does not yet discover authoritative mainnet circles, reconcile on-chain member receipts, or broadcast. The current signature helper checks transaction version, locktime, input outpoints/order/sequences, and serialized outputs; it does **not** yet independently verify all prevout scripts/values, fee/change policy, signature sighash rules, covenant semantics, or confirmation status. Do not describe it as a complete mainnet verifier.

## Deployment policy

The public interface may be demonstrated in read-only mode. Real-value contract deployment, contributions, payouts and broadcast remain disabled until every applicable gate has verifiable evidence and independent review.
