# V3 automatic next-contribution reserve

**Status: Chipnet prototype only; not approved for real-value Mainnet circles.**

New V3 circles do not require each member to pre-fund the entire cycle. Each member funds the current round. When a member receives their scheduled payout, the covenant withholds **exactly one contribution** for that member's next scheduled round and credits it to that member's own immutable receipt NFT.

The withheld amount is determined by the contribution amount, then shown as a percentage of the recipient's pre-reserve payout. It is not a platform fee and is not paid to the next member directly.

## Payout calculation

For a circle with:
- `N` members;
- contribution `C` per member per round;
- zero-based payout round `r`;

the payout computes:
- Gross round pot: `N * C`
- Current-round debit from every member receipt: `C`
- Next-installment reserve: `C` for a non-final recipient, otherwise `0`
- Project fee: `floor(N * C / 100)` (1% of the gross pot)
- Recipient net payout: `N * C - project fee - next-installment reserve`

The reserved contribution stays backed by the circle state UTXO and is credited to the recipient's own receipt in the same covenant transition. At the next round, it is automatically consumed as that member's contribution.

## Eligibility before each payout

- Every member must have one contribution `C` available for the current round.
- That amount can come from the one-installment reserve retained from their previous payout, or from a fresh contribution deposit.
- The payout is blocked if any member is missing that current-round contribution.
- On payout, every receipt is debited by `C`; the recipient's receipt is then credited with one next installment, except on the final payout.
- The final recipient has no next installment, so no reserve is withheld from their payout.

## Example: five members

For five members contributing 0.002 BCH each, on the first payout:
- Gross pot: 0.010 BCH
- 1% project fee: 0.0001 BCH
- Next-installment reserve: 0.002 BCH
- First recipient receives: 0.0079 BCH
- The 0.002 BCH reserve stays assigned to that recipient's receipt and covers their next scheduled contribution only.

The equivalent reserve percentage is approximately 20.20% of the payout before reserve (after the 1% project fee).

## Important limitation

This rule secures exactly the recipient's next installment, not every future installment. If that member stops contributing permanently, the withheld amount covers the following round once. After it is consumed, later rounds still require that member to contribute again.

Therefore, this rule reduces the immediate post-payout default risk. By itself, it does **not** guarantee completion of every later round if a member stops permanently. A full-cycle guarantee would require a larger reserve covering all remaining installments; that is a different policy from the one-installment rule specified here.

## Compatibility

- V3 uses a new covenant and a new compiled artifact. Existing V1 and V2 circle addresses and rules are not changed.
- V2 full-cycle escrow circles remain readable under their original covenant and original funding requirements.
- V3 is Chipnet-only. It must not be described as Mainnet-ready until the current BCH consensus verifier, network transaction path, wallet signing and confirmation process, and independent contract review have passed the release checklist.
