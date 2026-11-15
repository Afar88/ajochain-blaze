# CashTokens provider integration requirements

Status: **integration contract only**. No provider endpoint is configured and no live balance or spendable UTXO is asserted.

## Required provider capabilities

A production provider adapter must supply, for a requested mainnet address and canonical PUSD category:

- The network identity (must be Bitcoin Cash mainnet), canonical category ID, address queried, and a server-reported chain tip/block height.
- Every candidate UTXO's transaction ID, output index, satoshi value, CashToken category, fungible amount, NFT capability/commitment if present, locking bytecode, and confirmation metadata.
- A way to verify that each outpoint is still unspent immediately before transaction construction/signing, not merely present in a stale address history response.
- Pagination metadata and deterministic continuation; incomplete pagination must never be treated as a complete balance.
- Explicit provider error, timeout, rate-limit, and stale-tip behavior.

## Fail-closed policy

Reject the entire response if the provider reports the wrong network/category/address, malformed values, duplicate outpoints, missing pages, inconsistent tip heights, stale data beyond the configured policy, or an outpoint whose unspent status cannot be established. Never silently fall back to Chipnet, another token category, or a second provider with different semantics.

A provider response is evidence for candidate UTXOs, not proof of wallet ownership or a valid transaction. Independently verify each referenced previous transaction/output and its CashTokens serialization before using it as a transaction input.

## Adapter boundary

Keep provider-specific HTTP/GraphQL schemas outside core transaction logic. Normalize responses into a strict internal model only after runtime schema validation. Core code should receive normalized values and explicit provenance metadata; it should not parse arbitrary provider JSON.

Suggested internal metadata:
- provider identifier and API/schema version
- network and category
- queried address
- chain tip height/hash and observation timestamp
- pagination completion flag
- per-outpoint confirmation and unspent-check status

## Acceptance tests before enabling balance display

1. Valid complete mainnet response produces normalized candidate UTXOs.
2. Wrong network, category, or address is rejected.
3. Missing/duplicate pages and duplicate outpoints are rejected.
4. Stale tip, provider timeout, rate limiting, and malformed numeric fields fail closed.
5. Spent outpoint and mismatched previous-output data are rejected.
6. Empty results are distinguishable from provider failure and incomplete pagination.

## Current application behavior

The UI must continue to show **Not yet verified** for PUSD balance until a provider is selected, integrated, tested against mainnet data, and its freshness/unspent policy is independently reviewed. This document does not authorize signing, broadcasting, or real-value circle operations.
