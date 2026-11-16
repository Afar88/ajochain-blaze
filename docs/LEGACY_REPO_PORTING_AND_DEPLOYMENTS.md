# Legacy AjoChain to BLAZE porting and deployment boundaries

This document records how the work merged in the legacy `Afar88/Ajochain` repository was evaluated for the independent BLAZE build. The two repositories and their Vercel projects must remain isolated.

## Repository boundary

- **BLAZE source of truth:** [`Afar88/ajochain-blaze`](https://github.com/Afar88/ajochain-blaze).
- **Frozen legacy source:** [`Afar88/Ajochain`](https://github.com/Afar88/Ajochain).
- Changes for BLAZE must be made in the BLAZE repository and verified against the BLAZE Vercel project. A green check or deployment from the legacy repository is never evidence for BLAZE.

## What was carried forward or superseded

The legacy PR #35 added ACR v3 percentage retention (default 20%), separate BCH/PUSD covenant prototypes, Chipnet-only guards, member-credit accounting, tester/security documentation and a mobile-first styling refresh.

BLAZE uses a newer React/Vite application and a different, versioned accounting design:

- The BLAZE `AjoCircleV3AutoReserve` path reserves exactly one next installment for the payout recipient (except the final recipient), records that amount on that member's receipt and consumes it at the next payout. It is not the legacy percentage-retention formula. Do not copy the legacy percentage covenant or present the two accounting rules as interchangeable.
- BLAZE's fee-v2 escrow, V3 auto-reserve, member ledger and separately funded miner-fee path have their own contract versions, planners and tests. Existing legacy invites and covenant addresses must not be rewritten or migrated.
- PUSD verification and transfer-preview foundations are kept separate from PUSD circle spending. PUSD circle/escrow spending remains blocked until its own release gates pass. The legacy PUSD ACR covenant is not enabled in BLAZE.
- The legacy static-DOM stylesheet was not copied over the React UI. BLAZE's own dashboard, responsive navigation and deferred workspace loading are maintained in its React styling/components instead.

These are deliberate compatibility decisions: copying the old covenant unchanged would add a second, conflicting retention rule and would not be a safe upgrade of existing BLAZE circles.

## Vercel project isolation

The following project-to-repository mapping is verified in the Vercel team. Each project has its own deployment history, domains and environment-variable store.

| Vercel project | Git repository | Stable domain | Intended role |
| --- | --- | --- | --- |
| `ajochain-blaze` | `Afar88/ajochain-blaze` | https://ajochain-blaze.vercel.app | Active BLAZE build |
| `ajochain-legacy` | `Afar88/Ajochain` | https://ajochain.vercel.app | Legacy build |
| `ajochain-legacy-recovery` | `Afar88/Ajochain` | https://ajochain-recovery-preview.vercel.app | Legacy recovery preview |

Never deploy a BLAZE commit to either legacy project. Never deploy a legacy commit to the BLAZE project. Keep environment variables scoped to the project that owns the corresponding app; do not copy secrets or network configuration between projects by default.

## Release and network guardrails

- Use the BLAZE Vercel project for BLAZE preview and production deployment checks.
- Mainnet inspection does not mean Mainnet spending is enabled. BCH Mainnet signing/broadcast and PUSD Mainnet spending remain fail-closed until the documented verifier, independent review and end-to-end release gates pass.
- Chipnet-only covenant prototypes must stay on Chipnet and must never be advertised as audited or production-ready.
- A successful GitHub Actions run does not replace a successful Vercel deployment. Report the exact commit SHA and project for every deployment result.
