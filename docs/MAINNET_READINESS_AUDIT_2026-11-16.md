# AjoChain BLAZE — Mainnet Readiness Audit

**Audit date:** 16 November 2026  
**Repository reviewed:** `Afar88/ajochain-blaze`  
**Reviewed branch:** `build/clean-mainnet-product`  
**Production project:** Vercel `ajochain-blaze`  
**Production alias:** https://ajochain-blaze.vercel.app

## Executive result

BLAZE is **not yet ready to accept or broadcast real BCH/PUSD transactions on Mainnet**. The application has a functional Mainnet read/inspection foundation and Chipnet contract prototypes, but it does not yet contain a complete, release-reviewed Mainnet transaction path.

The audit has not removed the current hard locks. They remain in place while the missing transaction-verification, broadcast, contract-review and wallet evidence is completed. This is not a decision to keep BLAZE read-only permanently: the intended next release is a real BCH Mainnet launch after the BCH path has passed the requirements below. PUSD spending and PUSD circles are a separate release scope and must not be enabled by merely opening BCH circles.

## Verified deployment and repository boundaries

- The Vercel project named `ajochain-blaze` is linked to `Afar88/ajochain-blaze`.
- Its production alias currently resolves to the production deployment built from `main`, commit `71d09a0530c7af3403983c1cbc6f4137f778bed0`.
- A clean BLAZE integration preview has reached Vercel `READY` from `build/clean-mainnet-product`. This is a preview deployment, not a production promotion.
- The production project has a project-scoped `ELECTRUM_SERVERS` value for two WSS endpoints. No PostgreSQL/Neon connection is configured in BLAZE.
- The legacy Vercel project and its Neon/Postgres connection variables remain separate from BLAZE. Do not copy legacy database credentials or deployment artefacts into BLAZE.
- The existing GitHub PR #9 is still a draft and unmerged. PRs #6 and #7 are open as well; #4 and #5 are draft/open. These branches overlap and diverge. Do not merge them independently without first reconciling the intended base and commit graph.

## Findings

### Critical — no end-to-end BCH Mainnet broadcast path

The browser Mainnet quorum provider explicitly rejects `sendRawTransaction`. The Classic BCH workspace calls that provider for circle creation, contribution and payout, but the BCH path has no approved replacement broadcaster in the current app. The client-side BCH kill-switch is also hard-disabled.

**Impact:** turning the UI constant on would not make Mainnet transactions work. It would expose a path that still terminates at a read-only provider or fails after signing.

**Required before BCH launch:** implement a dedicated Mainnet BCH broadcast adapter; validate the exact signed bytes against fresh authenticated prevouts, active consensus rules, the intended covenant transition, the exact fee/change/output policy and current unspent state; relay once; then reconcile accepted/unknown outcomes and independently verify confirmation/reorg state. Do not use the PUSD broadcast endpoint as a BCH broadcaster.

### Critical — active BCH consensus VM mismatch

Before the BCH 2026 compatibility change, the wallet, PUSD client and PUSD server verifiers all used the BCH 2023 VM. The current feature branch now pins `@bitauth/libauth` to `3.1.0-next.8` and uses `createVirtualMachineBch2026` in all three paths, with bounded-loop regression coverage. This resolves the direct 2023-VM mismatch in the feature code, but Libauth remains an upstream prerelease and BLAZE CI does not yet run the full BCHN/VMB consensus vector suite.

The May 15, 2026 BCH upgrade is active. Official BCHN material identifies the upgrade rules (including bounded loops, functions, bitwise operations and P2S) as active on Mainnet from 15 May 2026. The BLAZE integration branch has now pinned Libauth exactly to `3.1.0-next.8` and calls `createVirtualMachineBch2026` in the wallet verifier, PUSD client verifier and PUSD API verifier. Regression tests prove bounded-loop scripts pass under the 2026 VM and fail under the 2023 VM. This addresses the direct VM-version mismatch. The pinned Libauth package is still an upstream prerelease, and CI does not yet run the full upstream BCHN/VMB consensus-vector suite.

**Impact:** local verifier versioning now matches the May 2026 upgrade implementation, but a bounded-loop regression test is not a substitute for the complete consensus vector suite and external review.

**Remaining before BCH launch:** complete dependency provenance and independent review for the pinned Libauth `3.1.0-next.8` prerelease; run the full BCHN/VMB consensus vectors in CI; run AjoChain-specific transaction fixtures for every exact compiled covenant artifact intended for Mainnet; and retain the passing results with the release evidence.

References: [BCH 2026 upgrade specification](https://upgradespecs.bitcoincashnode.org/2026-05-15-upgrade/), [BCHN v29.0.0 release](https://github.com/bitcoin-cash-node/bitcoin-cash-node/releases/tag/v29.0.0), [Libauth npm package](https://www.npmjs.com/package/@bitauth/libauth), [Libauth releases](https://github.com/bitauth/libauth/releases).

### Critical — PUSD send is not a live product flow

The Assets screen exposes authenticated balance refresh and a transaction preview, but its Send button is disabled and has no send action. The client and server PUSD spending locks are both false. The integration branch now uses the BCH 2026 VM on both client and server, checks the Selene/WizardConnect `0x61` full-transaction sighash on wallet-owned P2PKH inputs at both layers, and validates serialized dust/carrier thresholds for token outputs and BCH-only change outputs. The server broadcast routine still attempts sequential provider broadcasts after errors and does not provide robust idempotent unknown-result reconciliation or independent confirmation/reorg tracking. The wallet-to-server request is not bound by a signed server challenge or durable idempotency record.

PUSD circle/escrow contracts are prototypes and are not exposed as an active product path.

**Impact:** PUSD must not be described as ready for real-value transfers or circles. Do not remove its lock as part of the BCH Mainnet launch.

ParyonUSD's official site confirms the PUSD category ID `2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544` and that it is a fungible BCH Mainnet CashToken: [official ParyonUSD site](https://paryonusd.com/). The inspected official page did not state token display decimals; BLAZE currently assumes two decimal places. Obtain issuer/BCMR confirmation for decimals before enabling PUSD amounts.

### High — AjoChain contracts do not have an independent security audit

The repo has automated CashScript/MockNetworkProvider tests for Classic V1, member-credit fee circles and the V3 reserve prototype. Those tests are useful but are not an independent audit, do not use two real Selene wallets and do not prove real Mainnet transaction behaviour.

The V2 fee and V3 automatic-reserve planner explicitly reject networks other than Chipnet. Their current contracts are labelled Chipnet prototypes. Classic V1 uses aggregate BCH pool accounting and does not provide per-member receipt attribution. Do not present V1 as having the V2/V3 individual-credit guarantees.

**Required before BCH launch:** independent review of the exact source and compiled artefact for each covenant version intended for Mainnet; adversarial tests for state/receipt uniqueness, order, overflows, dust, token categories, cancellation, fee bounds and all member counts; reproducible artifact hashes; and a separately compiled/validated Mainnet deployment version for any prototype currently restricted to Chipnet.

### High — two Electrum hostnames do not prove independent consensus evidence

The Mainnet reader checks BCH genesis identity, equal tip headers, equal UTXO snapshots and matching raw previous-transaction bytes from at least two configured hostnames. Its browser and server freshness cutoff is now 30 minutes, with a 31-minute stale-tip regression test. This is a useful read-quorum control.

It does not verify a continuous header chain, proof of work/chainwork or SPV inclusion proofs. Different hostnames do not prove that providers are independently operated. The reader therefore still trusts the configured Electrum operators not to collude or return the same fabricated view.

**Required before BCH launch:** document and verify provider operators/independence; add a stronger chain-verification or trusted-node model; test inconsistent/stale responses, reorgs, mempool conflicts, provider outages and timeouts. Be explicit in the product about the trust model.

### High — incomplete operational controls for a real-value API

The Mainnet API applies a process-local in-memory rate limit using `X-Forwarded-For` (falling back to the runtime socket address). Vercel documents that it overwrites `X-Forwarded-For` to prevent IP spoofing, unless a trusted-proxy setup is configured; the main remaining limitation here is that a per-process `Map` is not a shared global rate limit across serverless instances and can reset between invocations. BLAZE's active Vercel project currently has no custom firewall configuration.

**Required before BCH launch:** add shared edge/platform rate limiting for the API routes, validate its actual Vercel behaviour, define per-route quotas and request sizes, add monitoring and alerting for provider disagreement, unknown broadcasts and elevated failure rates, and document incident response and rollback. Vercel WAF rate-limit rules can incur usage charges, so confirm the budget before enabling them. See [Vercel request-header documentation](https://vercel.com/docs/headers/request-headers) and [Vercel WAF pricing](https://vercel.com/docs/security/vercel-waf#pricing).

### Medium — dependency installs are not locked reproducibly

The reviewed branch contains `package.json` but no committed `package-lock.json`. CI and Vercel run `npm install`, which may resolve newer compatible versions over time. CI reports `npm audit`; the latest full clean-integration run reported 0 vulnerabilities, but the audit step currently does not fail the job based on high/critical vulnerability counts.

**Required before release:** commit a generated npm lockfile, use `npm ci` in CI and Vercel, review/update dependencies deliberately, and define vulnerability thresholds that fail CI for actionable high/critical findings.

### Medium — account recovery is browser-local

Saved circles and invite metadata are stored locally in the browser. This is not a server account, durable recovery service or cross-device backup. On-chain state remains the source of funds/state truth, but losing local invites can make recovery harder.

**Required before broader launch:** keep the current limitation explicit; provide a tested user-controlled export/backup and restore flow; never imply that browser-local storage is a cloud account.

## Fixes completed during this audit

The Mainnet flow helper incorrectly treated `relayAndConfirmationVerified` as a pre-broadcast requirement. That made the `broadcast-eligible` phase unreachable until a transaction had already been relayed and confirmed. The audit branch now separates the nine pre-broadcast prerequisites from post-broadcast confirmation and adds tests for the correct phase transitions.

Additional integration fixes now include the BCH 2026 VM across wallet/PUSD client/server verification, 30-minute Mainnet tip freshness, PUSD `0x61` sighash enforcement on client and server, and serialized dust checks for CashToken and BCH change outputs. These are validation improvements only. They did **not** enable BCH or PUSD Mainnet signing/broadcasting, and they did not change either existing kill-switch.

## Mainnet opening sequence

1. Complete the contract and wallet audit for the BCH circle version selected for first launch. Keep Classic V1 aggregate-accounting limitations explicit; do not promote V2/V3 Chipnet prototypes without separate Mainnet review.
2. Complete dependency provenance review and full BCHN/VMB consensus-vector validation for the pinned BCH 2026 verifier across browser and backend signing/verification.
3. Build the BCH Mainnet broadcast and confirmation/reorg path; test unknown/duplicate relay responses and stale-input races.
4. Verify provider independence and choose/document the chain trust model.
5. Run independent end-to-end tests with two separately controlled Selene/WizardConnect wallets on Mainnet using controlled small-value transactions after the independent review.
6. Complete CI/dependency, operational monitoring, rollback and user recovery checks.
7. Only then remove the BCH Mainnet lock and enable the first audited BCH Mainnet circle version.
8. Treat PUSD transfer sending and PUSD circles as a separate release with their own verified decimals, transaction path, audit and independent wallet evidence.

## Current status

- BCH Mainnet read/inspection: implemented, with a two-provider Electrum quorum and 30-minute tip freshness; trust limitations above remain.
- BCH Mainnet create/contribute/payout: **locked; no approved broadcaster**.
- Classic V1: planner and covenant prototype available; aggregate accounting; independent review and live Mainnet proof outstanding.
- V2 fee and V3 auto-reserve: **Chipnet-only prototypes**.
- PUSD balance/transfer preview: read-only/preparation path; client/server BCH 2026 VM, `0x61` signature and carrier/dust checks are implemented; idempotent broadcast and confirmation remain missing; decimals need issuer/BCMR confirmation.
- PUSD Mainnet sending and PUSD circle spending: **locked/prototype only**.
- Production site: verify `https://ajochain-blaze.vercel.app` against the exact post-merge `main` SHA; the clean integration preview is not itself a production promotion.
