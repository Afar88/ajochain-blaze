# ParyonUSD (PUSD) CashToken integration

## Verified asset identity

PUSD is the ParyonUSD fungible CashToken on Bitcoin Cash mainnet.

- Network: Bitcoin Cash mainnet
- Symbol: PUSD
- Decimals: 2
- Canonical category ID: `2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544`
- Issuer reference: https://paryonusd.com/

The category ID is pinned in `src/core/assets.ts`. A ticker or token name is never sufficient to identify a CashToken; the category ID must match. The current configuration intentionally does not assign this mainnet category to Chipnet.

## Implemented in this repository

- Canonical PUSD category ID and mainnet network scope.
- Exact integer base-unit conversion; 1 PUSD = 100 raw fungible units.
- Two-decimal input precision enforcement in circle draft validation.
- CashTokens signed 64-bit positive fungible amount ceiling enforcement.
- Case-insensitive canonical category ID comparison helper.
- UI hint explaining PUSD precision and that the current selection is only a local draft.
- Chipnet draft guard: PUSD cannot be selected for a Chipnet draft because no verified Chipnet category ID is configured.
- Strict PUSD UTXO selection helper: exact category only, deterministic smallest-sufficient selection, duplicate outpoint rejection, and NFT-bearing UTXO rejection.
- Tests for amount parsing, formatting, precision, category identity, byte order, network scope, maximum amount, and UTXO selection.

## Mainnet V3 circle build (in progress)

- A separate `AjoCirclePUSDV3Mainnet.cash` contract and `AjoPUSDMemberEscrowV3.cash` sidecar have been added. They target the real ParyonUSD Mainnet category; no Chipnet/test token is substituted.
- The V3 source pins the shared BCH/PUSD Mainnet project treasury `bitcoincash:zqtu3577x0swy2gsra6km3033xcj8swg8s4rld9w7q` into its constructor.
- The proposed payout transition pays 1% of the gross PUSD pot to that treasury as a separate PUSD output, retains one next contribution in the non-final recipient's own escrow, and pays no reserve to the final recipient.
- A pre-first-payout cancellation branch refunds each member's exact PUSD escrow and associated BCH carrier backing. Cancellation is unavailable after the first payout.
- The Circles page now has a Mainnet-only PUSD workspace with exact base-unit fee and reserve previews, local draft persistence, and an unsigned genesis planner.
- The PUSD core now has unsigned genesis, member-deposit, payout and pre-first-payout cancellation planners, plus a chain-state reader that reconciles the state NFT, every member receipt and each member escrow.
- The Circles page can restore the saved circle identity, read current Mainnet state, display per-member escrow credits, and prepare unsigned deposit, payout and cancellation previews. It does not call the wallet signer or broadcast endpoint.
- The payout covenant/state logic rejects an advanced round carrying an unpaid genesis marker. CashScript compilation and MockNetworkProvider lifecycle tests run in CI. These are prototype checks, not independent Mainnet evidence.

Outstanding work includes independent genesis output inspection, fresh UTXO revalidation immediately before a future signature, exact signed-byte verification of every input/output/fee/carrier, independent Selene/WizardConnect lifecycle tests, idempotent broadcast and confirmation/reorg handling, provider-operator verification, and external security review. The Mainnet spend and broadcast guards remain closed.

## Not yet implemented — deliberately blocked

The current `AjoCircleV2.cash` contract is a BCH-only prototype. Its member receipts and state NFT are defined under one circle category, and contribution funding currently expects a BCH P2PKH input. It does not accept, preserve, account for, or pay out PUSD CashTokens.

Therefore this repository does **not** yet support:
- PUSD token inputs or token-bearing change outputs in circle contributions.
- PUSD category/amount conservation across contract transitions.
- PUSD-denominated member receipts and per-member credit.
- PUSD payouts to the selected recipient.
- Verified PUSD UTXO discovery, token-aware transaction planning, signing inspection, broadcasting, or confirmation.
- A Chipnet PUSD test token.

Do not infer that selecting PUSD in the draft UI creates a PUSD circle. It only saves a local proposal. No signing or broadcasting is available.

## Required engineering work before PUSD circles can go live

1. Design a new token-aware covenant version. Do not retrofit the BCH-only covenant by simply changing a symbol or category constant.
2. Define whether PUSD is held as fungible token amounts in member receipt UTXOs, separate from BCH dust needed to carry the CashToken outputs.
3. Enforce exact PUSD category, fungible amount conservation, NFT category/capability/commitment, BCH carrier values, and allowed token-bearing change in every transition.
4. Define and test rounding, partial top-ups, member-owned rollover, fees, and payout amount in PUSD base units.
5. Verify actual PUSD UTXOs from an independent mainnet indexer and cross-check category IDs against issuer metadata.
6. Test all covenant transitions on a verified test token with equivalent CashToken semantics before mainnet review.
7. Independently audit the token-aware covenant and exact signed transaction verifier.
8. Keep all mainnet signing/broadcast gates closed until the above evidence exists.

## Amount examples

| Display amount | Raw PUSD units |
|---:|---:|
| 1.00 PUSD | 100 |
| 12.34 PUSD | 1,234 |
| 100.00 PUSD | 10,000 |

All amounts are integers internally. Floating-point arithmetic must not be used for CashToken quantities.
