# AjoChain Blaze Mainnet external review brief

**Prepared:** 2026-11-17  
**Release status:** NOT APPROVED for real-value Mainnet activity  
**Working review target:** current `main` commit containing merged [PR #59](https://github.com/Afar88/ajochain-blaze/pull/59); reviewer must record the exact immutable commit SHA and artifact fingerprints at review start.

This brief is an audit handoff, not an audit report or approval. The reviewer must record and review an immutable Git commit SHA and the exact compiled artifacts supplied for that SHA. Do not audit a moving branch name and do not infer that CI success is security approval.

## Review scope

Review the complete transaction path, not only individual contract functions:

1. **BCH V3 automatic reserve covenant**
   - `contracts/AjoCircleV3AutoReserve.cash` and its compiled artifact.
   - Constructor bindings, state/receipt commitments, round progression, member-specific credit, reserve thresholds, 1% fee, terminal state, cancellation policy, dust and integer bounds.
   - Every payout position, including the final recipient and all remaining-round reserve cases.

2. **PUSD V3 Mainnet circle and member escrow**
   - `contracts/AjoCirclePUSDV3Mainnet.cash` and `contracts/AjoPUSDMemberEscrowV3.cash`, plus the compiled JSON artifacts.
   - Exact artifact hashes, ABI/constructor argument bindings, state NFT, receipt NFTs, escrow sidecars, PUSD category, token carrier amounts and shared treasury.
   - Deposit caps, excess-token change, carry-forward credit, payout ordering, fee rounding, final-recipient reserve, cancellation/refund, replay/reorg behavior, malformed/missing/duplicate UTXOs and integer/dust boundaries.
   - Genesis transaction output inspection: prove every state, receipt and empty escrow output is created at the intended index and script.

3. **Wallet signing and signed-byte verification**
   - `src/core/wizard-wallet.ts`, including `buildWizardSignRequest`, `verifySignedTransaction`, wallet input coverage, required `0x61` P2PKH sighash and BCH 2026 VM validation.
   - Review receive/change derivation, wallet session/network identity, input prevout provenance and exact semantic equality between planned and signed transaction.
   - Review the Mainnet BCH V3 circle workspace and the read-only server verifier added in PR #59. Signed genesis, deposit, payout and cancellation plans can be submitted for verification, but the server does not reserve, relay or broadcast them. The production submission path and all Mainnet spend controls remain disabled.

4. **Mainnet read and PUSD API path**
   - `src/core/mainnet-quorum-provider.ts`, `server/mainnet-api.mjs`, and `server/mainnet-api.node.mjs`.
   - BCH genesis and both BCH-specific fork checkpoints, tip freshness/agreement, UTXO snapshot agreement, raw previous-transaction authentication, address/script binding, token category/NFT policy, carrier dust and immediate pre-broadcast unspent checks.
   - The PUSD relay implementation is present behind the hard-coded false Mainnet broadcast gate. Its code path is designed to submit once to one provider and resolve ambiguous responses by querying the exact txid across providers; this must be reviewed and tested in an isolated environment before any release. It is not confirmation tracking.

5. **Transaction lifecycle and operations**
   - Review an idempotent durable submission design, mempool conflict and unknown-result handling, confirmation proofs, reorg reconciliation, monitoring, incident response, emergency stop and rollback.
   - Verify that configured Electrum endpoints are genuinely independently operated. Different hostnames alone are not proof of different owners or fault domains.

## Invariants to independently challenge

- BCH and PUSD Mainnet circles use the same project-fee destination:
  `bitcoincash:zqtu3577x0swy2gsra6km3033xcj8swg8s4rld9w7q`.
- PUSD category ID must match the issuer-published ID:
  `2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544`.
- PUSD display precision is currently assumed to be 2 decimals in code. This has not yet been confirmed from an issuer-controlled source; do not approve user-facing amount conversion until verified.
- PUSD member deposits cannot exceed that member's remaining contribution for the current round; excess tokens must remain with the member.
- PUSD payout charges a separate 1% PUSD project fee, reserves one next contribution for a non-final recipient, and makes no future reserve for the final recipient.
- Mainnet signing and broadcasting are compile-time disabled. No review action should enable them.

## Existing automated evidence

The branch CI runs dependency audit, TypeScript checks, unit/covenant tests, production build and a pinned BCH 2026 upstream VM vector suite. Passing those checks demonstrates software validation within the tested scope; it does not prove the contracts safe or the external wallet/network path correct.

The reviewer should independently reproduce the relevant tests and add adversarial tests for every reported finding. Any new finding should be captured with severity, exploit preconditions, impact, reproducibility, remediation and retest evidence.

## Required reviewer deliverables

- Reviewer identity, organisation and relevant BCH/CashTokens/CashScript experience.
- Immutable source commit SHA and compiled artifact hashes reviewed.
- Scope, tools, node/VM version and testing methodology.
- Findings with severity and reproduction instructions.
- Remediation status and retest evidence.
- Explicit written approval or rejection for each contract artifact and the wallet/transaction path.
- A statement of any excluded code, assumptions or limitations.

## Release gate

Do not enable Mainnet broadcasting or PUSD spending until the external review is complete, every critical/high finding is resolved, exact artifacts and constructor bindings are approved, independent-wallet lifecycle tests pass, provider operators are verified, PUSD decimals are authoritatively confirmed, and the release owner signs off on the exact deployed commit.

**Do not send real BCH or PUSD to the current prototype contracts.**
