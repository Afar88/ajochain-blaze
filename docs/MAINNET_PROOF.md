# AjoChain BLAZE — Mainnet proof ledger

This page records public Bitcoin Cash Mainnet transactions that can be independently checked. The verified rows below have been checked against their transaction data and confirmed block inclusion.

> **Verification status:** Verified Nov 20, 2026 against Blockchair and a public Fulcrum server.

## Verified transactions

| Date UTC | Block | What it does | Txid with explorer link |
|---|---:|---|---|
| 2026-11-20 11:31:36 | 978163 | Gather-coins wallet transaction signed in Selene via WizardConnect | [`d38a82145869f6717bfbf508bd2d3fe52d2ae040a9feb87c56665ed57ca0abac`](https://blockchair.com/bitcoin-cash/transaction/d38a82145869f6717bfbf508bd2d3fe52d2ae040a9feb87c56665ed57ca0abac) |
| 2026-11-20 13:56:16 | 978174 | Wallet transaction that prepared the circle's token category (state category `34f2dbff…`) | [`34f2dbff25ebc94102734208c00c0ee8226d5fe8d6418768ab86ef5e31afcf0a`](https://blockchair.com/bitcoin-cash/transaction/34f2dbff25ebc94102734208c00c0ee8226d5fe8d6418768ab86ef5e31afcf0a) |
| 2026-11-20 14:15:13 | 978176 | Circle creation (genesis): 7 outputs — 0 = minting state NFT to the covenant; 1–2 = member receipt NFTs; 3–4 = 546-sat discovery markers; 5 = OP_RETURN note; 6 = change | [`48a5840dbe7c5c41525406461e32b31998393411ca793f4dd19131b0369f7473`](https://blockchair.com/bitcoin-cash/transaction/48a5840dbe7c5c41525406461e32b31998393411ca793f4dd19131b0369f7473) |
| 2026-11-20 14:34:55 | 978178 | Follow-up wallet transaction from the creator address | [`1d354028b2f175f2b3a25817f43624a29d2a625e4bf5ecc07cbf5c3ddd907e36`](https://blockchair.com/bitcoin-cash/transaction/1d354028b2f175f2b3a25817f43624a29d2a625e4bf5ecc07cbf5c3ddd907e36) |
| — | — | Member deposit — awaiting a confirmed transaction | — |
| — | — | Payout — awaiting a confirmed transaction | — |

## Circle covenant

The BCH Mainnet covenant address is:

`p0chq232z0p58nqazzmltt7yw52te48gm5sqj74gn3e3yma7g44tu7k3rz880`

The state category associated with the category-preparation transaction begins `34f2dbff…`. The genesis transaction's seven-output layout is listed in the verified-transactions table above.

## How to complete verification

For each candidate, use a reachable, public BCH Mainnet Fulcrum server over TLS:

1. Request the raw transaction using the Electrum `blockchain.transaction.get` method.
2. Recompute the transaction id from the returned raw bytes and make sure it matches the candidate txid.
3. Check confirmed inclusion and the block height with the same server's transaction status/confirmation data.
4. Decode every input and output. For genesis, verify output indices, token categories/NFT commitments, amounts, addresses, and the OP_RETURN note—not just the output count.
5. Record the exact UTC timestamp and block height only after all checks match. If the returned txid, output layout, category or block inclusion differs, leave the row out and document the mismatch in the pull request.

Add the member-deposit and payout rows only when those transactions actually happen and their txids can be independently verified. Never fill in an estimated or invented txid.
