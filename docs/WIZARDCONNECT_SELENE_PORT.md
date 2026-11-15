# WizardConnect and Selene wallet integration

This integration ports the proven dapp-side wallet manager from the frozen AjoChain release into this independent repository. The frozen repository itself is not modified.

## What is included

- WizardConnect relay initiation and DappConnectionManager session handling.
- Resume using the saved encrypted WizardConnect session credentials.
- Mobile recovery on `focus`, `online`, `pageshow` and visible `visibilitychange`.
- A five-second resume throttle so several browser lifecycle events do not create parallel relays.
- Connection generation guards to ignore stale callbacks after a reconnect or deliberate disconnect.
- Watchdog feedback when Selene does not respond to a saved-session attempt.
- A deliberate fresh-pairing path that clears a stalled saved session.
- Cached public derivation paths and selected receive index; no seed phrase or private key is read by AjoChain.
- Receive-address derivation from the wallet-provided public key and Selene address matching over indices 0–50.
- CashScript transaction serialization for WizardConnect, including source-output serialization.
- Signed transaction decoding and intent comparison before any broadcast path.

## User-visible behaviour

Closing the pairing dialog does not disconnect the wallet. A dropped relay is treated as an interruption, not as a user-requested disconnect. When the browser returns from Selene, the app attempts to restore the existing session. If it remains unresponsive, the user can explicitly start a fresh pairing. Wallet details expose the derived receive address and allow matching it to the address Selene displays.

## Security boundary

The current app does not call the signing method or broadcast transactions. The ported manager has a sign-and-verify method for future integration, but it deliberately does not broadcast. Before enabling signing, transaction review must additionally inspect all input prevouts, output scripts and values, fees, change, CashToken categories/amounts/NFT commitments, and required BCH sighash flags. A decoded transaction-intent match alone is not sufficient.

Never store or request wallet seed phrases or private keys. The saved WizardConnect session is handled by the WizardConnect dapp manager; cached paths and receive addresses are public data only.

## Required mobile E2E checks

1. Pair from AjoChain to Selene and approve.
2. Confirm the displayed address matches Selene, including a non-zero receive index.
3. Background AjoChain, return from Selene, and confirm the same session recovers without a new pairing.
4. Repeat with browser refresh, offline/online transition, and relay interruption.
5. Verify several rapid focus/visibility events do not create duplicate connections.
6. Deliberately disconnect and confirm the saved session is cleared.
7. Expire a saved session and confirm the fresh-pairing path works.
8. Confirm network switching changes the derived CashAddress prefix and refuses a pasted address from the other network.

These are acceptance tests; they have not yet been run against a live Selene wallet from this new repository.


## Protocol API alignment

The adapter now follows the current WizardConnect dapp API:
- Uses `DappConnectionManager.sendSignRequest()` and `nextSequence()` for signing request/response correlation.
- Uses the protocol `sign_transaction_request` envelope with `time`, `inputPaths`, and BCH transaction/source-output data.
- Requests signatures only; `broadcast: false` remains explicit.
- Requires `SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_UTXOS` on every wallet-signed input. The wallet's enforcement must be confirmed with Selene integration tests before any signing flow is enabled.
- The app's wallet modal displays the derived address for the selected network and supports matching the receive address shown in Selene across indices 0–50.
