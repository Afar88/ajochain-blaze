# WizardConnect integration notes

AjoChain uses WizardConnect as its required BCH wallet connection protocol. WalletConnect is not used as a fallback.

## Current implementation
- React integration uses `@wizardconnect/react` and its `useWizardConnect` hook.
- The app requests a connection URI and displays the official QR dialog.
- The connection UI reports the wallet name and connection state.
- Session persistence uses the AjoChain-specific key `ajochain-wizardconnect-session`.
- Disconnect is exposed to the user.
- Connection alone does not authorize any transaction.

## Remaining integration work
1. Derive the BCH receive address from the negotiated `hdwalletv1` receive xpub using a maintained BCH derivation implementation.
2. Validate the derived address against the selected network and show the exact address.
3. Verify the selected network against wallet/network data; never infer mainnet merely from a UI dropdown.
4. Build a transaction intent from trusted UTXO data and decode the wallet-returned signed raw transaction independently.
5. Enforce `SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_UTXOS` on every wallet-signing input.
6. Compare all signed inputs, outputs, source outputs, fee, change, CashToken category/amount and NFT fields to the approved intent before any broadcast.
7. Exercise fresh pairing, app switching, browser refresh, relay interruption, wallet-initiated reconnect, and duplicate sign responses with Selene on Android and iOS.

## Safety
Signing and broadcasting stay disabled. A successful WizardConnect handshake is not proof that a wallet address, network, transaction or contract is safe. Do not enable real BCH or PUSD circle operations until independent end-to-end tests and contract review pass.

## Protocol references
- https://docs.riftenlabs.com/wizardconnect/
- https://docs.riftenlabs.com/wizardconnect/dapp/
- https://docs.riftenlabs.com/wizardconnect/react/
- https://docs.riftenlabs.com/wizardconnect/protocol/
