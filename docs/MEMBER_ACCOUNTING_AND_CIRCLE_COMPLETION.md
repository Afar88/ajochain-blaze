# Member-level accounting and post-payout obligations

## The default-prevention rule

A rotating savings circle must not depend on a recipient voluntarily paying future rounds after receiving the pot. For new circles, AjoChain uses a full-cycle escrow covenant: **every member locks all contributions for the remaining scheduled payouts before a payout can occur.**

This is deliberately stronger than a rolling monthly promise. It requires more funds up front, but it gives the covenant control over the entire future payout schedule.

## New `fee-v2-escrow` BCH covenant

New circles use `contracts/AjoCircleV2FeeEscrow.cash`, a separately compiled contract artifact. Each circle has:
- one mutable state NFT storing the current scheduled payout round and irreversible first-payout marker;
- one immutable member receipt NFT storing each member's own credit;
- an immutable member order and treasury destination in the contract constructor.

### Funding and escrow accounting

For `N` members and contribution `C`:
- Before the first payout, every member must lock `N × C` in their own receipt.
- Before payout round `r` (zero-indexed), each member must have at least `(N - r) × C` remaining in that receipt.
- Deposits are capped at the exact remaining commitment. This prevents excess funds from being trapped when the circle closes.
- The state BCH reserve must equal the sum of all receipt credits plus the fixed 1,000-satoshi reserve.

### Payout and anti-abandonment protection

A payout is valid only when every receipt covers every scheduled contribution that remains. The covenant then:
1. debits exactly one contribution from every member's receipt, including the scheduled payout recipient;
2. advances the state NFT to the next scheduled recipient;
3. pays the round pot, less the immutable 1% project fee, to that recipient;
4. leaves all future contributions locked in their original member receipts.

This is the protection against an early recipient disappearing: their future contributions were already escrowed before they received the first pot. They cannot withdraw those funds after the first payout, and later payouts do not depend on them returning to make another manual deposit. A member whose receipt is underfunded blocks the payout before any member is paid.

### Completion

After the final scheduled payout, the state commitment records terminal round `memberCount` with the paid flag set. The contract permanently rejects any further deposits or payouts. This is a single finite rotation, not an automatic repeating cycle.

### Example

For a 3-member circle with a 0.002 BCH contribution:
- each member must lock 0.006 BCH before the first payout;
- each round pays 0.006 BCH gross to the scheduled member;
- after each payout, every receipt is debited by 0.002 BCH;
- after three payouts, all member receipts have discharged the scheduled contribution commitment and the circle closes.

## Member accountability ledger in the app

The Chipnet workspace reads the state NFT and every member receipt from chain data and displays:
- paid-in total (consumed contributions plus current receipt credit);
- current BCH locked in each member's receipt;
- amount required for all remaining payouts;
- current shortfall, if any;
- whether the member has already received their scheduled payout;
- whether the member's future commitment is fully secured;
- whether the circle is payout-locked, payout-unlocked, or complete.

The UI is only a presentation of the chain state. The contract—not a local checkbox or browser-only ledger—enforces the escrow threshold, member attribution, per-payout debit, terminal state and no-withdrawal-after-first-payout rule.

## Legacy compatibility

Existing `fee-v1` invites and contract addresses are preserved. That earlier rolling-credit covenant requires one contribution per member per payout, but it does not pre-fund the whole future rotation. If a member disappears after receiving a payout, it can block subsequent rounds. The UI identifies fee-v1 circles as legacy rolling-credit and does not claim full-cycle default protection.

The original `AjoCircleV2.cash` contract and Classic V1 aggregate-pot circles are also separate historical versions. No old circle is silently migrated or gains new accounting guarantees retroactively.

## Wallet and address binding

- The member receipt is indexed to the address registered at circle creation.
- A deposit must be funded by that member's registered P2PKH address and signed through WizardConnect/Selene.
- Pooled deposits from mixed or ambiguous funding addresses are not attributed as a member credit.
- The wallet transaction must preserve exact inputs, outputs, CashToken categories, NFT commitments, fees and change.
- No seed phrase or private key is requested, stored, logged or transmitted by AjoChain.

## Scope and release status

- The full-cycle escrow covenant described above is BCH-only and Chipnet-only. It prefunds every remaining scheduled contribution at genesis.
- PUSD uses a separate Mainnet V3 member-receipt and escrow-sidecar prototype. It has a different, rolling rule: the non-final scheduled recipient has exactly one next-round contribution withheld from their payout and placed in their own escrow. That exact per-member contribution is consumed at the following payout; the final recipient has no reserve. This is not full-cycle prefunding.
- The covenant is experimental and unaudited. Passing automated tests is not independent security approval. PUSD Mainnet spending and all Mainnet circle signing/broadcasting remain disabled pending their separate release gates, current BCH consensus VM verification, external contract review, provider verification, and real Selene/WizardConnect Mainnet tests.
- PUSD member receipts are not part of the BCH covenant described in this document; see [BCH, PUSD and Member Accounting](./BCH_PUSD_MEMBER_ACCOUNTING.md) for the separate PUSD V3 design and release status.

## Acceptance tests

- Two-member and five-member circles complete every scheduled payout in order.
- The first payout cannot occur until every member has prefunded all scheduled payouts.
- The first recipient's later contribution remains locked, so the next payout can proceed without any new deposit.
- A short member receipt blocks payout even when pooled BCH value appears sufficient.
- One member cannot fund another member's receipt.
- Deposits greater than the exact remaining member commitment are rejected.
- Payout debits one contribution from every member receipt, including the recipient.
- Payout sends exactly gross pot minus the 1% project fee to the scheduled recipient; miner fees are separately funded.
- Cancellation is available only before the first payout and refunds the exact recorded credits.
- After N payouts, the terminal state rejects all further deposits and payouts.
