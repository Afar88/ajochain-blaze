# Blaze Chipnet circle discovery: security gate

**Shared discovery, registration, and backfill are disabled.** Share the existing Chipnet circle invite link to add a circle on another device. The local circle menu and invite restoration do not depend on the discovery route.

## Why it is disabled

The original PR #63 server trusted receive addresses supplied by the browser. Address validation and client-side on-chain checks did not authorize registry lookups. Registration accepted a syntactically valid invite and did not verify on Chipnet that the category, transaction and covenant belonged together. The in-memory request limit also was not shared across serverless instances.

The [WizardConnect hdwalletv1 protocol](https://docs.riftenlabs.com/wizardconnect/protocol/#hdwalletv1-protocol) provides public derivation paths and transaction signing. It does not define an arbitrary-message ownership proof. Blaze's `signAndVerify` validates a BCH transaction against the prepared intent and its previous outputs; it is not an authentication method. A session, xpub, receive address, or public historical signature does not prove ownership to the server. Do not use a real, dummy, or disguised transaction as a login prompt.

The browser no longer polls or sends receive addresses or saved invites to the registry. `/api/circles` rejects all POSTs before reading request data and has no database client. Adding an environment variable cannot enable it.

## Required before restoring the registry

1. Confirm a supported Selene/WizardConnect **non-spending** proof in a real wallet. Verify the proof for each exact Chipnet P2PKH key being queried; one verified receive key cannot authorize arbitrary sibling addresses from a browser-supplied list. Do not upload xpubs. Display the domain and purpose in the wallet prompt.
2. Issue short-lived, random challenges bound to the service origin, Chipnet, the requested scope and the claimed address. Verify the exact signed challenge server-side; atomically consume it once across all instances. If issuing a session for polling, bind it to verified addresses and permissions, expire it, and discard it on account/session changes. Query only the server-verified scope.
3. Require an authenticated member and independent server-side chain verification before indexing an invite. Verify the guarded Chipnet V3 constructor bindings, category-creating input and actual transaction bytes, exact state/receipt outputs and current covenant state. Never accept a supplied txid as evidence by itself. Backfill must meet the same checks, resolving missing references from trusted chain data or staying unindexed. Use a canonical on-chain identity and separate untrusted display metadata from that identity.
4. Enforce shared limits on challenge issuance, verification, discovery and registration before expensive work. Bound request and response sizes, fail closed if shared controls are unavailable, avoid logging addresses/invites, and return only the minimum metadata needed to restore a matching circle. An invite link is not encrypted and should not contain confidential names or other personal information.
5. Confirm the Vercel project is `ajochain-blaze` and provision a dedicated Blaze Neon project before wiring the sensitive `BLAZE_CIRCLE_DISCOVERY_DATABASE_URL` in the approved environment. Never fall back to `DATABASE_URL`, or use formal AjoChain or Paraguas resources. Exercise denied lookups, invalid registrations, replay and concurrency in automated tests and verify two independently controlled Chipnet wallets before turning discovery on.

This gate does not enable Mainnet signing, spending, or broadcast. Existing Mainnet release checklists still apply.
