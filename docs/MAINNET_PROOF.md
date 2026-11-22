# AjoChain BLAZE: Mainnet proof ledger

Public Bitcoin Cash Mainnet transactions made with AjoChain BLAZE. Anyone can check them.

> **Verification status:** every row below was re-checked on Nov 22, 2026 against the public Fulcrum server `fulcrum.greyh.at`: raw transaction fetched, outputs decoded and confirmed block height matched.

## 1. A complete 2-member circle (Nov 21, 2026)

A real circle run from creation to final payout on Mainnet. Both members signed every step in their own Selene wallet.

- **Circle contract (covenant):** `bitcoincash:pwczq0uttxcglv59mkgugqhtew4v3zd3rsvulcs4eqjktl8lf9u47h4j2wz4a`
- **Circle token category:** `a9a3bca6406c0c7abacc272f70b78ccca924ca69df9629652d7345bd5647696c`
- **Contract type:** V3 automatic reserve, Mainnet
- **Members:** member 1 `bitcoincash:qq894rlymhkuulckrk46hy745tyuyjmtpgf0alckkm` (creator); member 2 `bitcoincash:qp7zcd6jr5rmrjdayfecy2ypywsu8tqnfqxcred43h`
- **Rules:** 200,000 sats (0.002 BCH) per member per round, 2 rounds, 1% project fee per payout (max 10,000 sats) to treasury `bitcoincash:qqtu3577x0swy2gsra6km3033xcj8swg8sjfvntgpn`
- **Result:** member 1 received 0.00196 BCH in round 1, member 2 received 0.00396 BCH in round 2, and the contract ended with 0 sats.

| Date UTC | Block | What it does | Txid |
|---|---:|---|---|
| 2026-11-21 20:59 | 978372 | Prepared the circle token category `a9a3bca6…` (0.004 BCH output to member 1) | [`a9a3bca6406c0c7abacc272f70b78ccca924ca69df9629652d7345bd5647696c`](https://blockchair.com/bitcoin-cash/transaction/a9a3bca6406c0c7abacc272f70b78ccca924ca69df9629652d7345bd5647696c) |
| 2026-11-21 21:55 | 978376 | Circle creation (genesis). Outputs: 0 = minting state NFT to the covenant; 1-2 = member receipt NFTs; 3-4 = 546-sat discovery markers to each member; 5 = OP_RETURN note; 6 = change | [`a36b90a9817f1f63105eaa9fc7b1e30ccecba2409a4c8de4a9441fad566b5a80`](https://blockchair.com/bitcoin-cash/transaction/a36b90a9817f1f63105eaa9fc7b1e30ccecba2409a4c8de4a9441fad566b5a80) |
| 2026-11-21 22:41 | 978382 | Round 1: member 1 deposit, 200,000 sats (covenant now holds 201,000 sats) | [`cffa514eaf4dff86d487e1fbdff190286fa58a1c1b103cbb49ac28dea19e9543`](https://blockchair.com/bitcoin-cash/transaction/cffa514eaf4dff86d487e1fbdff190286fa58a1c1b103cbb49ac28dea19e9543) |
| 2026-11-21 22:41 | 978382 | Member 2 gathered wallet coins into one coin before depositing (wallet-only transaction) | [`210a9131e29d52e4c77d8a6680b9a12cda168d81de76d7617927c3fd1da2c92a`](https://blockchair.com/bitcoin-cash/transaction/210a9131e29d52e4c77d8a6680b9a12cda168d81de76d7617927c3fd1da2c92a) |
| 2026-11-21 22:47 | 978384 | Round 1: member 2 deposit, 200,000 sats (covenant now holds 401,000 sats) | [`96a622416a45788963f3b135f59bce1d567c64a2abe3e2762d1f532eb00f833a`](https://blockchair.com/bitcoin-cash/transaction/96a622416a45788963f3b135f59bce1d567c64a2abe3e2762d1f532eb00f833a) |
| 2026-11-21 22:53 | 978385 | Round 1 payout: 196,000 sats to member 1, 4,000 sats project fee to treasury, 201,000 sats kept as next-round reserve | [`fd8434304adb4d93c83c6079dc57be811a3b0e11b8358a5d61310c01aec60594`](https://blockchair.com/bitcoin-cash/transaction/fd8434304adb4d93c83c6079dc57be811a3b0e11b8358a5d61310c01aec60594) |
| 2026-11-21 23:01 | 978386 | Round 2: member 2 deposit, 200,000 sats (covenant now holds 401,000 sats) | [`d1c4fa8488d9cc63ede2d745568dc3b54cdb817dea36ff9e2b517654225b4d1c`](https://blockchair.com/bitcoin-cash/transaction/d1c4fa8488d9cc63ede2d745568dc3b54cdb817dea36ff9e2b517654225b4d1c) |
| 2026-11-21 23:21 | 978387 | Final payout: 396,000 sats to member 2, 4,000 sats project fee to treasury, 3,000 sats token dust returned to member 1. Covenant emptied; circle complete | [`dfc24ec6bc58ac04c9dbfa9dd6fed6ebfbd1ecb5c38ad39ad016a7fcba1d34df`](https://blockchair.com/bitcoin-cash/transaction/dfc24ec6bc58ac04c9dbfa9dd6fed6ebfbd1ecb5c38ad39ad016a7fcba1d34df) |

## 2. Earlier Mainnet transactions

| Date UTC | Block | What it does | Txid |
|---|---:|---|---|
| 2026-11-20 11:31 | 978163 | Gather-coins wallet transaction signed in Selene via WizardConnect | [`d38a82145869f6717bfbf508bd2d3fe52d2ae040a9feb87c56665ed57ca0abac`](https://blockchair.com/bitcoin-cash/transaction/d38a82145869f6717bfbf508bd2d3fe52d2ae040a9feb87c56665ed57ca0abac) |
| 2026-11-20 13:56 | 978174 | Prepared the circle token category (state category `34f2dbff…`) | [`34f2dbff25ebc94102734208c00c0ee8226d5fe8d6418768ab86ef5e31afcf0a`](https://blockchair.com/bitcoin-cash/transaction/34f2dbff25ebc94102734208c00c0ee8226d5fe8d6418768ab86ef5e31afcf0a) |
| 2026-11-20 14:15 | 978176 | First Mainnet circle creation (genesis): 7 outputs, same layout as above | [`48a5840dbe7c5c41525406461e32b31998393411ca793f4dd19131b0369f7473`](https://blockchair.com/bitcoin-cash/transaction/48a5840dbe7c5c41525406461e32b31998393411ca793f4dd19131b0369f7473) |
| 2026-11-20 14:34 | 978178 | Follow-up wallet transaction from the creator address | [`1d354028b2f175f2b3a25817f43624a29d2a625e4bf5ecc07cbf5c3ddd907e36`](https://blockchair.com/bitcoin-cash/transaction/1d354028b2f175f2b3a25817f43624a29d2a625e4bf5ecc07cbf5c3ddd907e36) |
| 2026-11-21 20:13 | 978368 | Circle creation for circle `0301770b…` (later cancelled before any deposit; shown under Completed) | [`0301770baf093a3ddb1da6e5f902f03c85d9b114882e0f7a0414766f72cba1e5`](https://blockchair.com/bitcoin-cash/transaction/0301770baf093a3ddb1da6e5f902f03c85d9b114882e0f7a0414766f72cba1e5) |

The first circle's covenant address is `p0chq232z0p58nqazzmltt7yw52te48gm5sqj74gn3e3yma7g44tu7k3rz880`.

## How to check a row yourself

Use any public BCH Mainnet Fulcrum server over TLS:

1. Request the raw transaction with the Electrum method `blockchain.transaction.get`.
2. Recompute the transaction id from the raw bytes and make sure it matches.
3. Check its confirmed block height.
4. Decode every input and output: amounts, addresses, token categories, NFT commitments and the OP_RETURN note.

Only real, confirmed transactions are listed here. Never add an estimated or invented txid.

> Mainnet uses real BCH. The circle contract hasn't had an independent audit yet. Start with small amounts.
