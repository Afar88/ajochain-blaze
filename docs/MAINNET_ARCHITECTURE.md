# Mainnet Architecture and Release Gates

## Scope

This is a clean implementation in `Afar88/ajochain-blaze`. The frozen V1 application is not a source dependency and is not modified by this project.

## Proposed application layers

1. **Presentation** — responsive web application, accessible forms, transaction review screens, circle dashboards, and clear pending/confirmed/failed states.
2. **Wallet adapter** — WizardConnect session lifecycle, supported wallet capability detection, address/network verification, and explicit transaction authorization.
3. **Domain model** — circles, members, contribution periods, member payment ledger, credit balances, and settlement rules.
4. **Transaction planner** — deterministic construction of BCH and supported CashToken transactions, including fee estimation and change handling.
5. **Transaction verifier** — decode the final signed transaction and compare it against the user's approved intent before broadcast.
6. **Network adapter** — explicit mainnet/testnet endpoints, chain identity checks, broadcast, and independent confirmation lookup.
7. **Persistence/indexing** — application metadata only; chain state must be reconciled against authoritative transaction data rather than trusting browser-local state.

## Mainnet transaction invariants

Before broadcast, verify:

- The transaction targets the expected network and correct contract/script.
- Every input is expected, spendable, and correctly accounted for.
- BCH amounts and token amounts use integer base units; no floating-point arithmetic.
- Every CashToken category, fungible amount, NFT capability, and commitment is preserved exactly as intended.
- Outputs, change, fees, and recipient addresses match the reviewed transaction plan.
- The signed transaction is the same transaction the user approved; no post-approval mutation is possible.
- The wallet has authorized the exact transaction and the UI displays the resulting txid after broadcast.

Any mismatch must fail closed and prevent broadcast.

## Circle accounting invariants

- A member's payment is credited to that member, not inferred from the aggregate circle balance.
- Overpayment/leftover credit is tracked per member and wallet identity.
- A contribution period cannot be counted twice.
- Retries and duplicate broadcasts are idempotent.
- Circle totals reconcile to member ledger entries and confirmed on-chain activity.
- Membership changes cannot rewrite historical contribution records.

## Wallet requirements

- WizardConnect is the required connection path for the hackathon.
- Selene support must be validated on real supported devices and wallet versions.
- Display the address and network returned by the active wallet session.
- Reconnection must not silently create a second pairing or disconnect a healthy session.
- Never request or store recovery phrases or private keys.

## Release gates

| Gate | Evidence required | Status |
|---|---|---|
| Network correctness | Mainnet/testnet identity tests and endpoint verification | Not started |
| Wallet integration | Independent WizardConnect/Selene device tests | Not started |
| Transaction verification | Signed-transaction decode and intent comparison tests | Not started |
| CashToken/PUSD | Token category, amount, NFT and change tests | Not started |
| Contract safety | Independent review and adversarial test report | Not started |
| Accounting | Ledger invariants, replay and duplicate-payment tests | Not started |
| Operations | Monitoring, incident plan and recovery procedure | Not started |

## Deployment policy

The website can be deployed independently from the frozen V1 website. A public mainnet-capable interface may be demonstrated in read-only or non-broadcast mode while release gates are incomplete. Real-value contract deployment and real-money circle operations remain disabled until all applicable gates are signed off.
