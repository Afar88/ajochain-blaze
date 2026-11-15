# PUSD transfer verification guards

This verifier is an off-chain guard for a plain fungible PUSD transfer. It is not a raw transaction decoder, UTXO provider, signature verifier, covenant, or broadcast authorization.

## Required intent

- Exact recipient address and raw PUSD amount.
- Separate PUSD token-change address.
- Optional, distinct BCH-only change address. If omitted, BCH outputs remain restricted to the recipient and PUSD change destinations.
- Maximum miner fee in satoshis.

## Checks

- Exact PUSD category and fungible amount conservation.
- Exact recipient amount and token-change remainder.
- Rejects NFTs, unexpected token categories, duplicate inputs, malformed outpoints, invalid amounts, and negative BCH values.
- Every BCH output must go to an explicitly approved destination.
- BCH input/output accounting must match the reported fee and remain below the approved maximum.

## Critical limitations

The caller must still obtain complete decoded inputs and outputs from the exact raw transaction bytes and authenticate every prevout against a trusted, fresh source. This verifier does not prove that a UTXO is unspent, that an indexer response is fresh, that signatures are valid, or that the transaction is accepted by the network. It does not verify PUSD circle/covenant transitions or NFT receipt logic.

Do not use this helper alone to authorize Selene signing or mainnet broadcast. Mainnet spending remains disabled until provider authentication/freshness, raw transaction and prevout verification, complete BCH carrier/fee/change planning, wallet-signature validation, and independent contract review are complete.
