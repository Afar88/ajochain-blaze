# AjoChain — BCH Mainnet Build

AjoChain is an independent, non-custodial rotating savings-circle application being built for Bitcoin Cash.

This repository is the **independent BCH BLAZE build**. It is not a copy, mirror, or continuation branch of the frozen V1 release. The V1 repository and its deployed website remain separate and unchanged.

## Product direction

- Mainnet-first architecture for Bitcoin Cash.
- WizardConnect wallet connection for compatible BCH wallets, including Selene.
- BCH contributions and PUSD/CashToken support once token metadata, wallet behavior and transaction handling are verified.
- Transparent circle schedules, member payment records, and per-member credit accounting.
- Mobile-first, accessible fintech UX.
- Clear transaction previews, fee visibility, and confirmation states.

## Current application status

- Responsive dashboard and local circle-preview form.
- WizardConnect pairing UI and session persistence.
- BCH/Chipnet network selection and a basic CashAddress prefix sanity guard.
- Member-level contribution ledger using integer base units, with leftover credit and idempotent payment keys.
- Unit tests for the ledger, circle draft validation, network prefix guard and transaction-intent comparison.
- Circle previews are local UI drafts only; they are not persisted to a contract or broadcast to the network.

**Important:** the address prefix helper is not a full CashAddress checksum validator. The transaction-intent comparator consumes an already decoded transaction summary; it is not a raw transaction decoder. Neither one is sufficient to authorize a real transaction.

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
5. Contract review and accounting-invariant tests.
6. PUSD token category/decimals verification and wallet compatibility tests.
7. Independent end-to-end testing, monitoring and a documented incident/rollback plan.

Until those gates pass, transaction signing, broadcasting and real-value circle operations remain disabled.
