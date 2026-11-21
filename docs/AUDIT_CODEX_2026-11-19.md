# AjoChain Blaze security audit — 2026-11-19

Repository: `Afar88/ajochain-blaze`
Audited ref: `main`
Scope: V3 BCH covenant, PUSD V3 covenants, BCH Mainnet transaction verifier, transaction planner and wallet-signature verification paths.
Method: source inspection through the GitHub repository integration. No files other than this report are changed.

## Findings

### 1. [medium] PUSD V3 has no terminal close/refund branch; contract BCH backing remains locked

**Location**
- `contracts/AjoCirclePUSDV3Mainnet.cash:141-211`
- `contracts/AjoCirclePUSDV3Mainnet.cash:262-275`
- `contracts/AjoPUSDMemberEscrowV3.cash:85-107`
- `contracts/AjoPUSDMemberEscrowV3.cash:110-146`

**Scenario**

On the final scheduled payout, `payout()` still requires the normal `2 * memberCount + 4` output layout and recreates the state NFT, every receipt NFT, and every escrow output. It advances the state commitment to `round + 1`, which equals `memberCount`. There is no PUSD close branch that burns the state/receipt NFTs or returns their BCH carriers.

After this final payout:
- another payout is rejected because `round < memberCount` is no longer true;
- cancellation is rejected because it only accepts round 0 with `hasPaid == 0`;
- escrow `attest()` is rejected because it requires `round < memberCount`;
- escrow `cancel()` is rejected because it only accepts round 0.

Consequently, the state, receipt and escrow UTXOs remain locked with their BCH carrier value. If a receipt/escrow pair ever reaches the final round with credit above one contribution, the remaining PUSD is also left in an escrow that can no longer be spent. Normal deposit flow caps credit at one contribution, but the final-round path itself does not enforce an upper bound on each input credit.

**Suggested fix**

Add an explicit final-closing branch to both PUSD covenants and the PUSD transaction planner. Require every member's remaining credit to equal exactly one contribution, pay the final recipient and treasury exactly, burn the state/receipt NFTs, and return all state/receipt/escrow BCH backing to the specified owners. Add tests proving no PUSD or BCH carrier remains locked after completion. If a terminal close is intentionally deferred, do not describe the PUSD path as fully settled; add a separately authorized and safe post-completion recovery path.

### 2. [medium] PUSD payouts are permanently dependent on the initiator's fee wallet

**Location**
- `contracts/AjoCirclePUSDV3Mainnet.cash:227-254`

**Scenario**

The PUSD payout covenant fixes the fee input to `new LockingBytecodeP2PKH(initiator)` and also fixes fee change to the initiator. This means no other member or outside caller can sponsor the BCH miner fee. If the initiator loses access to the wallet, is unavailable, or refuses to sign, every subsequent PUSD payout is blocked even when all member credits are funded and the payout is otherwise valid.

This differs from the BCH V3 payout path, which permits a separate caller fee input and returns its change to that caller.

**Suggested fix**

Allow a token-free P2PKH fee input from the connected caller, and require the fee-change output to return to that exact input's locking bytecode. Keep the initiator-only restriction for cancellation if that is the intended governance rule. Add liveness tests where a non-initiator member sponsors each PUSD payout.

### 3. [medium] BCH Mainnet verifier rejects the V3 final-closing transaction layout

**Location**
- `contracts/AjoCircleV3AutoReserve.cash:132-187`
- `server/mainnet-api.mjs:1768-1804`

**Scenario**

The current BCH V3 covenant has a final-closing branch with exactly four outputs: treasury, final recipient, initiator backing refund, and fee-payer change. It burns the state and receipt NFTs.

The Mainnet verifier still requires `memberCount + 4` outputs and requires outputs 0 through `memberCount` to be contract token outputs. Therefore a valid final-closing transaction built to satisfy the current covenant is rejected by `verifyBchMainnetCircleTransaction()`. This prevents the final payout from passing the Mainnet verification endpoint even though the covenant accepts the closing layout.

**Suggested fix**

Make the verifier branch on the decoded state round. For non-final rounds, retain the existing state/receipt output checks. For the final round, require exactly four outputs, verify the exact treasury fee and final-recipient amount, verify the initiator backing refund, verify fee-payer change, and assert that no state-category token output remains. Add a signed-transaction test for both the non-final and final layouts. Keep all Mainnet broadcast/spending gates disabled until the full review is complete.

## Checks inspected and no issue identified in the reviewed paths

- **BCH V3 normal payout recipient and fee routing:** the covenant derives the recipient from the state round and checks the exact treasury and recipient locking bytecodes and values (`contracts/AjoCircleV3AutoReserve.cash:197-221`).
- **BCH V3 normal payout credit transitions:** the covenant requires every receipt to contain at least one contribution, updates each receipt deterministically, and preserves receipt BCH backing (`contracts/AjoCircleV3AutoReserve.cash:138-175`).
- **BCH V3 final payout accounting:** the closing branch requires every receipt credit to equal one contribution and returns the state/receipt BCH backing to the initiator (`contracts/AjoCircleV3AutoReserve.cash:158-187`). The separate Mainnet verifier mismatch is reported above.
- **BCH V3 cancellation:** cancellation requires round 0, an initiator signature, all ordered receipts, and exact member refund outputs (`contracts/AjoCircleV3AutoReserve.cash:223-287`).
- **PUSD deposit token accounting:** the circle covenant checks the member receipt, escrow category/amount, member funding address, updated escrow amount, and token change (`contracts/AjoCirclePUSDV3Mainnet.cash:48-138`). The escrow sidecar independently checks the selected member's receipt/escrow relationship (`contracts/AjoPUSDMemberEscrowV3.cash:15-107`).
- **PUSD cancellation authorization and refund routing:** the circle path only permits the unpaid round-zero state and requires the initiator's fee input; each member's refund is bound to their registered address and exact escrow/receipt BCH backing (`contracts/AjoCirclePUSDV3Mainnet.cash:262-324`; `contracts/AjoPUSDMemberEscrowV3.cash:110-146`).
- **Wallet transaction-intent comparison:** `verifySignedTransaction()` compares transaction version, locktime, input count, each input outpoint/index/sequence, and the exact serialized outputs before VM verification (`src/core/wizard-wallet.ts:392-438`).
- **Wallet sighash checks:** the wallet verifier checks the required `0x61` sighash for listed P2PKH and covenant-wallet inputs and checks that every P2PKH funding input is included in the signing request (`src/core/wizard-wallet.ts:297-370`; `src/core/wizard-wallet.ts:412-438`).
- **BCH discovery source:** the inspected Chipnet discovery reader obtains wallet script history from Electrum, fetches the raw transaction, verifies the requested txid against the downloaded bytes, and derives circle parameters from the genesis transaction rather than trusting a database record (`src/core/v2-fee-discovery.ts:92-157`).

## Validation limitations

- The audit was source inspection of the GitHub `main` branch; it was not a formal CashTokens covenant proof or independent cryptographic audit.
- `npm install`, `npm run typecheck`, and `npm test` were **not run**. An attempted repository clone failed because the execution environment could not resolve `github.com`. No test-pass claim is made.
- No Chipnet or Mainnet transaction was created, signed, or broadcast.
- No code was modified. The Mainnet locks `MAINNET_BROADCAST_ENABLED`, `BCH_MAINNET_OPERATIONS_ENABLED`, and `PUSD_MAINNET_SPENDING_ENABLED` were not changed or enabled.
