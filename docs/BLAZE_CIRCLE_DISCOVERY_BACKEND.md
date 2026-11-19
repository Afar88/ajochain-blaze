# BLAZE on-chain circle discovery

## Source of truth

Bitcoin Cash is the source of truth for circle identity, membership, covenant state, receipts, escrow outputs and confirmed payments. BLAZE does not use a central circle database or registry to discover circles.

## On-chain discovery for new Chipnet circles

New `fee-v3-auto-reserve-closing` circles are discoverable without a server, database or login. Their genesis transaction adds, after the receipt NFTs, one 546-sat P2PKH marker output per member (in member order) and an `OP_RETURN "AJOD"` note holding the version, covenant code, member count, contribution, maxFee, initiator PKH and treasury locking bytecode (`src/core/v2-fee-discovery-note.ts`).

When a wallet connects, the browser checks Chipnet circle history even if the app is currently displaying the Mainnet workspace. Discovery derives the wallet's public receive and change addresses and performs read-only history lookups through Electrum. It checks the connected wallet's receive (0–50) and change (0–20) addresses, ranks confirmed candidate transactions across those addresses, and verifies up to the newest 300 (`src/core/v2-fee-discovery.ts`). It ignores mempool-only entries and checks that each downloaded raw transaction hashes to the history TXID.

A circle is accepted only if:

- input 0 spends output 0 of the transaction whose txid is the token category;
- output 0 is the 1,000-sat fresh minting state and outputs 1..N are the 1,000-sat zero-credit receipts;
- the rebuilt parameters derive the exact covenant script holding all of them;
- one of the markers pays an address of the connected wallet;
- markers are ordered exactly as the member receipt indices, and marker 0 matches the initiator PKH in the note.

## Mainnet discovery

BCH Mainnet circle discovery also reads on-chain transactions and wallet history. Circle identity and lifecycle are reconstructed from transaction IDs, token categories, covenant scripts, state/receipt outputs and confirmed transaction history. A server-side registry is not the source of truth and must not be introduced as a requirement.

## Role of Electrum and optional API routes

Electrum endpoints are chain-data providers. They are not the AjoChain backend, a database, or a registry. A provider quorum can improve consistency checks, but endpoint names alone do not prove independent operator ownership or local SPV/chainwork validity.

Optional Vercel/API routes may support operations such as fee estimates, raw-transaction verification or PUSD signed-transaction preflight. Those routes must not own circle state, become a registry, or be required for browser-side chain discovery. They must never replace direct chain verification with cached database records.

## Explicitly not part of BLAZE discovery

- No Neon or Postgres circle database.
- No Upstash/Redis dependency for circle lookup.
- No server registration, invite indexing, or central circle backfill.
- No requirement to upload wallet xpubs or private wallet material.

Existing invite links may be used as a convenience for restoring a known circle, but a link is not proof of membership or payment. The app must validate the referenced circle and its state against the blockchain.

This document describes discovery architecture only. It does not enable Mainnet spending or approve any contract for real-value use.
