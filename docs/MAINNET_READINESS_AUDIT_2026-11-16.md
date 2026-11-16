# AjoChain BLAZE — Mainnet Readiness Audit

**Audit date:** 16 November 2026  
**Repository:** `Afar88/ajochain-blaze`  
**Production Vercel project:** `ajochain-blaze`  
**Production alias:** https://ajochain-blaze.vercel.app

## Executive result

**BLAZE is not yet ready for real-value BCH Mainnet circle operations.** The current codebase contains a Mainnet inspection/read foundation and Chipnet covenant prototypes, but it does not yet have a complete, independently validated Mainnet transaction path.

This audit does not recommend leaving BLAZE read-only permanently. The intended next release is a BCH Mainnet launch after the BCH consensus verifier, selected covenant, wallet signing path, broadcaster, chain reconciliation and independent review are complete. PUSD transfers and PUSD circles are a separate release scope; they must not be opened as a side effect of enabling BCH circles.

The actual Mainnet hard locks remain unchanged:
- BCH client transaction guard: `BCH_MAINNET_OPERATIONS_ENABLED = false`.
- PUSD client spend guard: `PUSD_MAINNET_SPENDING_ENABLED = false`.
- PUSD server broadcast guard: `MAINNET_BROADCAST_ENABLED = false`.
- The Mainnet quorum provider rejects `sendRawTransaction`.

## What was reviewed and verified

### Repository, deployment and branch state

- `main` is the BLAZE source of truth. The old `Afar88/Ajochain` repository is a separate legacy codebase.
- Vercel project `ajochain-blaze` is linked to `Afar88/ajochain-blaze`. The legacy project and its backend remain separate.
- The BLAZE production project has its own `ELECTRUM_SERVERS` environment variable. It has no Neon/PostgreSQL connection. The legacy Vercel project retains its own Neon/Postgres variables; do not reuse them in BLAZE.
- GitHub Pages deployment was removed in PR #11. Vercel is the single hosted deployment target for BLAZE.
- Production alias `ajochain-blaze.vercel.app` was last verified against `main` commit `71d09a0530c7af3403983c1cbc6f4137f778bed0`, before the later BLAZE feature branch was merged. Recent Vercel deployments were blocked by the account's daily deployment limit (`api-deployments-free-per-day`, more than 100 deployments). The new code is therefore not yet verified on the production alias.
- Draft PR #9 contains the main 63-file BLAZE product expansion (Classic BCH, V2/V3 prototypes, PUSD read/preview API, navigation and accounting). Its latest checked head at audit time was `86f8dc50d25916488e7619471bb0b18a64673130`; CI passed, but the PR remains draft and is not merged. PR #6 and #7 are overlapping/stacked branches. Reconcile them as one reviewed integration; do not merge all stacked PRs independently.
- PR #10 fixed the Mainnet flow phase bug and was merged. CI passed typecheck, unit tests and production build. PR #11 removed the GitHub Pages deployment and was merged after CI passed.
- PR #12 updates the Mainnet flow documentation to distinguish pre-broadcast gates from post-broadcast confirmation; it is in review at the time of this audit.

### Mainnet flow logic

The previous flow helper incorrectly required `relayAndConfirmationVerified` before `canBroadcast` could become true. That made the `broadcast-eligible` phase unreachable until after a broadcast/confirmation had already happened.

PR #10 corrected this by separating the pre-broadcast evidence list from the post-broadcast confirmation item. It also added tests for out-of-order evidence, missing gates, broadcast eligibility and confirmed state.

**Important limitation:** this helper is a readiness model, not a live transaction authorization system. The real BCH/PUSD action paths still use their separate hard locks; no live application code currently produces the independent evidence records and passes them into this helper. Do not treat the helper fix as permission to broadcast.

## Critical findings

### 1. BCH 2026 consensus VM mismatch

The May 15, 2026 BCH Mainnet upgrade is active. BCHN v29.0.0 implements the four consensus changes for that upgrade: P2S, bounded loops, function definition/invocation and re-enabled bitwise operations. The BCH upgrade specification states the rules take effect on Mainnet once median-time-past reaches 15 May 2026 12:00 UTC.

BLAZE's wallet verifier, PUSD client verifier and PUSD server verifier call Libauth's BCH 2023 VM (`createVirtualMachineBCH2023`). The current stable npm package `@bitauth/libauth` is 3.0.0; its published API exposes the BCH 2023 VM. The BCH 2026 implementation (`createVirtualMachineBch2026`, including `OP_BEGIN` and `OP_UNTIL`) is in the upstream 3.1.0 prerelease line, not the current stable npm release.

The Classic and V3 covenant artifacts include bounded-loop opcodes generated from CashScript `for` loops. The current wallet verifier therefore does not provide a valid BCH 2026 verification path for those covenant spends. Loop-based spends are likely to fail local verification under the BCH 2023 VM even when the active network accepts the new opcodes.

**Required before any BCH Mainnet opening:**
- Select a maintained verifier that implements the active `BCH_2026_05` rules.
- Pin its exact version/commit and review whether prerelease status is acceptable; do not blindly install a prerelease in production.
- Run Libauth/BCHN VMB consensus vectors, plus AjoChain-specific transaction fixtures, against the selected VM.
- Use the same verified consensus rules in browser-side and server-side transaction inspection.
- Prove the result for the actual compiled artifacts, not only generic P2PKH transactions.

References: [BCHN v29.0.0 announcement](https://bitcoincashnode.org/en/newsroom/announcing-bitcoin-cash-node-v29-0-0), [15 May 2026 upgrade specification](https://upgradespecs.bitcoincashnode.org/2026-05-15-upgrade/), [Libauth npm package](https://www.npmjs.com/package/@bitauth/libauth), [Libauth v3.1.0-next.8 prerelease](https://github.com/bitauth/libauth/releases/tag/v3.1.0-next.8).

### 2. No BCH Mainnet broadcaster

The Mainnet quorum provider is deliberately read-only and throws from `sendRawTransaction`. The Classic BCH workspace plans transactions, then calls the provider to submit them; the current Mainnet lock prevents reaching that stage. Even removing the boolean lock would not create a working Mainnet broadcaster.

**Required before BCH launch:** a dedicated Mainnet relay adapter, exact signed-byte verification, fresh prevout/unspent checks immediately before submission, single-submission/idempotency policy, unknown-result reconciliation, independent transaction lookup and confirmation/reorg tracking. Keep the PUSD API broadcaster separate from BCH circle broadcasting.

### 3. No Mainnet-ready member-accounting covenant

Classic V1 is an aggregate pool: it does not attribute each payment to an individual immutable receipt. It cannot provide the V2/V3 member-level contribution accounting.

V2 fee escrow and V3 automatic-reserve contracts are currently Chipnet-only in the planner/validator. V3 reserves one next installment for the payout recipient, not all remaining installments. It reduces immediate post-payout default risk but does not guarantee full-cycle completion if that member stops contributing permanently.

**Recommended BCH launch direction:** take the member-receipt V3 model through a separate Mainnet version, with a clear one-installment reserve disclosure, rather than presenting Classic V1's aggregate pool as per-member protection. Keep all existing covenant versions and addresses immutable.

**Required before launch:** independent review of exact source and compiled artifact; adversarial tests for every payout position and member count, invalid/missing/duplicate state and receipt NFTs, malformed commitments, overflow, dust, treasury and miner fees, cancellation and reorgs; reproduce and record the artifact hash; and deploy a separately versioned Mainnet artifact only after review.

### 4. Mainnet chain quorum is a read trust check, not consensus verification

The two-provider reader compares BCH Mainnet genesis identity, fresh tip height/header, UTXO snapshots and raw previous-transaction bytes. This is a useful read-only consistency check, but:
- it does not verify a continuous header chain, proof of work/chainwork or SPV inclusion proofs;
- two hostnames do not prove independent operators;
- the configured tip freshness tolerance is three hours, too wide for a spend-critical plan.

**Required before launch:** document and verify provider operators; use a stronger trusted-node/SPV model or explicitly document provider trust; tighten freshness relative to current block cadence; and test stale, inconsistent, unavailable, reorged and mempool-conflicted states.

### 5. Wallet signed-transaction verification is not yet a complete Mainnet authorization path

WizardConnect compares the signed transaction's version, locktime, input outpoints/order/sequences and serialized outputs with the prepared request. It checks the required `0x61` sighash flag for P2PKH wallet inputs and executes the supplied previous-output data through the BCH 2023 VM.

Remaining gaps for Mainnet include current BCH 2026 VM validation, fresh UTXO rechecks after the wallet signs, exact independent prevout provenance at the final authorization step, full covenant/state transition verification and independent confirmation after relay. The current Mainnet provider is read-only, so the last step is not implemented for BCH.

### 6. PUSD send path must remain a separate release

The Assets page supports authenticated balance refresh and a PUSD transfer preview. The Send button is still disabled. Client and server broadcast locks remain false. PUSD circle/escrow contracts are prototypes, not an active product path.

The server-side PUSD spend verifier does useful checks: raw previous transaction parsing, outpoint and wallet-script matching, category/NFT restrictions, token amount conservation, recipient/change destinations, BCH fee accounting, fresh unspent-state rechecks and script validation. However, before opening it, the audit identified these additional requirements:
- use the active BCH 2026 consensus verifier;
- enforce CashToken carrier/dust minimums on every token output (CashScript guidance describes the common 1,000-sat token-output convention);
- bind the exact signed outputs, carrier values, sequence and fee/change details to the reviewed plan, not only the aggregate token-transfer intent;
- add idempotent broadcast and unknown-result reconciliation rather than relying on sequential provider retries;
- require production-grade request/rate-limit controls.

ParyonUSD's issuer site confirms the Mainnet token category ID `2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544`. The UI assumes 2 decimals; verify the decimals directly against current issuer-controlled BCMR metadata before enabling sends.

References: [ParyonUSD issuer site](https://paryonusd.com/), [CashScript CashTokens guidance](https://cashscript.org/docs/design/cashtokens), [Selene Mainnet token registry view](https://explorer.selene.cash/market?network=mainnet).

### 7. Production API hardening

The current serverless API's rate limiter uses an in-memory Map per runtime instance and keys requests using the first `X-Forwarded-For` value. That is not a reliable global rate limit across serverless instances and should not be treated as an abuse-control boundary.

**Required before enabling any broadcast endpoint:** trusted edge/platform rate limits, validated client identity, request-size limits, origin/CSRF policy, monitoring for provider disagreement and unknown broadcast results, alerting, and a documented incident/rollback procedure.

### 8. Reproducible build and dependency controls

The reviewed BLAZE branch has no committed npm lockfile and uses `npm install` in CI and Vercel. CI prints an npm audit report but does not fail based on actionable vulnerability thresholds.

**Required before release:** generate and commit `package-lock.json`, use `npm ci`, review dependency changes deliberately, and fail CI for agreed high/critical vulnerability thresholds.

### 9. Deployment state is not yet the latest BLAZE build

The Vercel daily deployment limit prevented a fresh preview/production deployment after the latest Git changes. The production alias remains linked to the earlier `main` deployment. Do not describe the merged GitHub commit as live on the production site until Vercel reports a READY deployment with the exact current main SHA and the alias has been verified.

## Mainnet opening sequence

1. Select the launch covenant. For member-level contribution attribution, use a separately versioned Mainnet V3 path after independent review; keep Classic V1's aggregate-accounting limitation explicit.
2. Adopt and validate the active BCH 2026 VM with upstream consensus vectors and AjoChain transaction fixtures.
3. Finish exact wallet-signed transaction verification and fresh state/prevout checks.
4. Implement BCH Mainnet broadcaster, idempotency, unknown-result recovery, independent confirmation and reorg handling.
5. Strengthen Mainnet chain trust/provider model and operational controls.
6. Complete independent contract review and two-wallet Selene/WizardConnect end-to-end tests using controlled small-value transactions.
7. Run full CI/security/dependency checks, promote to the BLAZE Vercel production project, and verify the exact deployed SHA.
8. Only then remove the BCH Mainnet transaction lock and open the audited BCH Mainnet circle version.
9. Treat PUSD sends and PUSD circles as a separate release with their own verified BCMR policy, transfer-path fixes, contract review and wallet evidence.

## Current status

| Area | Status |
|---|---|
| BLAZE/legacy Vercel and backend separation | Verified separate |
| Vercel-only deployment workflow | Merged; current production alias still needs a fresh verified deploy |
| Mainnet flow helper sequencing | Fixed and merged; not yet wired into live transaction authorization |
| BCH Mainnet read inspection | Implemented with a two-provider consistency check; trust limitations remain |
| BCH Mainnet create/contribute/payout | Locked; no approved broadcaster |
| Classic V1 | Aggregate pool only; not suitable as member-receipt accounting |
| V2 fee / V3 auto-reserve | Chipnet-only prototypes; V3 is a one-installment reserve |
| Active BCH consensus verification | Blocked; app still uses BCH 2023 VM |
| WizardConnect Mainnet E2E | Not independently verified |
| PUSD balance/preview | Read/preview only |
| PUSD Mainnet send/circle | Locked/prototype only |

**Do not remove a Mainnet lock until the corresponding release requirements have attached evidence, an independent review and a verified release commit.**
