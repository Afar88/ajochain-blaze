# AjoChain — BCH Mainnet Build

AjoChain is an independent, non-custodial rotating savings-circle application being built for Bitcoin Cash.

This repository is the **independent BCH BLAZE build**. It is not a copy, mirror, or continuation branch of the frozen V1 release. The V1 repository and its deployed website remain separate and unchanged.

## Product direction

- Mainnet-first architecture for Bitcoin Cash.
- WizardConnect wallet connection for compatible BCH wallets, including Selene.
- BCH contributions are the current covenant prototype; PUSD CashToken metadata and exact amount handling are implemented as a local draft foundation, while token-aware covenant transfers remain blocked.
- Transparent circle schedules, member payment records, and per-member credit accounting.
- Mobile-first, accessible fintech UX.
- Clear transaction previews, fee visibility, and confirmation states.

## Current application status

- Responsive dashboard and local circle-preview form.
- Local circle drafts persist in the current browser and can be edited or deleted; they are not on-chain records.
- WizardConnect dapp relay integration with encrypted saved-session resume, mobile focus/visibility recovery, overlap protection, Selene receive-index matching and signed-transaction intent verification.
- BCH/Chipnet network selection and full CashAddress checksum + network-prefix validation.
- Member-level round-credit model with partial top-ups, member-owned carry-forward, duplicate protection and payout blocking until every member has funded their own round.
- Ported BCH V2 member-receipt covenant source in `contracts/AjoCircleV2.cash`; each payout consumes one round contribution from every member receipt, including the previous payout recipient.
- Unit tests are written for the member ledger, circle draft validation, checksummed network addresses and raw signed-transaction intent comparison. Their execution status, TypeScript build and CashScript compilation must be confirmed by a successful CI run.
- Circle previews are local UI drafts only; they are not persisted to a contract or broadcast to the network.

**Important:** the WizardConnect signing path now compares the exact returned transaction against the approved inputs/outputs, requires the protocol's `0x61` sighash for P2PKH wallet inputs, and evaluates the signed transaction against the exact planned source outputs. The browser Mainnet reader cross-checks BCH Mainnet genesis/tip, UTXO sets and raw previous-transaction bytes across two Electrum endpoints. These are meaningful safeguards, not a complete Mainnet release certificate: the pinned stable Libauth 3.0.0 VM is BCH 2023, while the active Mainnet rules since 15 May 2026 require a BCH_2026_05-compatible verifier. Libauth's BCH 2026 implementation is in its 3.1.0-next prerelease line, so real-value signing/broadcast stays locked until a stable compatible verifier, independent contract review, provider-operator verification and Selene/WizardConnect Mainnet end-to-end tests are complete.

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

## GitHub Pages preview

A separate workflow builds and deploys the static app to GitHub Pages on pushes to `main`. The Pages build uses the `/ajochain-blaze/` base path; local development and root-hosted deployments use `/`. The public Pages URL becomes available after the first successful deployment run.

See [PUSD CashToken integration status](docs/PUSD_CASHTOKEN_INTEGRATION.md) for the verified ParyonUSD category, two-decimal base-unit rules, and the still-blocked token-aware covenant work. See [WizardConnect and Selene integration](docs/WIZARDCONNECT_SELENE_PORT.md) for the mobile reconnect behaviour and signing safeguards. See [member accounting and circle completion](docs/MEMBER_ACCOUNTING_AND_CIRCLE_COMPLETION.md) for the rule that members must continue contributing after receiving a payout, and the V2 covenant design that blocks a round when any member is short.

## Mainnet launch status

The current deployment is a **Mainnet read-only release**, not an approved real-value circles release. Classic BCH Mainnet signing/broadcast and PUSD Mainnet spending remain fail-closed; the V2 member-credit covenant remains Chipnet-only. The server cannot be switched to PUSD broadcasting with an environment variable. See [Mainnet release checklist](docs/MAINNET_RELEASE_CHECKLIST.md) and [PUSD Mainnet spending checklist](docs/PUSD_MAINNET_RELEASE_CHECKLIST.md) for the evidence required before any real-value release.

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
