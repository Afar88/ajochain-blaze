# Classic BCH and account portability

This change ports the old app's Classic BCH v1 contract path into Blaze without
changing the frozen repository or its deployed site.

## What is implemented here

- Classic BCH contract source is compiled as part of the Blaze build.
- Circle parameter validation enforces BCH network address prefixes, 2–5
  distinct members, positive satoshi contributions and a fee cap that preserves
  the 1,000-satoshi recipient floor.
- Electrum reads, Classic genesis planning, wallet-funded contributions,
  covenant payout construction and read-only circle-state inspection are
  provided by \`src/core/classic-bch.ts\`.
- Invite links retain network, member order, contribution, fee cap and state
  category. A browser-local circle index can save and restore invite links.
- These browser-local records are an account convenience only. They are not
  server accounts, do not sync across devices, and are not proof of payment.
  Confirmed chain data remains authoritative.
- Chipnet is the live functional test path in Blaze. Wallet approval is still
  required for genesis and contribution. A covenant payout is permissionless
  and does not need a member wallet signature.

## Mainnet boundary

The old Classic BCH contract is network-agnostic and the old app exposed a
Mainnet switch, but its README did not claim a real Mainnet transaction had
been made. Porting that code is not a security audit. Blaze therefore keeps
\`BCH_MAINNET_OPERATIONS_ENABLED\` hard-coded to false. Mainnet chain reads and
unsigned transaction planning can be reviewed; signing/broadcast of real BCH
transactions remains blocked. The kill-switch is not a Vercel variable,
browser setting or UI toggle.

Before enabling Mainnet operations, the release owner must obtain and record:
1. Independent review of \`contracts/AjoCircle.cash\` and its transaction plans.
2. Verified Electrum provider identity, freshness, failover and network-tip
   consistency, not merely the first server that responds.
3. End-to-end WizardConnect/Selene tests for genesis and contributions on
   Chipnet, followed by a separately approved Mainnet canary.
4. Independent decoding and fee/change review of every final signed
   transaction before broadcast.
5. Adversarial tests for malformed state NFTs, wrong token categories,
   duplicates, stale/spent UTXOs, dust, fee overrun, replay and reorg cases.
6. A documented incident/rollback process and independent release approval.

## Deliberately not moved to Mainnet

- The old PUSD pooled-pot flow was explicitly Chipnet-only and remains blocked.
- The old V2 member-receipt contract was an experimental Chipnet prototype and
  remains blocked from Mainnet until its contract and accounting are separately
  reviewed.
- The member ledger is informational. It does not independently verify a
  transaction or make the pooled Classic v1 contract member-aware.
- There is no separate platform-fee contract in the old Classic path;
  \`maxFee\` is a miner-fee ceiling enforced by the covenant.
