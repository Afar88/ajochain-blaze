# AjoChain BLAZE — Mainnet Readiness Audit

**Audit date:** 16 November 2026  
**Repository reviewed:** `Afar88/ajochain-blaze`  
**Reviewed branch:** `audit/mainnet-readiness-gates`  
**Production project:** Vercel `ajochain-blaze`  
**Production alias:** https://ajochain-blaze.vercel.app

## Executive result

BLAZE is **not yet ready to accept or broadcast real BCH/PUSD transactions on Mainnet**. The application has a functional Mainnet read/inspection foundation and Chipnet contract prototypes, but it does not yet contain a complete, release-reviewed Mainnet transaction path.

The audit has not removed the current hard locks. They remain in place while the missing transaction-verification, broadcast, contract-review and wallet evidence is completed. This is not a decision to keep BLAZE read-only permanently: the intended next release is a real BCH Mainnet launch after the BCH path has passed the requirements below. PUSD spending and PUSD circles are a separate release scope and must not be enabled by merely opening BCH circles.

## Verified deployment and repository boundaries

- The Vercel project named `ajochain-blaze` is linked to `Afar88/ajochain-blaze`.
- Its production alias currently resolves to the production deployment built from `main`, commit `71d09a0530c7af3403983c1cbc6f4137f778bed0`.
- An audit-branch preview deployment was created and reached Vercel `READY` from commit `0ebbf6a0aafd9f9bd8edf694b43d087a379b83f4`. This was a preview deployment, not a production promotion.
- The production project has a project-scoped `ELECTRUM_SERVERS` value for two WSS endpoints. No PostgreSQL/Neon connection is configured in BLAZE.
- The legacy Vercel project and its Neon/Postgres connection variables remain separate from BLAZE. Do not copy legacy database credentials or deployment artefacts into BLAZE.
- The existing GitHub PR #9 is still a draft and unmerged. PRs #6 and #7 are open as well; #4 and #5 are draft/open. These branches overlap and diverge. Do not merge them independently without first reconciling the intended base and commit graph.

## Findings

### Critical — no end-to-end BCH Mainnet broadcast path

The browser Mainnet quorum provider explicitly rejects `sendRawTransaction`. The Classic BCH workspace calls that provider for circle creation, contribution and payout, but the BCH path has no approved replacement broadcaster in the current app. The client-side BCH kill-switch is also hard-disabled.

**Impact:** turning the UI constant on would not make Mainnet transactions work. It would expose a path that still terminates at a read-only provider or fails after signing.

**Required before BCH launch:** implement a dedicated Mainnet BCH broadcast adapter; validate the exact signed bytes against fresh authenticated prevouts, active consensus rules, the intended covenant transition, the exact fee/change/output policy and current unspent state; relay once; then reconcile accepted/unknown outcomes and independently verify confirmation/reorg state. Do not use the PUSD broadcast endpoint as a BCH broadcaster.

### Critical — active BCH consensus VM mismatch

BLAZE pins `@bitauth/libauth` `^3.0.0`. The wallet's signed-transaction verifier and PUSD verifier call `createVirtualMachineBCH2023`. The backend PUSD verification path also uses the BCH 2023 VM.

The May 15, 2026 BCH upgrade is active. Official BCHN material identifies the upgrade rules (including bounded loops, functions, bitwise operations and P2S) as active on Mainnet from 15 May 2026. The current Libauth stable npm package shown by npm is 3.0.0; the repository's BCH 2026 VM is in the 3.1.0-next prerelease line, not the stable 3.0.0 package.

**Impact:** the current verifier does not establish that the signed transaction is valid under the active Mainnet VM rules.

**Required before BCH launch:** choose and independently validate a maintained implementation of the BCH_2026_05 VM; pin the exact version/commit; run the matching BCHN/Libauth consensus test vectors and AjoChain contract transaction fixtures against it; use that verifier in the browser and server paths. Do not simply bump to an unreviewed prerelease.

References: [BCH 2026 upgrade specification](https://upgradespecs.bitcoincashnode.org/2026-05-15-upgrade/), [BCHN v29.0.0 release](https://github.com/bitcoin-cash-node/bitcoin-cash-node/releases/tag/v29.0.0), [Libauth npm package](https://www.npmjs.com/package/@bitauth/libauth), [Libauth releases](https://github.com/bitauth/libauth/releases).

### Critical — PUSD send is not a live product flow

The Assets screen exposes authenticated balance refresh and a transaction preview, but its Send button is disabled and has no send action. The client and server PUSD spending locks are both false. The server broadcast code, if eventually enabled, still uses the old BCH 2023 VM and does not yet demonstrate idempotent unknown-result reconciliation, independent confirmation, or a stable wallet-to-server approval protocol.

PUSD circle/escrow contracts are prototypes and are not exposed as an active product path.

**Impact:** PUSD must not be described as ready for real-value transfers or circles. Do not remove its lock as part of the BCH Mainnet launch.

ParyonUSD's official site confirms the PUSD category ID `2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544` and that it is a fungible BCH Mainnet CashToken: [official ParyonUSD site](https://paryonusd.com/). The inspected official page did not state token display decimals; BLAZE currently assumes two decimal places. Obtain issuer/BCMR confirmation for decimals before enabling PUSD amounts.

### High — AjoChain contracts do not have an independent security audit

The repo has automated CashScript/MockNetworkProvider tests for Classic V1, member-credit fee circles and the V3 reserve prototype. Those tests are useful but are not an independent audit, do not use two real Selene wallets and do not prove real Mainnet transaction behaviour.

The V2 fee and V3 automatic-reserve planner explicitly reject networks other than Chipnet. Their current contracts are labelled Chipnet prototypes. Classic V1 uses aggregate BCH pool accounting and does not provide per-member receipt attribution. Do not present V1 as having the V2/V3 individual-credit guarantees.

**Required before BCH launch:** independent review of the exact source and compiled artefact for each covenant version intended for Mainnet; adversarial tests for state/receipt uniqueness, order, overflows, dust, token categories, cancellation, fee bounds and all member counts; reproducible artifact hashes; and a separately compiled/validated Mainnet deployment version for any prototype currently restricted to Chipnet.

### High — two Electrum hostnames do not prove independent consensus evidence

The Mainnet reader checks a BCH genesis hash, fresh/equal tip headers, equal UTXO snapshots and matching raw previous transaction bytes from at least two configured hostnames. This is a useful read-quorum control.

It does not verify a continuous header chain, proof of work/chainwork or SPV inclusion proofs. Different hostnames do not prove that providers are independently operated. The reader therefore still trusts the configured Electrum operators not to collude or return the same fabricated view.

**Required before BCH launch:** document and verify provider operators/independence; add a stronger chain-verification or trusted-node model; test inconsistent/stale responses, reorgs, mempool conflicts, provider outages and timeouts. Be explicit in the product about the trust model.

### High — incomplete operational controls for a real-value API

The Mainnet API applies a process-local rate limit using the first value in `X-Forwarded-For`. This is not a durable, shared rate limit in serverless deployments and must not be treated as an abuse-control boundary. The API also needs production monitoring, alerting and incident/rollback procedures before any broadcast endpoint is exposed.

**Required before BCH launch:** move abuse controls to a trusted edge/platform rule or validated client identity; ensure proxy headers cannot be spoofed to bypass limits; define global and per-route limits; add monitoring and alerting for provider disagreement, unknown broadcasts and elevated failure rates; document incident response and rollback.

### Medium — dependency installs are not locked reproducibly

The reviewed branch contains `package.json` but no committed `package-lock.json`. CI and Vercel run `npm install`, which may resolve newer compatible versions over time. CI prints `npm audit` output but currently does not fail the job based on high/critical vulnerability counts.

**Required before release:** commit a generated npm lockfile, use `npm ci` in CI and Vercel, review/update dependencies deliberately, and define vulnerability thresholds that fail CI for actionable high/critical findings.

### Medium — account recovery is browser-local

Saved circles and invite metadata are stored locally in the browser. This is not a server account, durable recovery service or cross-device backup. On-chain state remains the source of funds/state truth, but losing local invites can make recovery harder.

**Required before broader launch:** keep the current limitation explicit; provide a tested user-controlled export/backup and restore flow; never imply that browser-local storage is a cloud account.

## Fix completed during this audit

The Mainnet flow helper incorrectly treated `relayAndConfirmationVerified` as a pre-broadcast requirement. That made the `broadcast-eligible` phase unreachable until a transaction had already been relayed and confirmed. The audit branch now separates the nine pre-broadcast prerequisites from post-broadcast confirmation and adds tests for the correct phase transitions.

This is a release-flow logic correction only. It did **not** enable either BCH or PUSD Mainnet signing/broadcasting, and it did not change either existing kill-switch.

## Mainnet opening sequence

1. Complete the contract and wallet audit for the BCH circle version selected for first launch. Keep Classic V1 aggregate-accounting limitations explicit; do not promote V2/V3 Chipnet prototypes without separate Mainnet review.
2. Adopt and test the active BCH_2026_05 verifier across browser and backend signing/verification.
3. Build the BCH Mainnet broadcast and confirmation/reorg path; test unknown/duplicate relay responses and stale-input races.
4. Verify provider independence and choose/document the chain trust model.
5. Run independent end-to-end tests with two separately controlled Selene/WizardConnect wallets on Mainnet using controlled small-value transactions after the independent review.
6. Complete CI/dependency, operational monitoring, rollback and user recovery checks.
7. Only then remove the BCH Mainnet lock and enable the first audited BCH Mainnet circle version.
8. Treat PUSD transfer sending and PUSD circles as a separate release with their own verified decimals, transaction path, audit and independent wallet evidence.

## Current status

- BCH Mainnet read/inspection: implemented, with a two-provider Electrum quorum and the trust limitations above.
- BCH Mainnet create/contribute/payout: **locked; no approved broadcaster**.
- Classic V1: planner and covenant prototype available; aggregate accounting; independent review and live Mainnet proof outstanding.
- V2 fee and V3 auto-reserve: **Chipnet-only prototypes**.
- PUSD balance/transfer preview: read-only/preparation path; official category ID identified; decimals need issuer/BCMR confirmation.
- PUSD Mainnet sending and PUSD circle spending: **locked/prototype only**.
- Production site: https://ajochain-blaze.vercel.app remains on the current `main` deployment; audit work is on a preview branch only.
