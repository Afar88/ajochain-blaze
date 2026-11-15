# V3 automatic future-contribution reserve

**Status: Chipnet prototype only; not approved for real-value Mainnet circles.**

New V3 circles do not require each member to pre-fund the entire contribution cycle. Instead, each member funds the current round. When that member receives their scheduled payout, the covenant atomically retains the full value of every contribution they still owe and credits that reserve to their own immutable member receipt.

## Payout rule

For a circle with:

- `N` members;
- contribution `C` per member per round;
- zero-based payout round `r`;

the transaction computes:

- Gross round pot: (N \times C)
- Current-round debit from every receipt: `C`
- Recipient's future-contribution reserve: ((N-r-1) \times C)
- Project fee: 1% of the gross pot
- Net amount sent to the recipient: (N \times C - 1\%\text{ fee} - (N-r-1) \times C)

The reserve is not a platform fee and is not sent to another member. It remains in the circle state backing and is credited to the current recipient's own receipt NFT in the same covenant transition.

## Eligibility before a payout

- A member who has not yet received a payout must have at least one current contribution `C` in their receipt.
- A member who has already received a payout must have the entire remaining obligation ((N-r) \times C) reserved in their own receipt.
- The payout fails unless every member meets the corresponding threshold.
- After the payout, each receipt is debited by (C), then the current recipient's receipt is credited with the entire remaining reserve.
- The final recipient has no future contributions, so the reserve is zero and their payout is reduced only by the existing 1% project fee.

## Example

For five members contributing 0.002 BCH each:

- Gross pot: 0.010 BCH
- First recipient's future reserve: 0.008 BCH (four remaining contributions)
- Project fee: 0.0001 BCH
- First recipient receives: 0.0019 BCH
- The 0.008 BCH reserve remains assigned to that recipient's member receipt and pays their next four scheduled contributions automatically.

## Compatibility

- V3 uses a new covenant and a new compiled artifact. Existing V1 and V2 circle addresses and rules are not changed.
- V2 full-cycle escrow circles remain readable with their original covenant and original funding requirements.
- V3 is currently Chipnet-only. It must not be described as Mainnet-ready until the current BCH consensus verifier, network transaction path, wallet signing and confirmation process, and independent contract review have passed the release checklist.
