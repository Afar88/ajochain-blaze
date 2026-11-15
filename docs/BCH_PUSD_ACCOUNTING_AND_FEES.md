# BCH/PUSD integration, member accounting and fee controls

## Product structure

AjoChain Blaze now separates the dashboard from transaction workspaces. The home screen is a compact overview. The dropdown menu contains Overview, My circles, Assets & balances, Activity & records, network selection, and wallet access. Heavier BCH workspaces are lazy-loaded only when the circle page is opened.

## BCH circles

### Classic V1

Classic V1 remains available for compatibility and inspection. It is an aggregate-pool covenant. It does **not** prove which member funded an individual contribution, so its saved circle list and observed pot must not be presented as member-owned credit.

Mainnet transaction signing/broadcast remains disabled. Chipnet is the transaction-test environment.

### Versioned V2 fee covenant

New V2 fee circles use a separate versioned covenant and do not change previously deployed circles.

Each circle commits the following to one CashToken category:
- A mutable state NFT containing the current payout round and an irreversible first-payout flag.
- One immutable receipt NFT per member, containing that member's index and credit.
- The 1% treasury destination in the contract's constructor configuration.

Before a payout, **every** member receipt must contain at least one full contribution. The payout consumes all member receipts and debits exactly one contribution from each receipt. That includes the member receiving the pot. Any remaining credit stays attributed to the same member. After the first payout, the state NFT permanently locks cancellation.

The gross pot is split on-chain:
- 1% of gross pot, rounded down in integer satoshis, is sent to the fixed treasury address.
- The recipient receives gross pot minus that project fee.
- Miner fees are supplied by a separate token-free BCH input from the wallet triggering the payout. Any unused fee input value returns to that wallet. The miner fee is not deducted from member credit, the gross member payout, or the project fee.

Each new circle shows the treasury address and fee before creation. The configured Chipnet treasury is a prototype address and should be independently verified before using even test funds.

## Member accounting ledger

The append-only ledger primitives in src/core/verified-member-ledger.ts are ported from the old repo. A receipt is valid only after a trusted chain verifier has checked:
- The confirmed destination output and its amount/asset category.
- The registered member's funding address.
- All funding inputs and previous outputs; mixed or ambiguous inputs fail closed.
- Confirmation height/block hash and the network.
- Idempotent outpoint identity and any reversal/reorg event.

Duplicate observations are idempotent. Conflicting observations fail closed. Reorg/reversal events remove the corresponding credit. The ledger is not itself a blockchain verifier and must never receive unverified UI-entered payment claims.

The V2 covenant is the on-chain enforcement layer: it binds each member's credit to that member's receipt and prevents another member's overpayment from satisfying a short member's payout condition. The append-only ledger is the auditable record and reconciliation model. Classic V1 cannot gain these guarantees retroactively.

## PUSD

The PUSD Mainnet token identity remains pinned to the issuer-published category in src/core/assets.ts. The Mainnet API is exposed through the same-origin Vercel route /api/* and uses the configured ELECTRUM_SERVERS quorum.

The read-only balance path authenticates each PUSD UTXO using raw previous transaction bytes, verifies the exact locking script/category/amount, and rechecks unspent status through the provider quorum. The Assets page also provides a transaction preview: it builds outputs from authenticated PUSD UTXOs, computes CashToken carrier dust, estimates the BCH miner fee from a quorum fee quote, and displays the result.

PUSD Mainnet signing/broadcast remains disabled by the compile-time PUSD_MAINNET_SPENDING_ENABLED = false guard and the API broadcast gate. The transfer preview is not a payment.

The old PUSD V2 circle/escrow covenant prototypes are preserved as separate contract sources with test coverage, but are not exposed as an active PUSD circle flow. There is no verified PUSD Chipnet category, no full PUSD-circle wallet planner, and no independent audit. Do not deploy or spend through those prototypes. Never substitute the PUSD Mainnet category on Chipnet.

## Release gates

- BCH Mainnet signing/broadcast remains disabled.
- V2 BCH fee/member-credit covenant is Chipnet-only and unaudited.
- PUSD balance/transfer preview requires a live provider quorum; a failed quorum must show unavailable, not zero.
- PUSD spending remains disabled.
- Before any real-value release: compile contracts, pass adversarial tests, inspect every signed raw transaction and all token outputs, test end-to-end with independent Selene/WizardConnect wallets, verify the treasury destination, and obtain an independent covenant/security review.

## Checks

    npm test
    npm run typecheck
    npm run build
