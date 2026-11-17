# BCH 2026 VM compatibility in AjoChain BLAZE

**Status:** BCH 2026 VM compatibility is present on `main`. The full upstream Libauth/BCHN BCH 2026 corpus audit passed on 2026-11-17; dependency provenance review, AjoChain-specific compiled-covenant vectors and independent security/consensus review remain outstanding.

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

## Full upstream VMB audit result (2026-11-17)

**Audit result: both generic VM corpus checks passed.**

The full audit ran on the dedicated `audit/bch-2026-full` branch. BCHN `v29.2.0` and the pinned Libauth source commit `d28da7f595cbd747c1e1125477db655f740f3dbc` contain the same 164 BCH 2026 VMB fixture files; all 164 corresponding Git blob hashes match.

- **Libauth:** all **29,731 vectors across 164 fixture files** passed for standard and nonstandard BCH 2026 VM policies.
- **BCHN:** the native `test_bitcoin` `libauth_tests/upgrade12_2026` test case passed with **1,065,105 / 1,065,105 assertions**.
- **Evidence:** [successful full audit run](https://github.com/Afar88/ajochain-blaze/actions/runs/43994936516), pinned [BCHN v29.2.0](https://github.com/bitcoin-cash-node/bitcoin-cash-node/releases/tag/v29.2.0), and pinned [Libauth source commit](https://github.com/bitauth/libauth/commit/d28da7f595cbd747c1e1125477db655f740f3dbc).

This verifies the generic upstream BCH 2026 VM vectors against both implementations. It does **not** yet test AjoChain-specific transactions spending every exact compiled legacy and guarded covenant artifact, and it is not an external contract security audit or proof of Mainnet operational readiness.

## Remaining requirements

This compatibility change is necessary but not a Mainnet-readiness certification:
- Add AjoChain-specific fixtures for every exact compiled legacy and guarded covenant artifact intended for Mainnet, then run those fixtures against BCHN and Libauth and retain the reports. The generic upstream 2026 corpus comparison passed on 2026-11-17 (29,731 Libauth vectors and 1,065,105 BCHN assertions; [audit run](https://github.com/Afar88/ajochain-blaze/actions/runs/43994936516)).
- Review the upstream prerelease status and dependency integrity before production pinning.
- Independently validate the actual compiled AjoChain covenant artifacts under the same VM.
- Complete the missing fresh-state, fee/carrier, idempotent relay, confirmation and reorg protections.
- Complete independent contract review and real Selene/WizardConnect E2E tests.
- Do not enable BCH or PUSD broadcast. The BCH kill-switch, PUSD client spend guard, server `MAINNET_BROADCAST_ENABLED` and read-only Mainnet quorum provider remain unchanged.

This document describes the code currently on `main`. Its inclusion on `main` does not approve real-value Mainnet signing or broadcasting.
