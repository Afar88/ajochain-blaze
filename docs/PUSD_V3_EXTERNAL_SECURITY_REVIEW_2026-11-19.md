# PUSD V3 Mainnet external security review handoff

**Prepared:** 2026-11-19  
**Review target:** immutable source commit `4a11acd7697e3d00acb48dad3219ece784f922ac` on `main`  
**Release status:** READ-ONLY; PUSD Mainnet spending is not approved.  
**Purpose:** handoff for a qualified independent BCH/CashTokens/CashScript security reviewer. This document is not an audit report or release approval.

## 1. Exact review target and compiled artifacts

The target is the exact commit above, not the current tip of a moving branch. The fingerprints below were emitted by the successful CI run for that commit using CashScript compiler `cashc 0.14.0` with function parameter type enforcement and locktime guard enforcement.

### PUSD Mainnet V3 circle

- Source: `contracts/AjoCirclePUSDV3Mainnet.cash`
- Source SHA-256: `966109765d41513116c85556822ffea4694fb9d2040ea24563d54e66fbcccc00`
- Compiled artifact: `contracts/AjoCirclePUSDV3Mainnet.json`
- Artifact JSON SHA-256: `ca045455497016cdb7e662ebc7bb5dca4b6c6ca983b7e51b53483fb8b97daa11`
- Stable artifact SHA-256: `729c24f7d93c00fc36bf8738e71fd5f84bb941bc13b086f7858dd024293927f9`
- Compiled bytecode ASM SHA-256: `5da8a3bb02bb9f10dfc9e1b9d0fa8b6314ca7552a39ef38e9a9f1fea3670852d`
- Constructor inputs: 17; ABI functions: 3.

### PUSD Mainnet V3 member escrow

- Source: `contracts/AjoPUSDMemberEscrowV3.cash`
- Source SHA-256: `42b4415cc27a7168aaefeb06a01c2dea0d4e77f4988d582cd4d41cf60c0634fe`
- Compiled artifact: `contracts/AjoPUSDMemberEscrowV3.json`
- Artifact JSON SHA-256: `23cd5fdb9baebf49d809ae2662ce2760ce14e58ea3b36e1a2c77286e38440be6`
- Stable artifact SHA-256: `5aa2cb179946ce1e72bb87a4c7c0356dba804eadb23a879cd8faced179334afb`
- Compiled bytecode ASM SHA-256: `a9b2bf5e2bb74776151f8f44eeb4fc42e01e60ddea2f883387d4676de23f8620`
- Constructor inputs: 6; ABI functions: 2.

The reviewer should independently reproduce these fingerprints from the exact commit and state explicitly whether the source, artifact JSON, bytecode and constructor values all match.

## 2. Automated validation evidence

GitHub Actions run [44596419723](https://github.com/Afar88/ajochain-blaze/actions/runs/44596419723) ran on commit `4a11acd7697e3d00acb48dad3219ece784f922ac` and completed successfully on 2026-11-19.

- `npm install`: completed.
- Production dependency audit: 0 vulnerabilities (info/low/moderate/high/critical).
- Full dependency-tree audit: 0 vulnerabilities (info/low/moderate/high/critical).
- `npm run typecheck`: passed, including CashScript compilation and TypeScript build.
- Mainnet contract artifact fingerprint check: passed.
- `npm test`: passed; Node test runner reported 50 tests and Vitest reported 40 files / 310 tests passed.
- `npm run build`: passed.
- BCH 2026 targeted upstream consensus-vector suite and sparse-fixture full-discovery smoke test: passed.

This is automated validation, not proof that the contract is safe or a substitute for external security review.

## 3. Changes addressing the 2026-11-19 audit findings

The findings-only audit was recorded in [PR #69](https://github.com/Afar88/ajochain-blaze/pull/69).

- [PR #70](https://github.com/Afar88/ajochain-blaze/pull/70), merged: BCH Mainnet verifier now accepts and checks the four-output final-close layout used by the BCH V3 contract. Devin Review reported no issues on that PR.
- [PR #71](https://github.com/Afar88/ajochain-blaze/pull/71), merged: PUSD V3 final payout now closes the circle, burns the state and receipt NFTs, returns member escrow/receipt BCH backing and the initiator state backing, and requires exact one-contribution credits on the final round. PUSD payout fee sponsorship is no longer restricted to the initiator; sponsor change returns to the sponsor.
- PUSD regression tests cover closure leaving no circle/escrow UTXOs, exact BCH backing refunds, final PUSD payout, rejection of short or redirected refunds, and non-initiator fee sponsorship with sponsor-only change.
- Devin Review on PR #71 identified a completed-circle activity-history display issue; the review thread records it as fixed and resolved. This was a code-review bot finding, not an independent human security audit.

These fixes are present in the review target commit. The external reviewer must retest them against the target source and exact compiled artifacts rather than relying on this summary.

## 4. Scope the reviewer must cover

Review the complete transaction path, not only the covenant functions.

### Circle and escrow covenant invariants

Review every constructor argument and every function in:

- `contracts/AjoCirclePUSDV3Mainnet.cash`
- `contracts/AjoPUSDMemberEscrowV3.cash`

Adversarially verify:

- State NFT genesis category, minting capability, commitments and irreversible round progression.
- Receipt NFT member indexes, credit commitments, ordering and state/receipt binding.
- Per-member escrow contract bindings, token category/amount and BCH carrier values.
- Genesis output ordering and proof that one state NFT, one receipt per member, and one empty escrow sidecar per member are created at the intended scripts and indexes.
- Deposit limits, exact PUSD credit accumulation, excess-token change, no-credit and zero-credit cases.
- Normal payout credit conservation, reserve carry-forward, final recipient no-reserve behavior and exact 1% treasury fee.
- Final close: exact-credit preconditions, PUSD conservation, burning of every state/receipt NFT, member-specific escrow-plus-receipt BCH refunds, initiator state-BCH refund and fee-sponsor change.
- Initiator-only pre-first-payout cancellation, refund conservation and rejection after any payout.
- Duplicate/missing/reordered inputs, malformed commitments, unauthorized member substitutions, wrong token categories, NFT-bearing PUSD, integer limits, dust thresholds and miner-fee boundaries.
- Replay, double-spend races, conflicting spends and reorg effects.

### Client planner and wallet-signing path

Review:

- `src/core/pusd-mainnet-circle.ts`
- `src/components/PusdMainnetCircleWorkspace.tsx`
- `src/core/wizard-wallet.ts`
- `src/core/pusd-mainnet-guard.ts`

The PUSD workspace currently constructs genesis/deposit/payout/cancel plans and can ask Selene/WizardConnect to sign a review transaction. It then checks the signed bytes locally for exact input/output equality, required sighashes and BCH 2026 VM validity, and discards the signed bytes. It does not broadcast PUSD circle transactions.

The generic browser wallet verifier should be challenged for transaction version/locktime, every input outpoint and sequence, exact serialized outputs and CashTokens, source-output binding, P2PKH input coverage, P2PKH and covenant sighash parsing, and BCH 2026 VM checks. Review receive/change derivation, active wallet address/session changes, reconnects and network identity.

### Mainnet UTXO and API path

Review:

- `src/core/classic-bch.ts`
- `src/core/mainnet-quorum-provider.ts`
- `src/core/pusd-api.ts`
- `server/mainnet-api.mjs`
- `server/mainnet-api.node.mjs`
- `api/pusd/*`

The Mainnet CashScript provider is constructed from two Electrum endpoints (`bch.imaginary.cash` and `electroncash.dk`) through `MainnetQuorumNetworkProvider`. The presence of two hostnames is not proof of separate operators or independent infrastructure. Confirm operator identity, ownership and fault-domain separation.

A critical outstanding scope item is that the PUSD **circle** path does not yet have a dedicated server-side signed-byte verifier for all state/receipt/escrow and wallet inputs, authenticated prevouts, token categories/amounts, NFT commitments, outputs, change and fee. The current circle workspace's signing check is local-only and discards the resulting signed bytes. The separate PUSD wallet-transfer verification/broadcast path is not a substitute for a verifier that understands the PUSD circle contract lifecycle.

Independently assess raw previous-transaction authentication, exact outpoint/index and locking-script binding, pagination completeness, quorum agreement, tip freshness, immediate pre-authorization/pre-broadcast unspent checks, token/NFT policy, carrier dust and fee calculation.

## 5. Known release gates that remain open

The repository's `docs/PUSD_MAINNET_RELEASE_CHECKLIST.md` remains authoritative and unchecked. In particular:

1. Confirm ParyonUSD issuer-controlled token category, decimals, supply/amount policy, NFT policy, allowed address types, and issuer freeze/blacklist or recovery controls. The category in code is `2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544`; the two-decimal display assumption still needs authoritative confirmation against the deployed asset.
2. Obtain evidence that the Electrum operators and fault domains are genuinely independent.
3. Implement and independently review the PUSD circle server-side signed-byte/prevout verifier described above.
4. Provision and test the dedicated private durable submission ledger and shared rate-limit backing store. Do not put private credentials in client code.
5. Complete independent Selene/WizardConnect lifecycle tests with separate member wallets, including reconnect, timeout, app switching, cancellation, exact signed bytes and confirmation.
6. Define and test unknown-result reconciliation, mempool conflict handling, confirmations, reorg handling, alerting, incident response and manual recovery for input locks.
7. Obtain external security approval for the exact source commit and compiled artifacts in this handoff.
8. Repository control: at the time of this review, GitHub reports `main` as unprotected with no required status checks. Protect the branch and require successful CI before future release commits; a green run on this SHA does not enforce checks on later commits.

## 6. Current safety state

- `src/core/pusd-mainnet-guard.ts`: `PUSD_MAINNET_SPENDING_ENABLED = false`.
- `server/mainnet-api.mjs`: `MAINNET_BROADCAST_ENABLED = false`.
- The PUSD circle workspace is a plan/local-verification preview; it does not broadcast circle transactions.
- The separate BCH Mainnet send path has its own gate and is outside the authorization of this PUSD review.
- No real PUSD Mainnet activity was performed as part of the CI run or this handoff.

**Do not enable PUSD Mainnet spending, deploy PUSD circle scripts for real funds, or send PUSD/BCH to these prototype contract addresses while any release gate remains open.**

## 7. Required external reviewer deliverables

The reviewer should return:

- Reviewer identity, organisation and relevant BCH/CashTokens/CashScript audit experience.
- Exact commit SHA and reproduced source/artifact/bytecode hashes reviewed.
- Scope, tools, compiler/VM versions, methodology and test environment.
- Findings with severity, exploit preconditions, impact, reproduction steps and affected artifact/function.
- Adversarial test cases or proof-of-concept evidence for each finding.
- Fix/retest status and any residual risk.
- Explicit written approval or rejection for each contract artifact and the complete wallet/transaction path.
- Excluded areas, assumptions and limitations.

Passing CI and automated pull-request review are supporting evidence only. They are not independent security approval.
