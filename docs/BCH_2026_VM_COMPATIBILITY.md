# BCH 2026 VM compatibility in AjoChain BLAZE

**Status:** BCH 2026 VM compatibility is present on `main` (including commit `350e4b7c9fe206c5c6702ad5c57774c5789a1402`). Full BCHN/VMB consensus-vector evidence, dependency provenance review and independent consensus review are still outstanding.

## Why the change is required

The BCH May 15, 2026 Mainnet upgrade activated bounded loops (`OP_BEGIN`/`OP_UNTIL`), functions, bitwise operations and Pay-to-Script. The same upgrade activated on Chipnet in November 2025. A verifier fixed to the BCH 2023 instruction set is not sufficient for transactions spending scripts that use the newly activated operations.

Official specifications:
- https://upgradespecs.bitcoincashnode.org/2026-05-15-upgrade/
- https://github.com/bitcoin-cash-node/bitcoin-cash-node/releases/tag/v29.0.0

## BLAZE implementation on `main`

The exact Libauth dependency is pinned to `3.1.0-next.8`, because that upstream prerelease contains the BCH 2026 VM API used here. It remains a prerelease; the pin must not be silently broadened to `^3.x`. As checked on **2026-11-17**, the upstream [Libauth release list](https://github.com/bitauth/libauth/releases) still identifies `v3.1.0-next.8` as the latest published release and marks it as a prerelease; the latest stable release shown is `v3.0.0`. Keep the prerelease version exact and require provenance review before any production dependency change.

The active VM is `createVirtualMachineBch2026` in all transaction-verification paths on `main`:

- `src/core/wizard-wallet.ts`: validates the exact WizardConnect-returned transaction against supplied source outputs, while retaining input-intent comparison and the wallet's required `0x61` sighash check for locally controlled P2PKH inputs.
- `src/core/pusd-signed-transaction.ts`: verifies the signed PUSD spend and the exact raw previous outputs with the BCH 2026 VM after independent outpoint, category, token conservation, address and fee checks.
- `server/mainnet-api.mjs`: uses the BCH 2026 VM for its server-side PUSD signed-transaction verifier.

Regression coverage:
- `src/core/bch-2026-vm.test.ts` confirms a bounded-loop transaction succeeds under the BCH 2026 VM and fails under the 2023 VM; it also checks the wallet verifier path.
- `src/core/pusd-signed-transaction.test.ts` exercises a PUSD spend whose wallet-controlled previous output uses bounded-loop bytecode.

## Targeted upstream VMB coverage in BLAZE CI

The CI workflow checks a selected set of upstream Libauth BCH 2026 VMB fixtures, pinned to source commit `d28da7f595cbd747c1e1125477db655f740f3dbc` (the source for the exact `3.1.0-next.8` verifier line). It covers standard, nonstandard and invalid outcomes for bitwise operations, functions, bounded loops, Pay-to-Script and flow control. The workflow runs both standard and nonstandard BCH 2026 VM policies and checks each vector against its upstream expected outcome.

This targeted subset is intentionally small enough to run on every BLAZE CI build. It is not the complete Libauth/BCHN VMB corpus and does not replace BCHN integration tests or external review.

## Full upstream VMB audit (manual)

The pinned Libauth source commit `d28da7f595cbd747c1e1125477db655f740f3dbc` contains 164 BCH 2026 VMB fixture files (about 268 MB) across standard, nonstandard and invalid cases. BCHN `v29.2.0` includes the same 164 files; all 164 corresponding Git blob hashes match the pinned Libauth fixture set. The separate `.github/workflows/bch-2026-full-vmb.yml` workflow can be started manually or triggered by pushing a commit to the dedicated `audit/bch-2026-full` branch. The dedicated branch is intended to launch and retain the complete audit without adding the 268 MB fixture download and BCHN source build to normal per-push CI. One job checks out the complete pinned Libauth fixture tree and runs this verifier with `--full`; a second builds the BCHN `v29.2.0` `test_bitcoin` binary with the documented Linux test dependencies and runs `libauth_tests/upgrade12_2026` under BCHN's upgrade-activated test configuration. That native test pack loads and checks all 164 BCH 2026 fixtures. Both jobs must pass for the two-implementation corpus check to be considered complete. The regular per-push CI remains on the smaller targeted subset to keep normal builds quick, and also smoke-tests the `--full` discovery path against that same sparse fixture checkout. The manual workflow uses a complete checkout, so only that manual run evaluates all 164 files. The BCHN job exercises the same fixture files using BCHN's own consensus interpreter and standardness policy, providing an independent implementation cross-check. This is still not an external security audit of AjoChain's covenants or proof of Mainnet operational readiness.

## Remaining requirements

This compatibility change is necessary but not a Mainnet-readiness certification:
- Run the manual full-corpus VMB audit and retain its report. Separately run BCHN integration checks against a pinned, current BCHN release and the exact compiled covenant artifacts intended for Mainnet; retain those reports.
- Review the upstream prerelease status and dependency integrity before production pinning.
- Independently validate the actual compiled AjoChain covenant artifacts under the same VM.
- Complete the missing fresh-state, fee/carrier, idempotent relay, confirmation and reorg protections.
- Complete independent contract review and real Selene/WizardConnect E2E tests.
- Do not enable BCH or PUSD broadcast. The BCH kill-switch, PUSD client spend guard, server `MAINNET_BROADCAST_ENABLED` and read-only Mainnet quorum provider remain unchanged.

This document describes the code currently on `main`. Its inclusion on `main` does not approve real-value Mainnet signing or broadcasting.
