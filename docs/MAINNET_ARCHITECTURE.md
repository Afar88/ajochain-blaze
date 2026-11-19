# Mainnet Architecture and On-Chain Discovery

## Source of truth

Bitcoin Cash is the source of truth for circle identity, ordered membership, covenant state, CashToken state and member receipts, escrow outputs, contributions and confirmed payouts.

BLAZE does not use a central application database or circle registry. It does not require Neon, Postgres, Redis or a conventional backend to discover circles.

## Architecture

1. **Wallet and presentation** — Selene/WizardConnect connects the member's wallet. BLAZE derives the member's public receive/change addresses and keeps wallet authorization in the wallet.
2. **On-chain discovery** — the browser reads the connected wallet's BCH transaction history through Electrum, downloads candidate raw transactions, checks transaction IDs, parses the discovery note, checks category/state/receipt/marker outputs and rebuilds the covenant script. The candidate is accepted only when the connected wallet is an on-chain member.
3. **Chain providers** — Electrum endpoints provide transaction history, UTXOs, raw transactions and fee/tip data. They are transport and data sources, not a circle database or source of truth.
4. **Circle state and accounting** — state NFTs, member receipt NFTs, escrow outputs and confirmed transactions determine the current circle state. Browser storage is only a local convenience cache.
5. **Transaction planning and wallet signing** — the app builds the version-specific transaction; the member reviews and signs in Selene/WizardConnect.
6. **Verification** — transaction bytes, previous outputs, token categories, NFT capabilities, commitments, sighashes and covenant execution are checked against the exact plan.
7. **Broadcast and confirmation** — the dedicated BCH V3 Mainnet path uses its separate route and guard. A transaction is not shown as confirmed until its chain status is independently checked.

## On-chain discovery implementation

`src/core/v2-fee-discovery.ts` supports both `chipnet` and `mainnet` discovery. It:

- derives the connected wallet's public addresses from wallet state supplied by the app;
- queries each address's script history through the configured network provider;
- ignores unconfirmed/malformed history entries;
- downloads candidate raw transactions and checks that their bytes hash to the requested TXID;
- decodes the discovery note and verifies the category-creating input;
- checks the state NFT, ordered member receipt NFTs and ordered member marker outputs;
- reconstructs the circle parameters and confirms that the outputs are locked by the expected covenant script;
- returns only circles whose member addresses include the connected wallet.

The app does not send wallet xpubs, seeds or private keys to a registry. No server registration, invite index or database backfill is used to discover these circles.

## Optional API adapter

The repository has optional API routes for chain reads and additional PUSD signed-transaction verification. These routes do not own circle records, do not register circles and are not required for browser-side on-chain discovery.

The Upstash Redis shared rate limiter was removed from the common request path. Absence of Redis credentials must not block chain discovery or read-only transaction verification.

The separate PUSD submission-ledger adapter is only a transaction-submission/idempotency mechanism for a future broadcast path. It is not a circle registry or a source of circle truth. PUSD Mainnet broadcast remains separately gated off.

## Separate transaction paths

- **BCH V3 Mainnet:** has a dedicated create/pay/payout/cancel workspace and broadcast path. It is separate from the generic Classic BCH transaction guard.
- **Classic BCH Mainnet:** remains controlled by the generic legacy BCH operations gate.
- **PUSD V3 Mainnet:** has lifecycle planning and signed-byte verification. PUSD broadcast remains disabled until its own transaction path is completed.

Do not conflate these flags or disable the BCH V3 path by changing the Classic BCH gate.

## Operational constraints

- Require the connected wallet's current address and correct network before preparing a transaction.
- Validate raw previous transactions against their TXIDs and verify UTXO values/scripts/token data.
- Treat Electrum quorum as provider agreement, not proof of independently operated providers or local SPV/chainwork validation.
- Do not mark a transaction paid based on a wallet response alone; reconcile its transaction ID and confirmation state from BCH.
- Preserve the version-specific covenant and accounting rules for existing circles.
- Keep PUSD's broadcast gate separate from BCH V3 Mainnet.

This architecture makes the blockchain—not a central backend—the authority for circles and member payments.
