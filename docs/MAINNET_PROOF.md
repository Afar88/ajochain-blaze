# AjoChain BLAZE — Mainnet proof ledger

This page records public Bitcoin Cash Mainnet transactions that can be independently checked. A transaction is entered in the proof table only after its raw transaction has been decoded from a public Fulcrum server, its txid has been recomputed/matched, and its confirmed block height has been checked.

> **Verification status (Nov 20, 2026):** No candidate transaction below has been promoted into the verified table in this revision. This execution environment could not establish a network connection to a public BCH Fulcrum endpoint or retrieve the raw transaction from the public explorer/API endpoints. The project-supplied details below are therefore recorded as candidates only—not as verified on-chain evidence. Do not treat the candidate list as proof.

## Verified transactions

| Date UTC | Block | What it does | Txid with explorer link |
|---|---:|---|---|
| — | — | Member deposit — awaiting a confirmed transaction and Fulcrum verification | — |
| — | — | Payout — awaiting a confirmed transaction and Fulcrum verification | — |

No genesis, category-preparation, follow-up wallet, or gather transaction is listed in the verified table yet. Their supplied descriptions and heights still need to be checked against raw transaction data from Fulcrum.

## Candidate transactions awaiting Fulcrum verification

The entries in this section were supplied for investigation. The block heights and transaction descriptions have not been independently verified from Fulcrum in this revision.

| Supplied block | Candidate description | Candidate txid |
|---:|---|---|
| 978174 | Wallet transaction said to prepare the circle's token category (state category prefix: `34f2dbff…`) | [`34f2dbff25ebc94102734208c00c0ee8226d5fe8d6418768ab86ef5e31afcf0a`](https://blockchair.com/bitcoin-cash/transaction/34f2dbff25ebc94102734208c00c0ee8226d5fe8d6418768ab86ef5e31afcf0a) |
| 978176 | Circle genesis candidate. Supplied output description: output 0 minting state NFT to the covenant; outputs 1–2 member receipt NFTs; outputs 3–4 546-sat discovery markers to each member; output 5 OP_RETURN note; output 6 change. | [`48a5840dbe7c5c41525406461e32b31998393411ca793f4dd19131b0369f7473`](https://blockchair.com/bitcoin-cash/transaction/48a5840dbe7c5c41525406461e32b31998393411ca793f4dd19131b0369f7473) |
| 978178 | Follow-up wallet transaction said to be from the creator address. It is intentionally described only as a wallet transaction; no more specific interpretation is asserted. | [`1d354028b2f175f2b3a25817f43624a29d2a625e4bf5ecc07cbf5c3ddd907e36`](https://blockchair.com/bitcoin-cash/transaction/1d354028b2f175f2b3a25817f43624a29d2a625e4bf5ecc07cbf5c3ddd907e36) |
| Pending | Gather-coins transaction said to have been signed in Selene through WizardConnect. Its block height is not filled in because it could not be checked from Fulcrum. | [`d38a82145869f6717bfbf508bd2d3fe52d2ae040a9feb87c56665ed57ca0abac`](https://blockchair.com/bitcoin-cash/transaction/d38a82145869f6717bfbf508bd2d3fe52d2ae040a9feb87c56665ed57ca0abac) |

## Circle covenant

The supplied BCH Mainnet covenant address is:

`p0chq232z0p58nqazzmltt7yw52te48gm5sqj74gn3e3yma7g44tu7k3rz880`

The state category associated with the supplied category-preparation transaction is reported as beginning `34f2dbff…`. Both the address/category relationship and the genesis output layout must be checked against the decoded transaction before the candidate is promoted into the verified table.

## How to complete verification

For each candidate, use a reachable, public BCH Mainnet Fulcrum server over TLS:

1. Request the raw transaction using the Electrum `blockchain.transaction.get` method.
2. Recompute the transaction id from the returned raw bytes and make sure it matches the candidate txid.
3. Check confirmed inclusion and the block height with the same server's transaction status/confirmation data.
4. Decode every input and output. For genesis, verify output indices, token categories/NFT commitments, amounts, addresses, and the OP_RETURN note—not just the output count.
5. Record the exact UTC timestamp and block height only after all checks match. If the returned txid, output layout, category or block inclusion differs, leave the row out and document the mismatch in the pull request.

Add the member-deposit and payout rows only when those transactions actually happen and their txids can be independently verified. Never fill in an estimated or invented txid.

