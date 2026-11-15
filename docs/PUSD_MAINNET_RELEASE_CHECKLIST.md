# PUSD Mainnet spending release checklist

**Current status: READ-ONLY. PUSD Mainnet spending is not approved.**

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

## Hard stop

The server broadcast endpoint is compiled with `MAINNET_BROADCAST_ENABLED = false`. The client additionally rejects direct calls to its PUSD broadcast function while `PUSD_MAINNET_SPENDING_ENABLED = false`. Setting `ENABLE_MAINNET_BROADCAST=true` in the deployment environment does not enable spending. Do not change either compile-time lock until every required item above is evidenced and approved.

PUSD circles and escrow are separate work. Their prototype covenants must not be treated as supported PUSD circle functionality.
