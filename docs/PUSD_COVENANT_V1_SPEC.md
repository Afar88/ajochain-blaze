# PUSD covenant v1 — design note (not an implementation)

Status: **design-only; no PUSD covenant is implemented, compiled, deployable, or safe for funds**.

This note records a candidate architecture for future research. The BCH-only `AjoCircleV2.cash` remains the only compiled covenant. PUSD work must stay isolated until a separate implementation has complete transaction-level proofs and independent review.

## Asset identity and units

- PUSD mainnet category ID published by the issuer: `2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544`.
- The displayed category ID and the byte sequence used by CashScript introspection are not interchangeable. Verify the exact byte order with a known PUSD UTXO and a serialized transaction before passing it to a contract. Do not rely on a hand-written reversal without a test against a real transaction.
- PUSD amounts must be integers in raw CashToken base units. UI display precision is a separate concern; no floating-point arithmetic belongs in covenant or transaction validation.
- Every selected UTXO and every output must be checked against the complete token metadata: category, fungible amount, NFT capability and commitment.

## Candidate UTXO model

CashTokens outputs carry one token category each. Therefore the circle state/receipt NFTs and the PUSD pool cannot be combined into a single token-bearing output when their categories differ.

A possible model is:

| Position | Role | Token category / NFT form |
|---|---|---|
| State UTXO | Circle state | Circle category; one explicitly defined NFT capability |
| Member receipt UTXO(s) | Per-member credit | Same circle category; immutable NFTs |
| Pool UTXO | Shared PUSD reserve | PUSD category; fungible amount; no NFT |
| Member funding UTXO | Contribution source | PUSD category; fungible amount; no NFT |

**Important category rule:** CashToken category IDs are fixed 32-byte identifiers derived from genesis outpoints. They are not numeric namespaces. A category ID cannot be derived by adding `0x01`, `0x02`, or any other number. If the state and receipt NFTs are intended to share a category, they must use the exact same category ID. The state NFT's capability and every receipt NFT's capability must be checked explicitly.

## Genesis and registration must be designed first

Before contribution or payout logic can be implemented, a setup transaction design must prove all of the following:

1. A single, known genesis transaction establishes the circle NFT category.
2. Exactly one state NFT with the intended capability is created.
3. Exactly one immutable receipt NFT is created for each registered member, with a canonical member index and commitment format.
4. The minting capability is retained or destroyed according to a documented lifecycle; no unintended minting authority remains.
5. No extra NFTs, fungible tokens, or unaccounted BCH outputs can be created or diverted.
6. The resulting UTXOs and commitments can be independently reconstructed from the raw transaction.

Do not deploy a contract address or create a real circle until this setup is specified, implemented, and tested.

## Candidate state and receipt commitments

The earlier prototype proposed a state commitment `0x53 || round(1 byte)` and a receipt commitment `0x52 || memberIndex(1 byte) || credit(8 bytes)`. These are only tentative encodings. Before adoption, specify byte order, integer range, versioning, terminal state, member-count bounds, and malformed/unknown commitment behavior. Add round-trip serialization tests and reject non-canonical encodings.

## Transaction invariants to prove

### Contribution

A valid contribution transaction must prove, across **all** inputs and outputs:

- Exactly one valid state NFT and the intended member receipt are consumed and recreated.
- The state commitment does not advance during a contribution.
- The receipt credit increases by exactly the credited PUSD base-unit amount.
- The PUSD pool increases by exactly that amount.
- Any PUSD change returns to the funding member with exactly the remainder.
- No other token category, NFT capability, or NFT commitment is introduced, dropped, duplicated, or redirected.
- Every BCH input and output is accounted for; member BCH cannot silently subsidize contract carrier or miner fees.
- The fee is bounded and the change output cannot be redirected.

### Payout

A valid payout transaction must prove:

- The state, all required receipts, and the PUSD pool are the exact expected UTXOs under the covenant.
- The scheduled member is derived from validated state, not caller-controlled data.
- Each receipt is reduced by exactly one round contribution, with no negative or overflowing balance.
- The pool decreases by exactly the aggregate payout amount.
- Exactly one PUSD payout output is created, to the scheduled member, with the exact amount.
- Pool token depletion, token-free pool continuation, and terminal rotation behavior are unambiguous.
- BCH carrier values and miner fees are fully conserved and bounded.
- No extra token or NFT outputs can bypass the intended accounting.

## Required engineering and audit gates

1. Verify the PUSD category byte order against an independently sourced real mainnet UTXO and raw serialized transaction.
2. Finalize the circle NFT genesis and minting-capability lifecycle.
3. Specify canonical state/receipt encodings and validate all integer bounds.
4. Build a transaction planner and an independent raw-transaction verifier; neither may trust wallet UI summaries.
5. Validate every input and output token category, amount, NFT capability and commitment, including the CashScript empty-NFT introspection edge case.
6. Prove BCH input/output conservation, carrier values, dust constraints, and fee bounds for every spend path.
7. Add adversarial transaction-level tests: wrong category, unexpected category, unexpected NFT, extra token output, token change redirection, wrong member, wrong receipt, duplicate outpoint, partial/exact contribution, insufficient pool, depleted pool, payout substitution, fee manipulation, and malformed commitments.
8. Run tests against serialized CashTokens transactions and the intended CashScript version; compilation alone is not evidence of covenant correctness.
9. Obtain an independent security review before any real-value use.

## Current repository safety boundary

- `contracts/AjoCircleV2.cash` remains the BCH-only covenant.
- No PUSD covenant source is included in the compile or build pipeline.
- PUSD transaction signing and broadcasting remain disabled.
- The existing PUSD metadata and UTXO-selection helpers do not constitute a transaction builder, covenant, or secure transfer flow.
- This design note is not permission to deploy, lock funds, or accept PUSD contributions.

## References

- ParyonUSD issuer token ID: https://paryonusd.com/
- CashScript CashTokens introspection: https://cashscript.org/docs/design/cashtokens
- CashScript covenant introspection: https://cashscript.org/docs/design/covenants
- CashTokens specification: https://cashtokens.org/docs/spec/chip/
