# AjoChain — BCH Mainnet Build

AjoChain is a non-custodial rotating savings-circle application being built for Bitcoin Cash.

This repository is the **independent BCH BLAZE build**. It is not a copy, mirror, or continuation branch of the frozen V1 release. The V1 repository and its deployed website remain separate and unchanged.

## Product direction

- Mainnet-first architecture for Bitcoin Cash.
- WizardConnect wallet connection, with explicit support for compatible Selene wallet flows.
- BCH contributions and PUSD/CashToken support where token standards and wallet capabilities are verified.
- Transparent circle schedules, member payment records, and per-member credit accounting.
- Mobile-first, accessible fintech UX.
- Clear transaction previews, fee visibility, and confirmation states.

## Network and safety policy

Mainnet compatibility is a product goal; it is not permission to expose users to unaudited contracts or unsafe transactions.

- Use test networks for development and automated tests.
- Do not enable real-value circle creation, deposits, payouts, or contract deployment until the relevant contract and transaction flows have passed independent security review and end-to-end testing.
- Validate every input, output, token commitment, NFT commitment, amount, and change output in the final signed transaction before broadcast.
- Never request, store, log, or transmit seed phrases or private keys.
- Clearly distinguish wallet connection from transaction authorization.
- Require explicit user confirmation for every transaction.

## Development

The repository is being established as a clean, independent implementation. Setup instructions, supported network configuration, contract architecture, and test commands will be documented as the implementation lands.

## Release principle

A mainnet-ready release requires reproducible builds, automated tests, independent wallet testing, transaction verification, contract review, monitoring, and a documented incident/rollback plan. Until those gates pass, mainnet transaction execution remains disabled.
