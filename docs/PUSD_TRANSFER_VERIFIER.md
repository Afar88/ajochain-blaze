# PUSD transfer verifier — scope and limitations

Status: **off-chain guard prototype; not a raw transaction decoder, signer, covenant, or production wallet integration**.

`src/core/pusd-transfer-verifier.ts` checks a fully decoded transaction summary for a deliberately narrow case: a plain fungible PUSD transfer with no NFTs and no other CashToken categories.

## What it checks

- Every supplied input outpoint is well-formed and unique.
- Only the canonical ParyonUSD category is accepted; any other token category is rejected.
- NFT-bearing inputs and outputs are rejected.
- PUSD fungible input and output totals are equal.
- The approved recipient receives exactly the requested amount.
- Any remaining PUSD is sent only to the explicitly approved token-change address.
- BCH input/output values balance to the supplied fee, and the fee is within the approved maximum.

## What it does not prove

- That the input/output list is complete or decoded correctly from the exact signed transaction bytes.
- That input UTXOs exist, are unspent, or are controlled by the expected wallet.
- That signatures are valid or that the transaction will be accepted by the network.
- That a covenant transition, state NFT, receipt NFT, minting capability, or circle payout is valid.
- That provider data is fresh or independently authenticated.

The caller must independently decode the exact transaction bytes and provide **all** inputs and outputs. Never treat a caller-supplied summary as proof of transaction validity. The verifier must run again against the final signed bytes before any future signing/broadcast integration.

## Deliberate restriction

This helper rejects all NFTs and all non-PUSD token categories. It is not suitable for the future circle covenant transaction, which will need a separate verifier that understands the exact circle NFT category, capabilities, commitments, and complete state transition. PUSD signing and broadcasting remain disabled.
