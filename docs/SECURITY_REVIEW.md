# AjoChain security review

**Review date:** 21 November 2026  
**Repository:** `Afar88/ajochain-blaze`  
**Base:** `main` at `4d078afb12d0f17b16d2aeff9af39c0442677ae7`  
**Review branch:** `security/full-review-fixes-2026-11-21`

## Scope and assurance level

This is a focused code review of the repository snapshot and the changed files listed in this PR. It covers the CashScript contract families, Mainnet transaction verification and broadcast boundaries, PUSD CashToken accounting, the Mainnet API, WizardConnect session lifecycle, and wallet-facing transaction/balance handling.

This is **not an independent security audit**, formal verification, a review by a BCH/CashTokens security specialist, or evidence from real-value Mainnet lifecycle testing. The required product notice is unchanged:

> Real BCH. The circle contract hasn't had an independent audit yet. Start with small amounts.

`mainnetReleaseApproved` remains `false`: it records that no independent audit has happened. Mainnet circle transactions (BCH and PUSD create, deposit, payout, cancel) stay enabled for small-amount use behind the unaudited notice; the plain PUSD send route stays disabled.

## Findings and disposition

### SEC-01 — Informational (reclassified by the maintainer) — Release label and operation flags differ

- **Files/lines:** `server/mainnet-api.mjs:22-31`.
- **Finding:** the health response reports `mainnetReleaseApproved: false` while the BCH circle, BCH gather and PUSD circle broadcast flags are `true`.
- **Decision:** intentional. `mainnetReleaseApproved` means "no independent audit yet", not "Mainnet off". The app shows the exact notice "Real BCH. The circle contract hasn't had an independent audit yet. Start with small amounts." and every spend is Selene-signed, quorum-verified against the exact covenant, and relayed once through the durable reservation ledger. A proposed global lock was not merged because it would disable all Mainnet circle use. The health constant is now a named export.
- **Still open:** an independent audit before removing the notice or setting the label to true.

### SEC-02 — Medium — Plain PUSD transfer API accepted non-P2PKH scripts as wallet addresses

- **File/lines:** `server/mainnet-api.mjs:831`.
- **Finding:** the plain PUSD spend path accepted any supported CashAddress script type in `walletAddresses`. Its wallet-signature-specific `0x61` check only applies to P2PKH prevouts. This allowed a caller-supplied P2SH/P2SH32 contract script to be classified as a wallet-owned script in a transfer path intended for locally derived Selene wallet addresses.
- **Fix:** wallet address normalization now accepts only Mainnet P2PKH locking scripts. Token-aware P2PKH CashAddresses remain accepted because they map to the same P2PKH locking bytecode.
- **Regression coverage:** P2SH addresses are rejected and token-aware P2PKH addresses are accepted.

### SEC-03 — Medium — Mainnet API exposed raw provider and infrastructure errors

- **File/lines:** `server/mainnet-api.mjs:2849` and the request error boundary at line 3047.
- **Finding:** the HTTP error boundary returned raw exception messages. Electrum connection errors include configured endpoint URLs; upstream and ledger messages can expose operational detail.
- **Fix:** provider/network/durable-ledger failures are classified as service errors and returned with a generic public message. Ambiguous broadcast outcomes retain only the transaction ID and a clear instruction not to retry until status is checked. Client validation errors remain actionable.
- **Regression coverage:** tests prove a private Electrum URL and provider detail do not appear in public responses, while an ambiguous transaction ID remains visible.

### SEC-04 — High — Process-local API rate limiting required a deployment-wide control

- **File/lines:** `server/mainnet-api.mjs:2814` (the `rateLimit` Map is defined immediately above).
- **Finding:** the application limiter is an in-memory Map. Serverless instances do not share that state and may be created or recycled independently, so it is not a reliable global rate limit.
- **Deployment status (2026-11-21):** the previously configured project-level custom WAF rule **AjoChain API rate limit** (`rule_ajo_chain_api_rate_limit_dV7mTH`) was removed from the active Vercel configuration at the maintainer's request. Vercel Firewall remains enabled, but there is currently no custom API rate-limit rule in the active project configuration.
- **Maintainer note (2026-11-21):** a limit of 60 requests per minute could block normal wallet loads across many addresses; do not reintroduce an edge limit without measuring legitimate traffic and agreeing a suitable threshold.
- **Residual:** the in-process limiter remains best-effort defence in depth only; it is not deployment-wide. Add and verify a shared/edge rate limit before describing it as a global control.

### SEC-05 — High — V3 circle funds can remain locked after the first payout if a member defaults

- **Files/lines:** `contracts/AjoCircleV3AutoReserve.cash:230–247`; `contracts/AjoCirclePUSDV3Mainnet.cash:290–303`; comparable pre-first-payout cancellation restrictions exist in the V2 fee/escrow contract sources.
- **Finding:** the V3 BCH and PUSD cancellation paths are limited to round zero before the first payout. Once a cycle advances, if a member never funds a later installment, remaining member credits/escrow can remain locked indefinitely. This is a lifecycle/design risk, not a problem that an API-side check can repair. The older `AjoCircleV2` prototype also has no `cancel` branch. The Chipnet-only `AjoCirclePUSDV2` prototype has no `cancel` branch and advances the state round modulo `memberCount` (`contracts/AjoCirclePUSDV2.cash:115–205`), so it is a repeating cycle without a terminal close.
- **Fix:** no covenant change was made. Adding a timeout, member-default path or emergency exit safely requires a new reviewed covenant version, a clear refund policy and adversarial tests; changing an existing contract would alter its spending rules/address and is not safe as a quick patch. The PUSD V2 prototype is explicitly Chipnet-test-only and must not be deployed to Mainnet.
- **Still open:** design and independently review a post-payout default/recovery path, including exact PUSD refunds and BCH carrier handling. Keep the PUSD V2 and older V2 sources out of Mainnet deployment; existing circles cannot be retrofitted by changing source.

### SEC-06 — Medium — PUSD V3 maxFee has no practical absolute satoshi ceiling

- **Files/lines:** `server/mainnet-api.mjs:1855–1860`; `contracts/AjoCirclePUSDV3Mainnet.cash:146–147, 279–282`; client circle policy at `src/core/pusd-mainnet-circle.ts:132–136`.
- **Finding:** PUSD V3 validates `maxFee` against the CashScript signed-integer ceiling, but not against a practical absolute BCH miner-fee ceiling or a fee-rate-derived policy. The covenant allows a payout/deposit/cancel sponsor's signed BCH input to lose up to the circle's immutable `maxFee`. Because any connected wallet may sponsor a payout, a circle created with an extreme fee cap can expose a later sponsor to a very large BCH fee.
- **Fix:** no numeric fee ceiling was guessed in this PR. Choosing it changes circle economics and may make existing circles unspendable if enforced retroactively.
- **Still open:** define a documented satoshi and/or fee-rate cap with the product owner and independent reviewer; enforce it at circle creation, plan construction and server verification, and add exact boundary tests. Until then, keep Mainnet broadcast approval false.

### SEC-07 — Medium — Timed-out WizardConnect sessions can retain a stale manager during automatic retry

- **File/lines:** `src/core/wizard-wallet.ts:601–614` and `629–647`.
- **Finding:** the connection watchdog moves the state to `disconnected` but keeps the manager/relay references. A later automatic `tryResume()` can call `connect(existing)`, which replaces the manager reference without first cleaning up the timed-out manager/relay. Generation checks reject stale callbacks, but cleanup of the replaced relay is not explicit on this path.
- **Fix:** not changed in this PR because safely changing wallet lifecycle ownership needs an integration test with the real WizardConnect manager/relay and mobile suspend/resume behaviour. The existing code's generation guard prevents a stale manager from being considered current for completed signing operations, but it does not prove the remote session is fully disposed.
- **Still open:** add a mocked manager/relay lifecycle test, then make reconnection cleanup explicit while preserving the encrypted saved session for retry.

### SEC-08 — High — Contract and Mainnet lifecycle assurance remains incomplete

- **Files:** `contracts/*.cash`, corresponding generated artifacts, `server/mainnet-api.mjs`, `src/core/*`.
- **Finding:** automated unit tests and local BCH 2026 VM checks do not constitute independent contract review or real-wallet/Mainnet lifecycle evidence. The V2/V3 sources include prototypes and multiple covenant generations; they must not be treated as interchangeable.
- **Fix:** this PR does not label the application or any contract as audited. No generated `contracts/*.json` file is changed.
- **Still open:** commission an independent review of the exact source and artifact hashes intended for deployment; test deposit, payout, cancel, rounding, all member counts, duplicate/replayed inputs, category/capability handling, fee bounds, carrier dust, reorgs and stuck-fund recovery with independent wallets. Confirm the deployed covenant address/version against its audited source before release.

## Areas reviewed with no new code change

- **BCH contract spend rules:** reviewed Classic, V2 fee/escrow and V3 auto-reserve source. Input/output ordering, state-round transitions, receipt order and fee outputs are checked in the covenant sources and/or server verifier. Legacy and prototype variants have different guarantees; do not conflate them.
- **PUSD conservation and destinations:** reviewed V3 deposit, payout and cancel layouts and member escrow sidecar. The server verifier checks exact PUSD category/amounts, escrow scripts, recipient/treasury outputs, BCH carrier backing, dust, wallet sighash and BCH 2026 VM. Amount arithmetic preserves the full input credit: the 1% fee uses integer floor division and the remaining units go to the scheduled recipient; no token amount is silently rounded away. The separate high-risk `maxFee` exposure is tracked in SEC-06. The release gate is now closed pending independent review.
- **Transaction signing:** reviewed the WizardConnect signing request and returned-transaction checks. Input outpoints/sequences, transaction version/locktime, outputs/CashTokens, required wallet sighashes and BCH 2026 VM checks are present.
- **Electrum provider selection and failover:** the API accepts 2–6 secure WebSocket endpoints and automatically appends the built-in Fulcrum and Soul-Dev backups after a valid environment list, preserving environment order and never exceeding six total endpoints. No Vercel environment change is required to add those built-in backups. It selects exactly two responsive providers with different declared operator labels after each passes the existing genesis and both BCH fork-checkpoint checks. The selected pair must agree on height, hash and header bytes. If first-pass tips do not form a matching pair, the API waits two seconds and re-reads every server that passed the first check once before returning a disagreement error. A complete selection retry remains limited to cases where fewer than two declared operators passed the first check; the entire selection phase finishes before any action callback or broadcast. Operator labels are declared, not proven independent; endpoint names and labels do not prove separate ownership or infrastructure fault domains. The release process still requires independent evidence for provider/operator independence.
- **Stale data and replay:** Mainnet verification obtains quorum previous transactions and UTXO snapshots; PUSD broadcast uses a durable input/transaction reservation when configured. These controls still depend on the configured Electrum trust model. BCH circle relay does not yet have the same durable cross-operation input reservation as the PUSD path.
- **Balance display:** the UI uses verified UTXO and raw previous-transaction evidence for PUSD. Client display remains dependent on provider quorum and must not be described as an independent on-chain proof.

## Release decision

**Do not enable Mainnet broadcasts from this PR.** All broadcast paths remain closed and `mainnetReleaseApproved` remains `false`. The fixes in this PR reduce concrete API/release-gate risk; the open items above must be resolved through a separately reviewed release process. This AI-assisted review is not an independent audit.
