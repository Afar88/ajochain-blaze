# AjoChain BLAZE — Ready-to-run setup

This guide takes you from a fresh clone to a running local app, an optional Electrum-backed read/verification API adapter, test commands, and the dedicated Vercel deployment. Circle discovery itself is on-chain and does not require a central backend or database.

## 1. What you need

- Git
- Node.js **22 or later** (Node 22.12+ is recommended for the Vite toolchain)
- npm (included with Node.js)
- A compatible BCH wallet such as Selene with WizardConnect, only if you want to test wallet pairing
- Two secure BCH Mainnet Electrum WebSocket endpoints operated by independently controlled providers, only if you want to exercise Mainnet read/verification API routes

Check your tools:

~~~bash
node --version
npm --version
git --version
~~~

## 2. Clone and install

~~~bash
git clone https://github.com/Afar88/ajochain-blaze.git
cd ajochain-blaze
npm install
~~~

The repository currently does not commit an npm lockfile, so use **npm install**, not npm ci. The install scripts and application use the dependencies declared in package.json.

To work with the current PUSD server-verifier feature branch before it is merged:

~~~bash
git fetch origin
git switch --track origin/feat/pusd-v3-server-verifier
~~~

If that branch has already been merged or renamed, stay on the repository's current main branch.

## 3. Start the app

~~~bash
npm run dev
~~~

The dev command compiles the CashScript contract artifacts and starts Vite. Open the local URL printed in the terminal (normally http://localhost:5173).

Development defaults to **Bitcoin Cash Chipnet**. Use Chipnet for development and wallet experiments. Connect Selene through the app's wallet connection flow, confirm that the address and network shown by the app match Selene, and never enter a seed phrase or private key into BLAZE.

The browser UI and on-chain circle discovery run without a local API process. Only optional API-backed Mainnet reads and additional PUSD verification need the adapter described next. It is not a circle registry and does not hold circle state.

## 4. Optional: run the Electrum read/verification adapter locally

The Vite development server proxies optional /api requests to a local adapter process on port 3001. Start it in a **second terminal** from the repository root when testing API-backed Mainnet reads, PUSD preflight, or the PUSD V3 circle lifecycle submission path.

You need two secure WebSocket Electrum endpoints. Use real provider endpoints you control or have permission to use; do not copy the example hostnames literally. The operator labels must be unique and correspond to the endpoints in the same order.

~~~bash
ELECTRUM_SERVERS="wss://your-provider-one.example:50004,wss://your-provider-two.example:50004" \
ELECTRUM_PROVIDER_OPERATORS="operator-one,operator-two" \
PORT=3001 node server/mainnet-api.mjs
~~~

Keep this terminal running, then use the app at http://localhost:5173. The API validates BCH Mainnet chain identity and provider agreement before serving Mainnet read/verification requests. A provider quorum is not proof of independent ownership, or local SPV/chainwork validation.

The adapter keeps a best-effort, process-local request throttle. It is not a deployment-wide limit across Vercel serverless instances and must not be treated as the production abuse-control boundary. Before exposing API routes to public traffic, configure and test Vercel Firewall rate-limit rules for `/api/*`, keyed by source IP, with stricter limits for expensive verification and submission routes. Do not trust client-supplied forwarding headers for identity. This edge protection does not make Redis a discovery dependency.

If you do not have two suitable Electrum providers, skip this optional API step. The UI and on-chain discovery can still run; only optional API-backed Mainnet functions will be unavailable locally.

## 5. Run the checks

~~~bash
npm run typecheck
npm test
npm run build
~~~

The scripts compile the CashScript contracts as part of the checks. GitHub Actions also runs a targeted BCH 2026 VM compatibility vector suite. That targeted suite is not the complete BCHN/VMB consensus corpus.

For a local production-build smoke test:

~~~bash
npm run build
npm run preview
~~~

Vite prints the preview URL. Stop either server with Ctrl+C.

## 6. Deploy to the correct Vercel project

BLAZE must be deployed from **Afar88/ajochain-blaze** to the dedicated Vercel project **ajochain-blaze**. Do not use the legacy AjoChain Vercel projects or their database resources.

1. In Vercel, import the GitHub repository Afar88/ajochain-blaze.
2. Select or create the project named **ajochain-blaze**.
3. Use the repository root as the Root Directory.
4. Use the detected Vite settings: install command npm install, build command npm run build, output directory dist.
5. Set the Node.js runtime to Node 22.
6. Add the server-only Electrum environment variables below only when you need optional API-backed Mainnet read/verification routes. No database or Redis service is needed for circle discovery.
7. Deploy a preview first. Check the exact commit SHA, build logs, /api/health response and browser console before promoting a reviewed commit to production.

Required server-side variables:

~~~env
ELECTRUM_SERVERS=wss://your-provider-one.example:50004,wss://your-provider-two.example:50004
ELECTRUM_PROVIDER_OPERATORS=operator-one,operator-two
~~~

The operator identifiers must be unique and positionally aligned with the endpoint list. They are declarations, not proof of provider independence. Verify provider ownership and fault-domain separation separately.

The Electrum variables must remain server-side. They are for chain-provider access only; providers are not an application database or circle registry. Never put provider credentials in a VITE_ variable.

### Optional durable broadcast ledger (not for circle discovery)

A separate Upstash Redis REST ledger is used for durable transaction-ID and input-outpoint reservations in the **PUSD Mainnet V3 circle-broadcast path**, the **PUSD Mainnet transfer-broadcast path** (which remains hard-disabled), and the **BCH Mainnet wallet-gather broadcast path**. It is not used for browser-side circle discovery, read-only Mainnet verification, PUSD circle preflight, or BCH V3 circle discovery/broadcast.

When operating a path that uses this ledger, configure these values as private server-side variables only:

~~~env
UPSTASH_REDIS_REST_URL=https://your-dedicated-upstash-database.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-private-write-token
~~~

There is no in-memory fallback: missing credentials or an unavailable ledger blocks the affected submission before relay. The PUSD V3 circle-broadcast gate is enabled in code and uses this ledger; ordinary PUSD wallet transfers remain hard-disabled by their separate compile-time guards. Adding credentials does not enable ordinary PUSD transfers. The credentials are not required merely to run the UI, discover circles, or perform read-only verification. Do not reuse legacy AjoChain or other project databases.

The repository includes a Vercel catch-all API adapter at api/[...path].mjs. The API health endpoint is /api/health. It reports provider status and separate BCH-circle, PUSD-circle, ordinary-transfer and gather gate values; it does not certify provider-operator independence or Mainnet release approval.

## 7. What is and is not enabled

- **BCH Chipnet V3:** the guarded V3 workspace and on-chain discovery are available for test-network use.
- **BCH Mainnet V3:** on-chain discovery and a dedicated V3 signing/broadcast path are implemented. Classic BCH operations remain separately guarded.
- **PUSD Mainnet V3 circles:** genesis, deposit, payout and cancellation have a separate signed-byte verification and durable-ledger-backed broadcast path; its circle-broadcast code gate is enabled.
- **Ordinary PUSD wallet transfers:** remain hard-disabled by the separate client and API gates. Do not confuse this transfer gate with the PUSD V3 circle gate.
- **Shared registry:** not used. Chipnet and Mainnet V3 discovery read BCH transaction history and covenant state; local saved drafts and invite data are not proof of membership or payment.

Do not deploy prototype covenants or send real PUSD to prototype scripts. Do not bypass or alter the separate BCH Classic or PUSD Mainnet gates.

## 8. Troubleshooting

| Symptom | What to check |
|---|---|
| Contract compile fails | Confirm Node/npm versions, rerun npm install, and inspect the CashScript compiler output. |
| Vite opens but Mainnet API calls fail | Confirm the optional API process is running on port 3001 and that two valid Electrum endpoints/operator IDs were supplied. |
| API reports provider configuration errors | Ensure there are at least two secure WebSocket endpoints and exactly one unique operator label per endpoint, in matching order. |
| Wallet pairing opens but does not finish | Confirm Selene is installed, approve the WizardConnect request in the wallet, keep the correct network selected, and retry a fresh pairing if the saved session is stale. |
| App address differs from Selene | Stop before signing. Reconnect and explicitly match the selected network and receive address shown in Selene. |
| Vercel API returns an error | Check that the deployed commit includes the latest API change and that its optional Electrum provider manifest is configured correctly. Circle discovery itself does not depend on this API. |
| A deployment is green but the app behaves differently | Verify the deployment belongs to project ajoChain-blaze, inspect the deployed commit SHA, and check the correct preview/production domain. |

## 9. Project map

- src/ — React application, UI workspaces and client-side logic
- contracts/ — versioned CashScript sources and compiled artifacts
- api/ — optional Vercel serverless read/verification routes; no circle registry
- server/ — optional BCH Mainnet Electrum read/verification adapter, not a central circle database
- test/ — automated tests
- docs/ — architecture, accounting, wallet, discovery and release documentation
- docs/assets/ — README and architecture SVG graphics

## 10. Further reading

- [Project README](../README.md)
- [BLAZE architecture and on-chain discovery](./BLAZE_CIRCLE_DISCOVERY_BACKEND.md)
- [BCH and PUSD member accounting](./BCH_PUSD_MEMBER_ACCOUNTING.md)
- [WizardConnect and Selene integration](./WIZARDCONNECT_SELENE_PORT.md)
- [Mainnet release checklist](./MAINNET_RELEASE_CHECKLIST.md)
- [PUSD Mainnet release checklist](./PUSD_MAINNET_RELEASE_CHECKLIST.md)
- [BCH 2026 VM compatibility](./BCH_2026_VM_COMPATIBILITY.md)

---

AjoChain BLAZE is active development software. Use Chipnet for testing. Real-value use requires independent security review, live wallet testing, operational readiness and explicit release approval.
