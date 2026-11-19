# PUSD Mainnet spending release checklist

**Current status: READ-ONLY. PUSD Mainnet spending is not approved.**

External reviewer handoff: [`MAINNET_EXTERNAL_REVIEW_BRIEF.md`](./MAINNET_EXTERNAL_REVIEW_BRIEF.md).

This document is the release checklist referenced by `src/core/pusd-mainnet-guard.ts`. Passing unit tests or building a transfer preview does not satisfy these requirements.

## Token identity and policy

- [ ] Confirm the ParyonUSD issuer and category ID through current issuer-controlled sources.
- [ ] Verify decimals, supply/amount policy, NFT policy, allowed address types, and any issuer freeze/blacklist or recovery controls.

The issuer-maintained [ParyonUSD withdrawal contract source](https://github.com/ParyonUSD/contracts/blob/67e4b16e77aa14616bf3d5a574a1abf278f03817/contracts/stabilitypool/poolContractFunctions/WithdrawFromPool.cash) describes rounding in units of 0.01 ParyonUSD; its [ParyonUSD AddLiquidity contract source](https://github.com/ParyonUSD/contracts/blob/67e4b16e77aa14616bf3d5a574a1abf278f03817/contracts/stabilitypool/poolContractFunctions/AddLiquidity.cash) encodes a 100.00 ParyonUSD minimum as `100_00`. This is strong evidence for a two-decimal base-unit convention, but the release gate remains open until the source/artifact is matched to the deployed contracts and the issuer-controlled token metadata/policy is checked against the exact category ID.

- [ ] Record the exact token metadata snapshot and review date in the release evidence.

## UTXO discovery and authentication

- [ ] Verify at least two independently operated Electrum providers, including ownership/operator, endpoint security, and fault-domain separation.
- [ ] Verify each endpoint against BCH Mainnet chain identity and agreed tip; investigate any tip disagreement rather than silently choosing one.
- [ ] Confirm pagination completeness and bounded UTXO counts.
- [ ] Authenticate each candidate UTXO using raw previous transaction bytes, computed txid, output index, exact locking script, BCH carrier value, category and amount.
- [ ] Recheck each input's unspent status through the configured quorum immediately before broadcast.
- [ ] Reject NFT-bearing PUSD outputs until an explicit and separately audited NFT policy exists.

## Durable broadcast idempotency

- [ ] Keep PUSD submission idempotency and ambiguous-broadcast reconciliation separate from circle discovery. The durable submission ledger is only a transaction-submission safeguard; it is not a registry or source of truth for circles. No Redis service is required for chain discovery or read-only verification.
- [ ] Verify the exact signed-transaction ID/digest can be reserved only once across concurrent serverless instances and that `submitting`, `accepted`, `already-known`, and `unknown` states persist across cold starts.
- [ ] Verify that a missing/unavailable ledger or an ambiguous prior submission blocks a second relay; reconcile the exact transaction through the read-only status endpoints before manual recovery.
- [ ] Define retention, archival and incident-recovery procedures for durable submission records before enabling any PUSD broadcast.

The API contains a durable PUSD submission-ledger adapter and a read-only `GET /api/pusd/submission?txid=<64-hex-txid>` endpoint for transaction-submission reconciliation only. This is not used for circle discovery; the Mainnet broadcast kill-switch remains hard-coded false.

## Transaction construction and verification

- [ ] Independently review deterministic token selection, recipient output, PUSD change, BCH carrier/dust and fee calculation.
- [ ] Test exact category/amount conservation and reject every unrecognized token output.
- [ ] Verify all BCH-only outputs are wallet-derived change destinations.
- [ ] Decode the exact Selene-signed raw bytes; verify every outpoint, prevout, wallet script, value, token output, fee, VM result and requested recipient amount.
- [ ] Re-query all prevouts after verification and immediately before a broadcast attempt.
- [ ] Atomically reserve every input outpoint together with its transaction ID before any relay; the lock namespace is shared with future BCH Mainnet spend paths. Test different signed transactions that conflict on one or more inputs across independent serverless instances.
- [ ] Verify behavior for server disagreement, timeout, partial broadcast acceptance, unknown result, duplicate submissions, mempool conflicts and chain reorgs. Input locks currently have no TTL; define an audited manual reconciliation/release procedure before production use.

A read-only `GET /api/transaction/status?txid=<64-hex-txid>` endpoint has been added. It requires matching raw transaction bytes from every configured provider and verifies an identical transaction merkle proof against the same block header from every provider before returning `confirmed`. It returns `pending` only when all providers know the same transaction but return ordinary no-proof responses; provider disagreement or lookup/proof errors return `unknown`. Subsequent reads may downgrade status after a reorganisation. This is provider-quorum merkle verification, not local SPV/chainwork validation, durable history, or full conflict/replacement tracking. Those remaining requirements stay open.

## Wallet and operational testing

- [ ] End-to-end tests with real supported Selene/WizardConnect versions and a small controlled Mainnet transfer.
- [ ] Confirm receive and change derivation paths against the wallet UI.
- [ ] Validate on mobile browsers and after switching between AjoChain and Selene.
- [ ] Confirm the backend never receives or stores wallet secrets.
- [ ] Confirm monitoring, alerting, rate limiting, incident response, and a stop-switch procedure.

## Independent release approval

- [ ] External security review of the client UTXO authentication and signed-transaction verifier.
- [ ] External security review of the server API and provider quorum model.
- [ ] Independent review of token identity and policy.
- [ ] Release owner signs off on the exact tested commit and deployment artifact.

## PUSD Mainnet V3 circle and escrow release gates

The separate PUSD circle covenant is a different execution path from ordinary PUSD wallet transfers. Its Mainnet workspace currently supports unsigned genesis, deposit, payout and pre-first-payout cancellation previews, plus read-only state/receipt/escrow reconciliation. Those previews do not authorize real funds.

The server now provides `POST /api/pusd/circle/verify` for read-only verification of Selene-signed circle lifecycle transactions (PR #78). The workspace reports success only after local verification and server-side quorum-prevout/artifact/VM verification. Signed bytes are discarded after the response; this route cannot reserve, relay or broadcast them. The verifier still requires independent review and adversarial/live-wallet testing before a Mainnet release.

- [ ] Independently review `AjoCirclePUSDV3Mainnet.cash` and `AjoPUSDMemberEscrowV3.cash`, including exact compiled artifact hashes and every constructor argument.
- [ ] Independently verify the token category, token-aware member scripts, receipt NFT commitments, escrow contract bindings and CashToken carrier values.
- [ ] Inspect the exact genesis transaction and prove the state category, minting NFT, one receipt per member, and one empty PUSD escrow sidecar per member are created at the intended outputs.
- [ ] Adversarially test deposit, excess-token change, payout, reserve carry-forward, final-recipient no-reserve, cancellation, member order, missing/duplicate UTXOs, dust, integer bounds and inconsistent state commitments.
- [ ] Independently verify the exact PUSD fee output to the shared BCH/PUSD Mainnet treasury, and verify BCH carrier and miner fee amounts separately.
- [x] Implement a read-only server-side PUSD V3 circle signed-byte verifier for genesis, deposit, payout and cancellation. It reconstructs the exact circle/escrow artifacts, authenticates raw prevouts against the Electrum quorum, validates the full lifecycle layouts, checks wallet 0x61 sighashes and runs the BCH 2026 VM. Added in PR #78; it never relays or broadcasts. **Implementation is not independent security approval.**
- [ ] Recheck all state, receipt, escrow, token and fee UTXOs immediately before any future wallet authorization.
- [ ] Complete real Selene/WizardConnect lifecycle tests with independent member wallets, including app switching, reconnect, timeout, cancellation and confirmation.
- [ ] Add idempotent broadcast, unknown-result resolution, mempool-conflict handling, confirmation and reorg recovery.
- [ ] Obtain external review and written approval for the exact deployed circle/escrow artifacts and wallet transaction path.

Do not deploy the circle contracts or send PUSD/BCH to prototype scripts while any item above remains open.

## Hard stop

The server broadcast endpoint is compiled with `MAINNET_BROADCAST_ENABLED = false`. The API's PUSD relay path now submits once to a single provider and resolves ambiguous responses by looking up the exact transaction ID across the configured providers; it never blindly retries through a second relay. An `already-known` or relay-accepted result is not a confirmation, and confirmation/reorg tracking remains outstanding. The client additionally rejects direct calls to its PUSD broadcast function while `PUSD_MAINNET_SPENDING_ENABLED = false`. Setting `ENABLE_MAINNET_BROADCAST=true` in the deployment environment does not enable spending. Do not change either compile-time lock until every required item above is evidenced and approved.

PUSD circles and escrow are separate work. Their prototype covenants must not be treated as supported PUSD circle functionality.
