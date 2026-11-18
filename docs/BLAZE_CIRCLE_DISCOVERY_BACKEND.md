# AjoChain Blaze Circle Discovery Backend

## Separation boundary

This service belongs only to the `Afar88/ajochain-blaze` repository and the
`ajochain-blaze` Vercel project. It must use a dedicated Neon database and a
dedicated Vercel environment variable named
`BLAZE_CIRCLE_DISCOVERY_DATABASE_URL`.

The runtime deliberately does **not** fall back to `DATABASE_URL`,
`POSTGRES_URL`, or any other generic database variable. This prevents the
Blaze discovery API from silently connecting to the formal AjoChain database
or another application's database.

## What it stores

The backend stores only a discovery index for confirmed Chipnet V3 circles:
the encoded public invite parameters, state category, genesis transaction ID,
circle name, initiator/treasury addresses, and indexed member receive
addresses.

It is not a ledger. It does not store balances, calculate contributions, unlock
payouts, sign transactions, or broadcast transactions. Contract state and
member receipts remain authoritative on Chipnet.

## API

- `POST /api/circles` with `{ action: "register", encoded, genesisTxid }`
  registers a circle after the creator's wallet-approved genesis transaction
  is accepted by Chipnet.
- `POST /api/circles` with `{ action: "discover", addresses: [...] }`
  returns candidate invites indexed for the supplied public Chipnet receive
  addresses.

The client derives up to 50 Chipnet receive addresses from the connected
WizardConnect session, even when the workspace opens on Mainnet. It decodes
each returned candidate and calls `readV2FeeCircle` to independently verify
the current contract state and member receipts before saving it in the local
menu. Invalid, stale, or non-member candidates are ignored.

When the dedicated database becomes available, a connected member can also
backfill circles already saved in that browser. The client confirms that the
connected wallet's derived receive branch matches a registered member and
re-reads the live Chipnet state and receipts before registering the invite.
For historical records, the genesis transaction ID remains null rather than
being guessed; a later creation registration may enrich the row with the exact
transaction ID.

Invites continue to work as a recovery and sharing mechanism when the registry
is unavailable.

## Dedicated database setup

1. Provision a **new Neon project/resource for AjoChain Blaze**, not the
   existing `ajochain-legacy` Neon store and not the Paraguas store.
2. Create a separate production connection string for the new Blaze resource.
3. Add it to the `ajochain-blaze` Vercel project as the sensitive environment
   variable `BLAZE_CIRCLE_DISCOVERY_DATABASE_URL` for Production, Preview,
   and Development.
4. Redeploy the Blaze project. The API creates only its own
   `ajo_blaze_circle_registry` and `ajo_blaze_circle_members` tables on first
   use.

The Neon account is managed through Vercel Marketplace. The separate database
resource must be provisioned and attached there before shared discovery is
available in deployed environments. Until the dedicated variable is present,
the API fails closed with HTTP 503; local invite links and chain operations
continue to work normally.
