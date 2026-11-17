# BCH, PUSD and Member Accounting

## Current BCH V3 automatic-reserve fee circles

The new-circle creation flow selects the guarded successor `fee-v3-auto-reserve-guarded`, compiled from `AjoCircleV3AutoReserve.cash`. Existing saved circles using `fee-v1`, `fee-v2-escrow` or `fee-v3-auto-reserve` continue to resolve to preserved original CashScript sources and separately compiled `.legacy.json` artifacts. Guarded successors use distinct covenant identifiers and derived addresses; they do not silently replace an already-created circle's locking bytecode. The existing transaction-execution workspace remains Chipnet-only and requires 2–5 unique BCH member addresses and a minimum contribution of **0.002 BCH per member per round**. A separate `fee-v3-auto-reserve-mainnet` adapter now validates Mainnet drafts and can prepare an unsigned genesis preview with the shared Mainnet treasury; it is not a deployed or spend-enabled Mainnet circle. The covenant carries one state NFT and one member receipt NFT per member. Each receipt holds that member's own credit. Existing Classic V1, legacy fee-v1, V2 full-escrow and already-created V3 circles remain on their original versioned covenant; they are not upgraded or reinterpreted.

For each scheduled round, every member must have one contribution available in their own receipt. When a non-final recipient receives the pot, exactly one next-round contribution is withheld from that payout and credited to that recipient's own receipt. It is consumed at the following payout. The reserve does not cover any later installments; after it is consumed, the member must contribute again. The final recipient has no future installment reserve.

### Fee rules

- The project fee is **1% of the gross round pot**, calculated with integer floor division.
- The destination is committed as a fixed constructor argument at circle creation. It cannot be changed for that circle later.
- The project fee is a separate output, not a miner-fee reserve.
- Miner fees are separately bounded by the circle's maximum miner-fee value.
- The covenant rejects dust-sized fee and recipient outputs.
- The UI shows the treasury address and estimated fee split before it asks the wallet to sign.

The current Chipnet treasury value in the form is a provisional project configuration. Members must inspect the immutable treasury in the circle details before sharing or funding an invite. Do not reuse the Chipnet address on Mainnet.

### Member-paid versus payout-funded reserve

The on-chain receipt balance includes both member deposits and the one automatic reserve withheld from a non-final recipient's payout. The member ledger's **Paid directly** figure excludes that payout-funded reserve, including after it is consumed in the following round. **Locked now** reports the actual receipt credit, and **Still due** reports the remaining cycle commitment after completed rounds and current receipt credit. The reserve is not counted as a member deposit.

### Payout and member fairness

Payout requires every member receipt to hold at least one full contribution. The covenant atomically:

1. Consumes the state NFT and all member receipt NFTs in fixed member order.
2. Subtracts exactly one contribution from **every** receipt.
3. Advances the payout round and permanently records that the first payout occurred.
4. Pays the 1% project fee to the committed treasury.
5. Pays the scheduled recipient the remainder, subject to the separate miner-fee cap.

The recipient's receipt is debited exactly like every other member's receipt. Receiving the pot does not forgive, prepay or remove that member's next-round obligation. Extra credit remains attached to that same member and cannot cover another member's shortfall.

### Cancellation

Before the first payout, the initiator may invoke the covenant cancellation path. It refunds each member's own recorded receipt credit and the BCH backing attached to that receipt, with a bounded miner-fee reserve. After the first payout, cancellation is permanently locked by the state NFT. This is a versioned Chipnet prototype and still needs independent contract and real-wallet review.

## Verified member ledger

`src/core/verified-member-ledger.ts` ports the old append-only accounting rules:

- A contribution receipt is keyed by network, circle, transaction ID and output index.
- A receipt must point to a registered member and include the member's matching funding address.
- Mixed or ambiguous funding inputs are not credited to a member.
- Identical duplicate observations are idempotent; conflicting observations fail closed.
- Reversal events support reorg/invalidated-output handling; a later valid re-inclusion can be replayed.
- Summaries calculate verified paid-in, completed-round allocation, member-owned carry-forward, arrears and the current amount due.

This ledger module is **not itself a blockchain verifier**. Only a trusted transaction/UTXO verifier may emit `contribution_confirmed` events after checking the destination output, previous transactions, input owners, token category/amount, confirmation and block hash. Local storage, a copied invite, a wallet connection or a screenshot is not evidence of payment.

The selected V3 auto-reserve covenant's on-chain receipt NFTs are the enforcement source for its BCH credit and payout eligibility. The separate V2 full-escrow and fee-v1 contracts retain their own historical rules. The event ledger is an auditable accounting/indexing layer. Classic V1 remains an aggregate pool and cannot attribute pooled deposits to individual members.

## Shared Mainnet project-fee treasury

New BCH and PUSD Mainnet covenant versions use the same immutable project-fee destination: `bitcoincash:zqtu3577x0swy2gsra6km3033xcj8swg8s4rld9w7q`. For PUSD, the 1% fee is a separate fungible PUSD CashToken output to this address; for BCH, the fee output uses its matching P2PKH locking script. Miner fees and token carrier satoshis are accounted for separately. Existing Chipnet BCH prototypes keep their separate `bchtest:` treasury.

## PUSD status

The canonical ParyonUSD category is pinned to the published Mainnet category and the balance reader authenticates PUSD UTXOs using raw previous transactions and live unspent-state checks through an Electrum quorum. The same-origin API route is `/api/*`; by default the browser calls the API on the deployed AjoChain origin.

To provide PUSD read-only balance service in Vercel, configure `ELECTRUM_SERVERS` with at least two independent secure `wss://` Electrum endpoints on different hostnames. `ALLOWED_ORIGINS` may be configured for separately hosted frontends. Do not enable `ENABLE_MAINNET_BROADCAST`.

A separate Mainnet-targeted PUSD V3 covenant, member escrow sidecar, lifecycle planners, state/receipt/escrow chain reader, fee/reserve/cancellation tests and Mainnet-only workspace are now present on the feature branch. The UI can prepare unsigned genesis, deposit, payout and pre-payout cancellation previews, and display current per-member escrow credit after a read-quorum check. It does not sign or broadcast. The shared Mainnet treasury address is pinned for both BCH and PUSD; it still requires independent verification and review as part of the release. PUSD circle operations remain **disabled** until exact signed-byte verification, fresh-prevout revalidation, independent Selene/WizardConnect tests, broadcast/confirmation/reorg handling and external audit are complete. There is no authenticated PUSD Chipnet category. Do not use the Mainnet PUSD category as a Chipnet category. PUSD wallet verification is not permission to spend.

## Mainnet safety

- BCH Mainnet transaction broadcast remains disabled by `BCH_MAINNET_OPERATIONS_ENABLED = false`; the new Mainnet V3 workspace stops at an unsigned genesis preview.
- PUSD Mainnet spend/broadcast remains disabled by `PUSD_MAINNET_SPENDING_ENABLED = false` and the server's `ENABLE_MAINNET_BROADCAST` guard.
- Chipnet contract tests and a passing deployment do not constitute an independent audit or prove real-wallet end-to-end correctness.
- No real funds should be sent to the experimental V2 BCH or PUSD prototype contracts until the contracts, transaction plans, exact outputs/fees, wallet signing and recovery paths have independent review and live test evidence.
