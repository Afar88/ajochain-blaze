# CashTokens provider integration requirements

Status: **partial core implementation**. Raw previous-output authentication now exists in `src/core/pusd-utxo-auth.ts` with fixture tests. No production provider endpoint or trusted unspent-state adapter is configured, so no live balance or spendable UTXO is asserted.

## Required provider capabilities

A production provider adapter must supply, for a requested mainnet address and canonical PUSD category:

- The network identity (must be Bitcoin Cash mainnet), canonical category ID, address queried, and a server-reported chain tip/block height.
- Every candidate UTXO's transaction ID, output index, satoshi value, CashToken category, fungible amount, NFT capability/commitment if present, locking bytecode, and confirmation metadata.
- Raw previous transaction bytes for every candidate outpoint. Core code must independently hash and decode these bytes and compare the exact output index, value, locking bytecode and CashToken fields.
- A way to establish that each outpoint remains unspent immediately before transaction construction/signing, not merely present in stale address history.
- Pagination metadata and deterministic continuation; incomplete pagination must never be treated as a complete balance.
- Explicit provider error, timeout, rate-limit, reorg, and stale-tip behavior.

## Implemented core boundary

`authenticatePusdUtxo` in `src/core/pusd-utxo-auth.ts`:

- Decodes the exact raw previous transaction with Libauth's CashTokens-aware BCH decoder.
- Recomputes the displayed TXID from the raw bytes and compares it with the requested outpoint.
- Verifies that the output index exists.
- Compares the output locking bytecode with the expected wallet-derived script supplied by the caller.
- Extracts the BCH value and PUSD category/amount from the decoded output; rejects missing PUSD, other categories and NFTs.
- Requires a separate asynchronous unspent-state check and fails closed if it returns false or errors.

The function deliberately does **not** claim that an indexer is trustworthy, that an unspent check is consensus-authenticated, or that a caller-provided locking bytecode belongs to the connected wallet. Those are responsibilities of the provider/chain-state adapter and wallet derivation boundary, and are not yet integrated into the app.

## Unspent-state trust model

A raw previous transaction and its TXID prove the contents of the referenced output; they do not prove that the output is currently unspent. A Merkle inclusion proof proves transaction inclusion, not UTXO status. The future adapter must document whether it relies on a self-operated BCH full node, a trusted third-party indexer, or another independently verifiable state mechanism. Until that choice is implemented and reviewed, balance and spend selection must remain disabled/unverified.

## Fail-closed policy

Reject the entire response if the provider reports the wrong network/category/address, malformed values, duplicate outpoints, missing pages, inconsistent tip heights, stale data beyond policy, or an outpoint whose unspent status cannot be established. Never silently fall back to Chipnet, another token category, or a second provider with different semantics.

Keep provider-specific HTTP/GraphQL schemas outside core transaction logic. Normalize responses only after runtime schema validation. Do not treat normalized provider JSON as proof of previous-output contents or unspent status.

## Acceptance tests before enabling balance display

1. Valid complete mainnet response produces normalized candidate UTXOs.
2. Wrong network, category, or address is rejected.
3. Missing/duplicate pages and duplicate outpoints are rejected.
4. Stale tip, provider timeout, rate limiting, reorg and malformed numeric fields fail closed.
5. Raw previous-transaction TXID mismatch, missing vout, wrong locking bytecode, wrong category, NFT and non-PUSD outputs are rejected.
6. Spent outpoint and unavailable unspent-state service fail closed.
7. Empty results are distinguishable from provider failure and incomplete pagination.

## Current application behavior

The UI must continue to show **Not yet verified** for PUSD balance until a provider is selected, integrated, tested against mainnet data, and its freshness/unspent policy is independently reviewed. This document does not authorize signing, broadcasting, or real-value circle operations.
