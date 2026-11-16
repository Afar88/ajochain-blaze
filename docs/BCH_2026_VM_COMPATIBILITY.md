# BCH 2026 VM compatibility in AjoChain BLAZE

**Status:** compatibility implementation added on the BLAZE feature branch; full feature-branch CI and external consensus review still required.

## Why the change is required

The BCH May 15, 2026 Mainnet upgrade activated bounded loops (`OP_BEGIN`/`OP_UNTIL`), functions, bitwise operations and Pay-to-Script. The same upgrade activated on Chipnet in November 2025. A verifier fixed to the BCH 2023 instruction set is not sufficient for transactions spending scripts that use the newly activated operations.

Official specifications:
- https://upgradespecs.bitcoincashnode.org/2026-05-15-upgrade/
- https://github.com/bitcoin-cash-node/bitcoin-cash-node/releases/tag/v29.0.0

## BLAZE implementation on this feature branch

The exact Libauth dependency is pinned to `3.1.0-next.8`, because that upstream prerelease contains the BCH 2026 VM API used here. It remains a prerelease; the pin must not be silently broadened to `^3.x`.

The active VM is `createVirtualMachineBch2026` in all transaction-verification paths on this feature branch:

- `src/core/wizard-wallet.ts`: validates the exact WizardConnect-returned transaction against supplied source outputs, while retaining input-intent comparison and the wallet's required `0x61` sighash check for locally controlled P2PKH inputs.
- `src/core/pusd-signed-transaction.ts`: verifies the signed PUSD spend and the exact raw previous outputs with the BCH 2026 VM after independent outpoint, category, token conservation, address and fee checks.
- `server/mainnet-api.mjs`: uses the BCH 2026 VM for its server-side PUSD signed-transaction verifier.

Regression coverage:
- `src/core/bch-2026-vm.test.ts` confirms a bounded-loop transaction succeeds under the BCH 2026 VM and fails under the 2023 VM; it also checks the wallet verifier path.
- `src/core/pusd-signed-transaction.test.ts` exercises a PUSD spend whose wallet-controlled previous output uses bounded-loop bytecode.

## Remaining requirements

This compatibility change is necessary but not a Mainnet-readiness certification:
- Run the upstream VMB consensus vectors against the exact package used in production and retain the passing report.
- Review the upstream prerelease status and dependency integrity before production pinning.
- Independently validate the actual compiled AjoChain covenant artifacts under the same VM.
- Complete the missing fresh-state, fee/carrier, idempotent relay, confirmation and reorg protections.
- Complete independent contract review and real Selene/WizardConnect E2E tests.
- Do not enable BCH or PUSD broadcast. The BCH kill-switch, PUSD client spend guard, server `MAINNET_BROADCAST_ENABLED` and read-only Mainnet quorum provider remain unchanged.

This document describes the feature-branch code only. PR #9 remains a separate integration/release decision.
