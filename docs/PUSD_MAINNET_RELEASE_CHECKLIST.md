# PUSD mainnet release checklist

Status: **BLOCKED — PUSD mainnet spending is deliberately disabled.**

This checklist is a release gate, not a claim that the controls below exist.
A green UI, a successful unit test, or a provider's decoded JSON response is
not proof that a CashTokens transaction is safe.

## Mandatory independent evidence

- [ ] **Canonical asset identity:** independently verify ParyonUSD's issuer-published mainnet category ID, decimals, issuer and token policy. Never infer a Chipnet category from the mainnet ID.
- [ ] **Provider and chain identity:** select a documented BCH mainnet provider; validate its API schema, authentication, rate limits, pagination, tip freshness and outage behavior.
- [ ] **UTXO provenance:** retrieve each referenced previous transaction, independently decode its raw bytes, verify txid/vout, BCH value, locking bytecode and CashTokens prefix/category/amount/NFT fields. Confirm each outpoint remains unspent immediately before signing. A provider's summary fields are not sufficient.
- [ ] **Wallet ownership:** bind each input's locking bytecode to the connected wallet's locally derived address/script and verified derivation path. A matching address string supplied by a provider is not sufficient.
- [ ] **Raw transaction decoder:** decode the exact unsigned and signed transaction bytes with a reviewed BCH/CashTokens-aware implementation. Reject malformed/trailing bytes, unknown token prefixes, unexpected categories, NFTs, duplicate inputs and unsupported script types.
- [ ] **Transaction construction:** explicitly account for PUSD inputs/outputs, token change, BCH carrier values, BCH-only inputs/change, dust constraints and miner fee. Verify conservation and exact recipient/change scripts from decoded bytes, not caller-supplied summaries.
- [ ] **Signing integrity:** compare exact signed transaction intent against the approved plan: version, locktime, every outpoint and sequence, every output value/script/token prefix, and permitted unlocking-script changes. Independently validate signatures and all relevant BCH consensus/script rules.
- [ ] **Replay and state safety:** prevent stale-plan signing, double submission, duplicate contribution claims and re-use of already-spent inputs. Recheck UTXOs and relevant circle state immediately before signing.
- [ ] **Contract/covenant review:** audit BCH-only circle contracts separately from PUSD transfer logic. Specify and test CashTokens/NFT state transitions before supporting tokenized circle receipts or covenant-controlled PUSD.
- [ ] **Adversarial test suite:** include malformed raw transactions, forged provider data, wrong prevouts, stale/spent UTXOs, category/NFT mutations, token inflation/burning, recipient substitution, BCH siphoning, fee manipulation, dust edge cases, wallet response mutation, replay and chain reorg scenarios.
- [ ] **Independent review:** obtain an external security review of the provider adapter, raw transaction parser, transaction planner, wallet signing boundary and contracts. Resolve all critical/high findings.
- [ ] **Operational controls:** documented incident response, provider failover policy (fail closed), monitoring, rate limiting, release rollback and user-facing transaction receipts.
- [ ] **Release approval:** every gate has inspectable evidence, tests pass on the exact release commit, and a reviewer explicitly approves the release.

## Current code limitations

- `src/core/pusd-provider-guard.ts` validates normalized provider snapshots only. It does **not** authenticate the provider, prove prevout contents, establish wallet ownership, or independently prove unspent status.
- `src/core/pusd-transfer-verifier.ts` verifies a decoded summary supplied by another component. It does **not** parse raw transaction bytes, verify prevout provenance, or validate signatures.
- `verifySignedTransaction` in `src/core/wizard-wallet.ts` uses the BCH transaction decoder and compares serialized outputs, but this has not been established as a complete CashTokens-aware raw-byte and signature verifier.
- No production PUSD indexer/provider adapter is configured.
- The existing circle contract is BCH-only. It must not be treated as a PUSD covenant.

## Release control

`src/core/pusd-mainnet-guard.ts` is a compile-time hard kill-switch. PUSD mainnet spending must remain disabled until this checklist is complete and independently reviewed. Do not replace the constant with a local-storage, browser, or user-controlled setting. Do not enable signing or broadcasting merely to make a demo appear complete.
