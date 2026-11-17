# AjoChain — BCH Mainnet Build

AjoChain is an independent, non-custodial rotating savings-circle application being built for Bitcoin Cash.

This repository is the **independent BCH BLAZE build**. It is not a copy, mirror, or continuation branch of the frozen V1 release. The V1 repository and its deployed website remain separate and unchanged.

## Product direction

- Mainnet-first architecture for Bitcoin Cash.
- WizardConnect wallet connection for compatible BCH wallets, including Selene.
- BCH contributions have a tested Chipnet V3 auto-reserve prototype and a separate, guarded Mainnet V3 genesis-preview adapter. PUSD uses the real Mainnet CashToken category and a Mainnet V3 covenant prototype under development. Both Mainnet paths pin the same 1% project-fee treasury, with member-owned reserves and pre-payout cancellation rules.
- Transparent circle schedules, member payment records, and per-member credit accounting.
- Mobile-first, accessible fintech UX.
- Clear transaction previews, fee visibility, and confirmation states.

## Current application status

- Responsive dashboard and local circle-preview form.
- Local circle drafts persist in the current browser and can be edited or deleted; they are not on-chain records.
- WizardConnect dapp relay integration with encrypted saved-session resume, mobile focus/visibility recovery, overlap protection, Selene receive-index matching and signed-transaction intent verification.
- BCH/Chipnet network selection and full CashAddress checksum + network-prefix validation.
- Separate BCH and PUSD Mainnet circle workspaces are visible in Circles. They can validate drafts and prepare unsigned genesis previews only; Mainnet signing and broadcasting remain locked.
- The current new-circle flow uses the `fee-v3-auto-reserve` covenant (`AjoCircleV3AutoReserve`): each member funds the current round, and each non-final recipient carries exactly one next contribution forward in their own receipt. The reserve is consumed on the following payout; later rounds still require fresh contributions. The older `fee-v2-escrow` covenant remains versioned separately and requires members to lock every remaining scheduled contribution before payout. Both are Chipnet-only prototypes. The workspace includes a member accountability ledger showing paid-in, member-owned credit, received payout, next-round shortfall and payout lock status.
- Existing `fee-v1` invites remain on their original rolling-credit contract and are clearly marked as legacy; they do not gain the full-cycle default guarantee retroactively.
- Ported BCH V2 member-receipt covenant source in `contracts/AjoCircleV2.cash`; each payout consumes one round contribution from every member receipt, including the previous payout recipient.
- Unit tests are written for the member ledger, circle draft validation, checksummed network addresses and raw signed-transaction intent comparison. Their execution status, TypeScript build and CashScript compilation must be confirmed by a successful CI run.
- Circle previews are local UI drafts only; they are not persisted to a contract or broadcast to the network.

**Important:** the WizardConnect signing path compares the exact returned transaction with the approved inputs/outputs, requires the protocol's `0x61` sighash for wallet-owned P2PKH inputs, and evaluates the signed transaction against the exact supplied previous outputs using Libauth's BCH 2026 VM. The exact dependency is pinned to `@bitauth/libauth` `3.1.0-next.8`; this is an upstream prerelease, not a stable, independently audited verifier. The browser Mainnet reader and PUSD API now check the shared genesis, BCH's 2017 fork-specific block 478,559 checkpoint, and BCH's post-BSV-split block 556,767 checkpoint before trusting tips or UTXO state. They then cross-check tips, UTXO snapshots and raw previous-transaction bytes across two Electrum endpoints. This separates BCH from BTC and BSV endpoints that share earlier history, but it still does not prove provider-operator independence or SPV/chainwork validity. Mainnet remains read-only: the BCH quorum provider rejects broadcasting and the BCH/PUSD hard locks remain closed. CI now runs a targeted set of upstream BCH 2026 VMB vectors covering bitwise operations, functions, bounded loops, Pay-to-Script, and flow control; this is not the complete BCHN/VMB suite. Before real-value release, BLAZE still needs full consensus-vector evidence, independent review of the exact covenant artifacts, a dedicated idempotent BCH broadcaster with confirmation/reorg reconciliation, verified provider operators, shared operational controls, and live Selene/WizardConnect end-to-end testing.

## Requirements

- Node.js 22 or later
- npm

## Run locally

```bash
npm install
npm run dev
```

Vite prints the local development URL in the terminal.

## Quality checks

Run these before submitting changes:

```bash
npm run typecheck
npm test
npm run build
```

The GitHub Actions workflow runs the same checks on pushes to `main` and pull requests targeting `main`.

## Vercel deployment

The active BLAZE application is deployed from this repository through the dedicated Vercel project **`ajochain-blaze`**, linked only to `Afar88/ajochain-blaze`. Its stable URL is https://ajochain-blaze.vercel.app. Use this project for BLAZE previews and release verification; check the deployed commit SHA before testing.

The legacy app is isolated in the separate Vercel project **`ajochain-legacy`** (legacy recovery preview: **`ajochain-legacy-recovery`**), both linked only to `Afar88/Ajochain`. Their domains and environment-variable stores are separate from BLAZE. Never use a legacy deployment as evidence that BLAZE has shipped.

Backend separation is enforced too: BLAZE runs its own Vercel serverless API and has only its own `ELECTRUM_SERVERS` read-quorum configuration; it has no Neon/PostgreSQL connection. The legacy Vercel project alone has the legacy Neon/PostgreSQL integration. Never reuse its `DATABASE_URL`, `POSTGRES_*`, `PG*` or `NEON_*` variables for BLAZE. If BLAZE needs persistence later, provision a separate Neon project for BLAZE rather than pointing it at the legacy database. The legacy registry/recovery API remains design-only until implemented.

See [legacy porting and deployment boundaries](docs/LEGACY_REPO_PORTING_AND_DEPLOYMENTS.md) for the project-to-repository map and compatibility decisions. See [Mainnet readiness audit (16 Nov 2026)](docs/MAINNET_READINESS_AUDIT_2026-11-16.md) for the current findings and BCH launch sequence. See [shared Mainnet project-fee treasury](docs/PROJECT_FEE_TREASURY.md) and [PUSD CashToken integration status](docs/PUSD_CASHTOKEN_INTEGRATION.md) for the verified ParyonUSD category, two-decimal base-unit rules, and the still-blocked token-aware covenant work. See [WizardConnect and Selene integration](docs/WIZARDCONNECT_SELENE_PORT.md) for the mobile reconnect behaviour and signing safeguards. See [member accounting and circle completion](docs/MEMBER_ACCOUNTING_AND_CIRCLE_COMPLETION.md) for member contribution and payout rules.

## Mainnet launch status

The current deployment is a **Mainnet read-only release**, not an approved real-value circles release. Classic BCH Mainnet signing/broadcast and PUSD Mainnet spending remain fail-closed; the V2 full-cycle escrow remains Chipnet-only. BCH V3 has a separate Mainnet unsigned genesis-preview adapter, but Mainnet signing and broadcasting remain locked. The server cannot be switched to PUSD broadcasting with an environment variable. See [Mainnet release checklist](docs/MAINNET_RELEASE_CHECKLIST.md) and [PUSD Mainnet spending checklist](docs/PUSD_MAINNET_RELEASE_CHECKLIST.md) for the evidence required before any real-value release.

## Network and safety policy

Mainnet compatibility is a product goal; it is not permission to expose users to unaudited contracts or unsafe transactions.

- Use test networks for development and automated tests.
- Do not enable real-value circle creation, deposits, payouts, or contract deployment until the relevant contract and transaction flows have passed independent security review and end-to-end testing.
- Validate every input, output, token commitment, NFT commitment, amount, fee, and change output in the final signed transaction before broadcast.
- Never request, store, log, or transmit seed phrases or private keys.
- Clearly distinguish wallet connection from transaction authorization.
- Require explicit user confirmation for every transaction.

## Release gates

A mainnet-ready release requires all of the following:

1. Reproducible install, typecheck, test and production build.
2. Full CashAddress checksum and network validation using a maintained BCH library.
3. WizardConnect/Selene tests covering pairing, app switching, refresh, reconnect and relay interruption.
4. Independent decoding of the exact signed transaction bytes, including inputs, outputs, fee, change, CashToken and NFT data.
5. Compile and adversarially test the ported V2 member-receipt covenant, including post-payout obligations and member-specific carry-forward.
6. Independent contract review and accounting-invariant tests.
7. PUSD token category/decimals verification and wallet compatibility tests.
8. Independent end-to-end testing, monitoring and a documented incident/rollback plan.

Until those gates pass, transaction signing, broadcasting and real-value circle operations remain disabled.


## BCH, PUSD and member accounting

See [BCH, PUSD and member accounting](docs/BCH_PUSD_MEMBER_ACCOUNTING.md) for the 1% fee covenant, member-owned round-credit rules, verified receipt ledger, PUSD read-only balance API and current Mainnet safety gates.


The shared Mainnet project-fee destination for BCH and PUSD is `bitcoincash:zqtu3577x0swy2gsra6km3033xcj8swg8s4rld9w7q`. Chipnet circles retain their separate Chipnet fee address. PUSD Mainnet V3 contract and fee/reserve/cancellation tests are under active development; PUSD circle drafts remain local-only and Mainnet transaction signing/broadcast remains disabled pending the full planner, verifier, independent security review and operational release evidence.
