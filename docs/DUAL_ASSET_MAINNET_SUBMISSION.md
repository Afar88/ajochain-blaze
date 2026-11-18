# AjoChain BLAZE — dual-asset submission guide

**Submission target:** 20 November 2026  
**Release scope:** BCH + PUSD, presented together  
**Network scope:** BCH Mainnet planning and read-only inspection; Chipnet BCH test workflow

## What the reviewer can see

On the Mainnet network, the Create a circle page now presents both asset workspaces together:

- **BCH automatic-reserve circle:** prepares a Mainnet genesis preview and unsigned member-deposit, payout and pre-payout cancellation plans; it can read/reconcile a saved circle against the Mainnet read quorum.
- **PUSD stable-value circle:** uses the canonical ParyonUSD Mainnet CashToken category and prepares unsigned genesis, member-deposit, payout and pre-payout cancellation plans; it can read/reconcile the circle state, member receipts and escrow sidecars.
- **PUSD asset view:** reads authenticated PUSD UTXOs through the configured Mainnet provider quorum and prepares a transfer preview.

BCH and PUSD are separate asset paths. PUSD uses the real Mainnet category; it is not represented by test BCH and is not enabled on Chipnet. The Chipnet circle workflow remains the test environment for BCH contract interactions.

## What is not enabled

This build is **not a real-value Mainnet launch**. The planners produce unsigned transactions only:

- BCH Mainnet signing and broadcasting are blocked by `BCH_MAINNET_OPERATIONS_ENABLED = false`.
- PUSD Mainnet spending is blocked by `PUSD_MAINNET_SPENDING_ENABLED = false`.
- The server relay is separately compile-time disabled by `MAINNET_BROADCAST_ENABLED = false`.
- The BCH Mainnet quorum provider is read-only and rejects `sendRawTransaction`.
- PUSD circle/escrow contracts remain prototypes pending independent review.
- A prepared plan, saved local draft, wallet connection, relay acceptance or CI pass is not evidence of a confirmed on-chain circle.

Do not send real BCH or PUSD to the prototype scripts or treat a preview as a payment.

## Remaining release evidence

Before opening real-value operations for either asset, the release owner must attach independent evidence for the exact source commit and compiled contract artifacts, including:

1. External security review and adversarial testing of both BCH and PUSD covenant/escrow artifacts.
2. Verified Mainnet transaction signing, exact signed-byte inspection, and fresh authenticated UTXO checks.
3. A release-approved broadcaster with one-shot/idempotent submission, unknown-result reconciliation, mempool-conflict handling and independent confirmation/reorg recovery.
4. Independent verification of the configured Electrum operators and the Mainnet chain trust model.
5. Real Selene/WizardConnect tests with separately controlled member wallets, covering pairing, app switching, reconnect, signatures, cancellation and payout.
6. Monitoring, alerting, rate limiting, incident response, emergency stop and rollback evidence.
7. Issuer-controlled confirmation of PUSD category metadata, decimals and token policy for the exact asset category.

Passing Chipnet tests is necessary development evidence, but it does not substitute for these Mainnet-specific checks or an independent audit.

## Suggested submission wording

> AjoChain BLAZE is a non-custodial rotating savings-circle prototype for Bitcoin Cash, with BCH and ParyonUSD (PUSD) Mainnet planning workspaces presented together. The BCH Chipnet workflow demonstrates the test-network circle lifecycle. Mainnet workspaces provide chain inspection and unsigned transaction planning while real-value signing and broadcasting remain guarded pending independent security and operational release evidence.

This wording describes the current code without claiming that Mainnet deposits or payouts are live.
