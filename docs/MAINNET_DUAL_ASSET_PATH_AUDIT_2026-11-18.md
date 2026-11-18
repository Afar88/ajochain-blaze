# AjoChain BLAZE — BCH + PUSD Mainnet pathway audit

**Audit date:** 18 November 2026  
**Reviewed commit:** `0c13b22179f595a5da1699823f38a3e12c3e624d`  
**Production deployment:** `dpl_3E9ZDVPbfMXg3BFdCrBjyo8ya3us`  
**Production URL:** https://ajochain-blaze.vercel.app  
**Submission target:** 20 November 2026

## Executive result

The **dual-asset Mainnet planning pathway is live**. The Create a circle page presents BCH and PUSD workspaces together. The production app and the read-only Mainnet API are deployed and responding.

The **real-value Mainnet transaction pathway is not open**. Both asset workspaces currently stop at unsigned transaction plans. BCH has no approved Mainnet broadcaster, its Mainnet covenant identifier resolves to the Chipnet V3 artifact, and its circle workspace does not call the wallet signing method. PUSD has a token-aware planning and server verification path, but the transfer UI does not request a wallet signature, the client spend guard is closed, and the server broadcast switch is compile-time false. PUSD circles remain unaudited prototypes.

Do not describe BCH or PUSD Mainnet deposits, payouts, cancellation refunds or transfers as live. Do not send real funds to the prototype contracts.

## Production verification

The following were verified after PR #46 merged:

- `main` points to `0c13b22179f595a5da1699823f38a3e12c3e624d`.
- Vercel deployment `dpl_3E9ZDVPbfMXg3BFdCrBjyo8ya3us` reached `READY` and has the `ajochain-blaze.vercel.app` alias.
- The production home page returned HTTP 200.
- `GET /api/health` returned HTTP 200, reported Mainnet `ready`, two configured providers responding, tip height 977,891, and `broadcastEnabled: false`.
- `GET /api/fees` returned HTTP 200 with two fee providers responding and a 1,001 sat/kB quote at the same tip.
- The merged PR's typecheck, unit tests, production build and targeted BCH 2026 VMB CI job passed.

These checks confirm deployment and read-quorum availability. They do not prove provider-operator independence, contract safety or transaction broadcast capability.

## What is open now

### BCH Mainnet

- Mainnet network selection and address validation.
- Read-only Mainnet chain/UTXO inspection through the configured two-provider quorum.
- BCH V3 genesis construction preview.
- Unsigned member-deposit, payout and pre-first-payout cancellation plans in the BCH workspace.

### PUSD Mainnet

- Canonical ParyonUSD category configuration.
- Read-only PUSD balance/UTXO inspection through the API, including raw previous-transaction and unspent-state checks.
- PUSD transfer construction preview and fee quote.
- Unsigned PUSD circle genesis, deposit, payout and pre-first-payout cancellation plans, plus state/receipt/escrow reconciliation.

The PUSD code is configured for two display decimals. Issuer-controlled confirmation of the exact category's decimals and token policy remains an explicit release requirement.

## Findings that block real-value opening

### Review item — shared network-neutral BCH V3 artifact

`v2FeeArtifactForCovenant("fee-v3-auto-reserve-mainnet")` and the guarded Chipnet V3 identifier currently resolve to the same compiled `AjoCircleV3AutoReserve` artifact. The CashScript source explicitly describes this as a **network-neutral script template**: member, initiator and treasury public-key hashes are constructor-bound, while the Mainnet adapter selects Mainnet address validation and the Mainnet quorum provider.

This shared artifact is not, by itself, proof of a defect or a reason to invent a second bytecode version. The release requirement is to independently audit the exact compiled artifact and Mainnet constructor bindings, including the Mainnet treasury and every member/initiator PKH. Confirm and document that this network-neutral use is intentional and safe for the BCH chain. If that review identifies network-dependent covenant behavior, then create and audit a distinct Mainnet source/artifact. Until that review is attached, the Mainnet contract remains blocked regardless of artifact naming.

### Critical — BCH has no complete Mainnet signing/broadcast route

- `MainnetQuorumNetworkProvider.sendRawTransaction` deliberately throws; it is a read-only provider.
- `BchMainnetCircleWorkspace` builds unsigned plans but does not invoke `wallet.signAndVerify`.
- There is no release-approved BCH Mainnet broadcaster or complete unknown-result, confirmation and reorg lifecycle.
- `BCH_MAINNET_OPERATIONS_ENABLED` remains false.

A generic WizardConnect signing method exists, but it is not connected to this Mainnet circle workspace. Do not enable the guard until the exact plan is signed, inspected against fresh authenticated prevouts, relayed once, and reconciled with confirmed chain state.

### Critical — PUSD transfer UI is not connected to its signing path

- The Assets page can build a token-aware transfer preview from authenticated PUSD UTXOs.
- The Send PUSD control is disabled and has no signing callback.
- `wallet.signAndVerify` is available in the generic wallet integration, and `verifyAndBroadcastPusdTransfer` exists in the PUSD API client, but the Assets page does not connect the transfer plan to those functions.
- `PUSD_MAINNET_SPENDING_ENABLED` is false, and `MAINNET_BROADCAST_ENABLED` in the server is false. A direct API request is intentionally rejected with HTTP 403.

Complete the wallet request, exact signed-byte comparison, BCH 2026 VM verification, fresh UTXO recheck, and user-visible transaction summary before any spend can be considered.

### Critical — PUSD circle contracts are prototypes, not a released product

The PUSD V3 circle and member-escrow source support unsigned planning and local test coverage. They still require independent review of the exact compiled artifacts, constructor arguments, category/receipt/escrow bindings, genesis output indexes, cancellation/refund accounting, token conservation, dust/carriers and every payout position. The PUSD circle UI does not call the wallet signer or a broadcaster.

### High — broadcast lifecycle is incomplete

The PUSD server has useful one-shot relay logic: it checks the transaction ID against exact signed bytes and, after an ambiguous relay result, looks up that exact transaction rather than blindly sending to a second provider. However:

- There is no durable idempotency/submission ledger across separate HTTP requests or serverless instances.
- Relay acceptance is explicitly not confirmation.
- Confirmation status is a separate read endpoint; there is no durable lifecycle/replacement record or complete operational reconciliation for retries, mempool conflicts and reorg recovery.
- The BCH path has no corresponding approved broadcaster.

Build durable idempotency and explicit `pending`, `unknown`, `confirmed`, `replaced` and `reorged` handling before enabling real-value relays.

### High — provider quorum is not an independent consensus proof

The API and browser compare two providers' tips, UTXO sets and raw previous transactions. The API is live with two responding providers. Different hostnames do not demonstrate independent ownership or fault domains, and matching Electrum responses are not equivalent to local SPV/chainwork validation.

Verify and document the operators, fault domains and chain-trust assumptions. Add the agreed stronger node/header verification model and incident handling before real-value use.

### High — external contract, wallet and operational evidence is still missing

- No independent security approval for the exact BCH Mainnet covenant artifact or PUSD circle/escrow artifacts.
- No complete two-wallet Selene/WizardConnect Mainnet create/deposit/payout/cancel lifecycle test for either asset.
- No completed controlled Mainnet test transaction proving the exact wallet signing and confirmation lifecycle.
- Monitoring, alerting, shared rate limiting, incident response, emergency stop and rollback evidence remain incomplete.
- The verifier is pinned to `@bitauth/libauth@3.1.0-next.8`, an upstream prerelease; independent provenance/review remains outstanding.

## Joint BCH + PUSD opening plan

Run the two asset workstreams in parallel and release them together only when both have passed the same release checkpoint:

1. **BCH artifact:** create a separately versioned Mainnet V3 source/artifact; pin source, compiled hash and constructor arguments; run adversarial and accounting-invariant tests.
2. **PUSD artifact:** finish independent review of the PUSD circle and escrow artifacts, exact category/decimals policy, genesis output map and all token/escrow transitions.
3. **Wallet path:** connect both Mainnet planners to WizardConnect signing. Decode the exact returned bytes; compare every input, prevout, output, token commitment, fee and change against the approved plan; run the BCH 2026 VM.
4. **Broadcast and recovery:** implement a BCH broadcaster and finish the PUSD broadcaster path with durable idempotency, one-shot submission, unknown-result resolution, conflict/replacement handling and confirmation/reorg recovery.
5. **Provider trust:** verify provider operators and fault-domain separation; document the chain-verification trust model and test disagreement, stale data, outage and reorg cases.
6. **Live wallet tests:** use separately controlled Selene/WizardConnect wallets for both assets, including mobile app switching, reconnect, signing, deposits, payout and pre-first-payout cancellation. Use only controlled small amounts after independent review.
7. **Operations:** add/verify monitoring, alerting, shared rate limits, request bounds, incident response, emergency stop and rollback.
8. **Release approval:** attach all evidence to an immutable commit and exact compiled artifacts; resolve critical/high findings; obtain written independent approval; then conduct a joint BCH + PUSD go-live review.

Until then, keep all three hard locks closed:

- `BCH_MAINNET_OPERATIONS_ENABLED = false`
- `PUSD_MAINNET_SPENDING_ENABLED = false`
- `MAINNET_BROADCAST_ENABLED = false`

## Current release statement

> AjoChain BLAZE has a live dual-asset Mainnet planning experience for BCH and ParyonUSD, backed by a working read-only Mainnet provider API. BCH Chipnet remains the test-network circle lifecycle. Mainnet workspaces support chain inspection and unsigned transaction planning; real-value signing and broadcasting remain closed pending artifact separation, independent security review, live wallet testing and operational release evidence.
