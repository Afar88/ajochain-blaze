# PUSD Mainnet spending release checklist

**Current status: READ-ONLY. PUSD Mainnet spending is not approved.**

External reviewer handoff: [`MAINNET_EXTERNAL_REVIEW_BRIEF.md`](./MAINNET_EXTERNAL_REVIEW_BRIEF.md).

This document is the release checklist referenced by `src/core/pusd-mainnet-guard.ts`. Passing unit tests or building a transfer preview does not satisfy these requirements.

## Token identity and policy

- [ ] Confirm the ParyonUSD issuer and category ID through current issuer-controlled sources.
- [ ] Verify decimals, supply/amount policy, NFT policy, allowed address types, and any issuer freeze/blacklist or recovery controls.
- [ ] Record the exact token metadata snapshot and review date in the release evidence.

## UTXO discovery and authentication

- [ ] Verify at least two independently operated Electrum providers, including ownership/operator, endpoint security, and fault-domain separation.
- [ ] Verify each endpoint against BCH Mainnet chain identity and agreed tip; investigate any tip disagreement rather than silently choosing one.
- [ ] Confirm pagination completeness and bounded UTXO counts.
- [ ] Authenticate each candidate UTXO using raw previous transaction bytes, computed txid, output index, exact locking script, BCH carrier value, category and amount.
- [ ] Recheck each input's unspent status through the configured quorum immediately before broadcast.
- [ ] Reject NFT-bearing PUSD outputs until an explicit and separately audited NFT policy exists.

## Transaction construction and verification

- [ ] Independently review deterministic token selection, recipient output, PUSD change, BCH carrier/dust and fee calculation.
- [ ] Test exact category/amount conservation and reject every unrecognized token output.
- [ ] Verify all BCH-only outputs are wallet-derived change destinations.
- [ ] Decode the exact Selene-signed raw bytes; verify every outpoint, prevout, wallet script, value, token output, fee, VM result and requested recipient amount.
- [ ] Re-query all prevouts after verification and immediately before a broadcast attempt.
- [ ] Verify behavior for server disagreement, timeout, partial broadcast acceptance, unknown result, duplicate submissions, mempool conflicts and chain reorgs.

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

- [ ] Independently review `AjoCirclePUSDV3Mainnet.cash` and `AjoPUSDMemberEscrowV3.cash`, including exact compiled artifact hashes and every constructor argument.
- [ ] Independently verify the token category, token-aware member scripts, receipt NFT commitments, escrow contract bindings and CashToken carrier values.
- [ ] Inspect the exact genesis transaction and prove the state category, minting NFT, one receipt per member, and one empty PUSD escrow sidecar per member are created at the intended outputs.
- [ ] Adversarially test deposit, excess-token change, payout, reserve carry-forward, final-recipient no-reserve, cancellation, member order, missing/duplicate UTXOs, dust, integer bounds and inconsistent state commitments.
- [ ] Independently verify the exact PUSD fee output to the shared BCH/PUSD Mainnet treasury, and verify BCH carrier and miner fee amounts separately.
- [ ] Add a Mainnet signed-byte verifier for all contract and wallet inputs, prevouts, token categories/amounts, NFT commitments, outputs, change and fee.
- [ ] Recheck all state, receipt, escrow, token and fee UTXOs immediately before any future wallet authorization.
- [ ] Complete real Selene/WizardConnect lifecycle tests with independent member wallets, including app switching, reconnect, timeout, cancellation and confirmation.
- [ ] Add idempotent broadcast, unknown-result resolution, mempool-conflict handling, confirmation and reorg recovery.
- [ ] Obtain external review and written approval for the exact deployed circle/escrow artifacts and wallet transaction path.

Do not deploy the circle contracts or send PUSD/BCH to prototype scripts while any item above remains open.

## Hard stop

The server broadcast endpoint is compiled with `MAINNET_BROADCAST_ENABLED = false`. The API's PUSD relay path now submits once to a single provider and resolves ambiguous responses by looking up the exact transaction ID across the configured providers; it never blindly retries through a second relay. An `already-known` or relay-accepted result is not a confirmation, and confirmation/reorg tracking remains outstanding. The client additionally rejects direct calls to its PUSD broadcast function while `PUSD_MAINNET_SPENDING_ENABLED = false`. Setting `ENABLE_MAINNET_BROADCAST=true` in the deployment environment does not enable spending. Do not change either compile-time lock until every required item above is evidenced and approved.

PUSD circles and escrow are separate work. Their prototype covenants must not be treated as supported PUSD circle functionality.
