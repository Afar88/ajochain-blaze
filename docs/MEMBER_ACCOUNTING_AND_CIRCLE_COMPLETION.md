# Member-level accounting and post-payout obligations

## Why this is required

A rotating savings circle must not become a pooled wallet that pays the first recipient and then relies on goodwill for later rounds. Every member remains responsible for contributing in every round, including a member who has already received an earlier payout.

## New V2 full-cycle escrow covenant model

New circles use the separately compiled `AjoCircleV2FeeEscrow.cash` covenant (invite version `fee-v2-escrow`). Existing `fee-v1` invites remain tied to their old immutable contract and are not silently migrated. The legacy fee-v1 model only checks one contribution per payout; a member who abandons a circle after receiving a payout can block every later payout.

The full-cycle escrow version is designed to prevent that specific default:

- Before the first payout, each member must lock `memberCount × contribution` in their own receipt: one contribution for every scheduled payout in the finite rotation.
- Before payout round `r`, each receipt must contain at least `(memberCount - r) × contribution`. Deposits are capped at that exact remaining commitment, so excess BCH cannot become stranded.
- Each payout debits one contribution from every receipt, including the member receiving that payout. The recipient's future obligations remain locked in their receipt; they cannot withdraw those funds after the first payout.
- A payout is impossible while any member's remaining commitment is short, even when the pooled state balance appears sufficient.
- After the final scheduled payout, the state NFT records the terminal round `memberCount`; deposits and payouts are rejected permanently.

This changes the funding schedule: members pre-fund the entire cycle before the first payout instead of relying on future installment promises. For example, a 3-member circle with a 0.002 BCH contribution requires 0.006 BCH locked by each member before payout. This is the on-chain guarantee that an early recipient cannot take the first pot and leave later rounds unfunded.

## Legacy rolling-credit V2 fee circles

Existing `fee-v1` invites preserve their original rules and addresses. They only require one contribution per member at each payout. They are displayed as legacy rolling-credit circles in the UI and must not be described as having full-cycle default protection.

## Ported V2 covenant model

The V2 BCH covenant source is `contracts/AjoCircleV2.cash`. It is a separate contract version; it does not change the rules of existing V1 or pooled-pot circles.

Each circle has:
- one mutable state NFT whose commitment records the current payout round;
- one immutable member receipt NFT per registered member;
- each receipt commitment stores the member index and that member's credit in base units;
- the registered member order determines payout order.

### Contribution rule

A member contribution updates that member's receipt only. The funding input must be signed by the P2PKH address registered for that member. The contract increases the member's credit and preserves the state/receipt covenant outputs.

### Payout rule — the anti-abandonment safeguard

A payout is valid only when **every member's receipt credit is at least one full round contribution**. The covenant then:
1. deducts exactly one contribution from every member receipt;
2. advances the state NFT's round counter;
3. pays the full round pot (subject to the configured fee cap) to the member whose turn it is;
4. keeps the member receipts alive with their remaining balances.

This means the member who received an earlier payout must still fund their receipt for the next round. Receiving a payout does not discharge future contribution obligations. A member who stops contributing leaves their receipt below the required threshold and blocks the next payout rather than allowing the other members' funds to be distributed as if the circle were fully funded.

### Circle completion

The contract marks the circle permanently completed after the final registered member receives a payout by changing the state NFT commitment to `0x54`. The contract's `addCredit` and `payout` paths require the active `0x53 | round` state marker, so a completed circle cannot accept further contributions or payouts.

This is a **finite rotation**, not an automatically repeating one. A repeating-cycle product requires a separately designed and reviewed state transition and must not be implied by this contract. Do not represent a completed circle as accepting another round.

## Credit and carry-forward

Credits are per-member, not a group-wide balance. If a member contributes more than the current round requires, the extra amount remains with that member's receipt and can count toward a later round. The contract consumes one contribution from each receipt per payout, so overpayment by one member cannot silently cover another member's shortfall.

## Wallet and address binding

The wallet integration must:
- derive receive addresses from the WizardConnect public extended key;
- let the member match the address displayed in Selene;
- preserve the selected receive index across saved-session reconnects;
- attribute a deposit only to the registered member address;
- refuse a signing response if the wallet changes any input outpoint, sequence, output, token category, amount, or commitment.

## Scope and limitations

- This port is the BCH V2 prototype only. PUSD member receipts are not implemented by this covenant.
- The original V2 prototype supports 2–5 members; the current product UI's minimum remains 2.
- The contract source is carried over for review. It has **not** yet been compiled or tested in this new repository, deployed, independently audited, or proven safe for mainnet.
- The new app's local ledger is informational and is not a substitute for the on-chain receipt covenant.
- Do not enable real-value deposits, payouts, or contract deployment until contract compilation, adversarial tests, signed transaction inspection, Selene E2E tests, and independent review pass.

## Acceptance tests required before enabling a circle

- A 2-member and a 5-member circle complete every payout in order.
- Each member must contribute again after receiving a prior payout.
- One member below the round contribution blocks payout, even when the pooled BCH balance appears large enough.
- One member's excess credit remains with that member and cannot satisfy another member's deficit.
- Duplicate deposits cannot increase a receipt twice.
- Wrong member funding address, altered member index, altered receipt commitment, missing receipt, wrong payout recipient, and incorrect round transition all fail.
- After N payouts, the circle reaches the terminal state and rejects further deposits and payouts.
