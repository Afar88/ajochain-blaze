import { lazy, Suspense, useEffect, useState } from "react";
import {
  Activity, ArrowRight, Check, ChevronDown, Coins, Home,
  Menu, ShieldCheck, Users, Wallet, X,
} from "lucide-react";
import { getDefaultNetwork, NETWORKS, type NetworkId } from "./core/network-config";
import { formatAssetAmount, parseAssetAmount, PUSD_ASSET } from "./core/assets";
import type { PusdTransferPlan } from "./core/pusd-transaction-builder";
import type { AuthenticatedPusdUtxo } from "./core/pusd-utxo";
import { PUSD_MAINNET_SPENDING_ENABLED } from "./core/pusd-mainnet-guard";
const ClassicBchWorkspace = lazy(() => import("./components/ClassicBchWorkspace"));
const V2FeeBchWorkspace = lazy(() => import("./components/V2FeeBchWorkspace"));
const PusdMainnetCircleWorkspace = lazy(() => import("./components/PusdMainnetCircleWorkspace"));
const BchMainnetCircleWorkspace = lazy(() => import("./components/BchMainnetCircleWorkspace"));

type Page = "overview" | "circles" | "assets" | "activity";
type WalletClient = typeof import("./core/wizard-wallet").wallet;
type WalletView = {
  state: "idle" | "connecting" | "connected" | "reconnecting" | "disconnecting" | "disconnected";
  uri: string | null;
  qrUri: string | null;
  walletName: string | null;
  error: string | null;
  receiveIndex: number;
};
type PusdView = {
  status: "idle" | "loading" | "ready" | "error";
  amount: bigint;
  detail: string;
  utxoCount: number;
  providerConfidence: number;
  tipHeight: number;
  utxos: AuthenticatedPusdUtxo[];
  rawPreviousTransactions: Record<string, string>;
};

const pageLabels: Record<Page, string> = {
  overview: "Overview",
  circles: "My circles",
  assets: "Assets",
  activity: "Activity",
};

export default function App() {
  const [network, setNetwork] = useState<NetworkId>(() => getDefaultNetwork(import.meta.env.PROD));
  const [page, setPage] = useState<Page>("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [walletClient, setWalletClient] = useState<WalletClient | null>(null);
  const [walletView, setWalletView] = useState<WalletView>({
    state: "idle", uri: null, qrUri: null, walletName: null, error: null, receiveIndex: 0,
  });
  const [showWallet, setShowWallet] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [seleneAddress, setSeleneAddress] = useState("");
  const [addressMatchMessage, setAddressMatchMessage] = useState("");
  const [pusdRefresh, setPusdRefresh] = useState(0);
  const [pusdView, setPusdView] = useState<PusdView>({
    status: "idle", amount: 0n, detail: "Connect a wallet on Mainnet to check PUSD.",
    utxoCount: 0, providerConfidence: 0, tipHeight: 0, utxos: [], rawPreviousTransactions: {},
  });
  const [pusdRecipient, setPusdRecipient] = useState("");
  const [pusdAmount, setPusdAmount] = useState("0.02");
  const [pusdMaxFee, setPusdMaxFee] = useState("20000");
  const [pusdTransferPlan, setPusdTransferPlan] = useState<PusdTransferPlan | null>(null);
  const [pusdPlanError, setPusdPlanError] = useState("");
  const [pusdPlanBusy, setPusdPlanBusy] = useState(false);

  const walletAddress = walletClient?.address(network) ?? null;
  const connected = walletView.state === "connected";
  const menuLabel = pageLabels[page];

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      void import("./core/wizard-wallet").then(({ wallet: client }) => {
        if (!active) return;
        setWalletClient(client);
        const sync = () => setWalletView({
          state: client.state,
          uri: client.uri,
          qrUri: client.qrUri,
          walletName: client.walletName,
          error: client.error,
          receiveIndex: client.receiveIndex,
        });
        unsubscribe = client.onChange(sync);
        sync();
        client.tryResume();
      }).catch((cause: unknown) => {
        if (active) setWalletView((view) => ({
          ...view,
          error: cause instanceof Error ? cause.message : "Wallet module could not be loaded.",
        }));
      });
    }, 900);
    return () => {
      active = false;
      window.clearTimeout(timer);
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const uri = walletView.qrUri;
    if (!uri) {
      setQrDataUrl("");
      return () => { active = false; };
    }
    void import("qrcode")
      .then(({ default: QRCode }) => QRCode.toDataURL(uri, {
        errorCorrectionLevel: "M", margin: 1, width: 240,
      }))
      .then((url) => { if (active) setQrDataUrl(url); })
      .catch(() => { if (active) setQrDataUrl(""); });
    return () => { active = false; };
  }, [walletView.qrUri]);

  useEffect(() => {
    let active = true;
    if (page !== "assets") return () => { active = false; };
    if (network !== "mainnet" || walletView.state !== "connected" || !walletClient) {
      setPusdView({
        status: "idle", amount: 0n,
        detail: network !== "mainnet"
          ? "PUSD is a Mainnet CashToken. Switch to Bitcoin Cash Mainnet to check your balance."
          : "Connect your wallet to check PUSD.",
        utxoCount: 0, providerConfidence: 0, tipHeight: 0, utxos: [], rawPreviousTransactions: {},
      });
      return () => { active = false; };
    }
    const address = walletClient.address("mainnet");
    if (!address) {
      setPusdView({
        status: "idle", amount: 0n, detail: "Mainnet receive address is still being derived.",
        utxoCount: 0, providerConfidence: 0, tipHeight: 0, utxos: [], rawPreviousTransactions: {},
      });
      return () => { active = false; };
    }
    setPusdView({
      status: "loading", amount: 0n,
      detail: "Authenticating PUSD UTXOs and unspent status through the configured provider quorum…",
      utxoCount: 0, providerConfidence: 0, tipHeight: 0, utxos: [], rawPreviousTransactions: {},
    });
    void import("./core/pusd-api")
      .then(({ fetchPusdWalletBalance }) => fetchPusdWalletBalance(address))
      .then((result) => {
        if (!active) return;
        setPusdView({
          status: "ready",
          amount: result.balance,
          detail: result.providerConfidence + " Electrum providers agreed · block " +
            result.tipHeight.toLocaleString() + " · " + result.utxos.length + " authenticated token UTXOs",
          utxoCount: result.utxos.length,
          providerConfidence: result.providerConfidence,
          tipHeight: result.tipHeight,
          utxos: result.utxos,
          rawPreviousTransactions: result.rawPreviousTransactions,
        });
        setPusdTransferPlan(null);
        setPusdPlanError("");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setPusdView({
          status: "error", amount: 0n,
          detail: cause instanceof Error ? cause.message : "PUSD balance verification failed.",
          utxoCount: 0, providerConfidence: 0, tipHeight: 0, utxos: [], rawPreviousTransactions: {},
        });
      });
    return () => { active = false; };
  }, [page, network, walletView.state, walletView.receiveIndex, walletClient, pusdRefresh]);

  const preparePusdTransfer = async () => {
    setPusdPlanError("");
    setPusdTransferPlan(null);
    if (!connected || walletClient?.state !== "connected") {
      setPusdPlanError("Connect your wallet before preparing a PUSD transfer.");
      return;
    }
    if (network !== "mainnet") {
      setPusdPlanError("PUSD is Mainnet-only. Switch the app network to Mainnet first.");
      return;
    }
    if (pusdView.status !== "ready") {
      setPusdPlanError("A verified PUSD balance is required before planning a transfer.");
      return;
    }
    const senderAddress = walletClient?.address("mainnet");
    if (!senderAddress) {
      setPusdPlanError("The connected wallet does not currently expose a verified Mainnet receive address.");
      return;
    }
    setPusdPlanBusy(true);
    try {
      if (!/^\\d+$/.test(pusdMaxFee.trim())) throw new Error("Maximum miner fee must be entered as whole satoshis.");
      const requiredPusdAmount = parseAssetAmount("PUSD", pusdAmount);
      const [{ buildPusdTransferPlan }, { cashAddressToExpectedLockingBytecode, fetchPusdFeeQuote }] =
        await Promise.all([import("./core/pusd-transaction-builder"), import("./core/pusd-api")]);
      const feeQuote = await fetchPusdFeeQuote();
      const plan = buildPusdTransferPlan({
        authenticatedUtxos: pusdView.utxos,
        requiredPusdAmount,
        recipientLockingBytecode: cashAddressToExpectedLockingBytecode(pusdRecipient),
        changeLockingBytecode: cashAddressToExpectedLockingBytecode(senderAddress),
        feeRateSatoshisPerKb: feeQuote.feeRateSatoshisPerKb,
        maxFeeSatoshis: BigInt(pusdMaxFee.trim()),
      });
      setPusdTransferPlan(plan);
    } catch (cause) {
      setPusdPlanError(cause instanceof Error ? cause.message : "Could not prepare the PUSD transfer.");
    } finally {
      setPusdPlanBusy(false);
    }
  };

  const openWallet = () => {
    setMenuOpen(false);
    setShowWallet(true);
    const start = (client: WalletClient) => {
      setWalletClient(client);
      if (client.state === "disconnected") {
        if (!client.tryResume()) client.connect();
      } else if (client.state === "idle") {
        client.connect();
      }
    };
    if (walletClient) start(walletClient);
    else void import("./core/wizard-wallet").then(({ wallet: client }) => start(client))
      .catch((cause: unknown) => setWalletView((view) => ({
        ...view, error: cause instanceof Error ? cause.message : "Wallet module could not be loaded.",
      })));
  };

  const navigate = (next: Page) => {
    setPage(next);
    setMenuOpen(false);
  };

  const changeNetwork = (next: NetworkId) => {
    setNetwork(next);
    setMenuOpen(false);
    setAddressMatchMessage("");
  };

  const shortAddress = (value: string | null) =>
    value ? value.slice(0, 10) + "…" + value.slice(-6) : "Address syncing…";

  return (
    <main className="app-shell compact-app">
      <header className="app-header">
        <a className="brand" href="#overview" onClick={() => navigate("overview")} aria-label="AjoChain home">
          <span className="brand-mark">a</span><span>AjoChain</span>
        </a>
        <div className="header-actions">
          {connected && (
            <button className="header-wallet-chip" type="button" onClick={() => setShowWallet(true)}>
              <span className="wallet-live-dot" />{shortAddress(walletAddress)}
            </button>
          )}
          <button
            className={menuOpen ? "menu-trigger menu-trigger-open" : "menu-trigger"}
            type="button"
            aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={menuOpen}
            aria-controls="ajochain-dropdown"
            onClick={() => setMenuOpen((value) => !value)}
          >
            {menuOpen ? <X size={19} /> : <Menu size={19} />}
            <span>Menu</span>
            <ChevronDown size={15} />
          </button>
        </div>
        {menuOpen && (
          <>
            <button className="menu-dismiss" aria-label="Close menu" onClick={() => setMenuOpen(false)} />
            <section className="app-dropdown" id="ajochain-dropdown" aria-label="AjoChain menu">
              <div className="dropdown-heading">
                <span className="section-kicker">WORKSPACE</span>
                <b>{menuLabel}</b>
              </div>
              <nav className="dropdown-nav" aria-label="Page navigation">
                <button className={page === "overview" ? "dropdown-item active" : "dropdown-item"} onClick={() => navigate("overview")}>
                  <Home size={17} /><span>Overview</span>{page === "overview" && <Check size={15} />}
                </button>
                <button className={page === "circles" ? "dropdown-item active" : "dropdown-item"} onClick={() => navigate("circles")}>
                  <Users size={17} /><span>My circles</span>{page === "circles" && <Check size={15} />}
                </button>
                <button className={page === "assets" ? "dropdown-item active" : "dropdown-item"} onClick={() => navigate("assets")}>
                  <Coins size={17} /><span>Assets & balances</span>{page === "assets" && <Check size={15} />}
                </button>
                <button className={page === "activity" ? "dropdown-item active" : "dropdown-item"} onClick={() => navigate("activity")}>
                  <Activity size={17} /><span>Activity & records</span>{page === "activity" && <Check size={15} />}
                </button>
              </nav>
              <div className="dropdown-divider" />
              <div className="dropdown-label">NETWORK</div>
              <div className="network-choice">
                {(["chipnet", "mainnet"] as NetworkId[]).map((id) => (
                  <button key={id} type="button" className={network === id ? "network-choice-item selected" : "network-choice-item"} onClick={() => changeNetwork(id)}>
                    <span className={id === "mainnet" ? "network-dot live" : "network-dot"} />
                    <span>{id === "chipnet" ? "Chipnet" : "Mainnet"}</span>
                    {network === id && <Check size={14} />}
                  </button>
                ))}
              </div>
              <div className="dropdown-divider" />
              <button type="button" className="dropdown-wallet" onClick={openWallet}>
                <span className="dropdown-wallet-icon"><Wallet size={17} /></span>
                <span><b>{connected ? walletView.walletName ?? "Wallet connected" : "Connect wallet"}</b><small>{connected ? shortAddress(walletAddress) : walletView.state === "reconnecting" ? "Restoring Selene session…" : "WizardConnect · Selene"}</small></span>
                <ArrowRight size={16} />
              </button>
              <button type="button" className="dropdown-create-button" onClick={() => navigate("circles")}>
                <Users size={16} /> Open circle tools <ArrowRight size={15} />
              </button>
            </section>
          </>
        )}
      </header>

      <div className="page-body">
        {page === "overview" && (
          <>
            <section className="welcome-hero">
              <div className="welcome-kicker"><span /> SAVINGS, WITH SHARED RESPONSIBILITY</div>
              <h1>Build together.<br /><em>Stay accountable.</em></h1>
              <p>Run a rotating savings circle with transparent member credit, clear payout rules and a fee shown before anyone joins.</p>
              <button className="primary-button hero-cta" type="button" onClick={() => navigate("circles")}>
                Open circle tools <ArrowRight size={16} />
              </button>
            </section>

            <section className="overview-status-grid">
              <article className="overview-status-card">
                <div className="status-card-icon"><Wallet size={18} /></div>
                <div><span className="status-label">WALLET</span><b>{connected ? walletView.walletName ?? "Connected" : "Not connected"}</b>
                  <small>{connected ? shortAddress(walletAddress) : "Connect Selene to manage member contributions"}</small></div>
                <button type="button" className="status-action" onClick={openWallet}>{connected ? "Details" : "Connect"} <ArrowRight size={13} /></button>
              </article>
              <article className="overview-status-card">
                <div className="status-card-icon"><ShieldCheck size={18} /></div>
                <div><span className="status-label">NETWORK</span><b>{NETWORKS[network].label}</b>
                  <small>{network === "chipnet" ? "Testing environment · no real funds" : "Mainnet · read-only release controls"}</small></div>
                <button type="button" className="status-action" onClick={() => setMenuOpen(true)}>Change <ChevronDown size={13} /></button>
              </article>
            </section>

            <section className="asset-preview">
              <div><span className="section-kicker">SUPPORTED ASSETS</span><h2>BCH and PUSD</h2><p>Separate asset paths, with token verification and fees kept visible.</p></div>
              <div className="asset-preview-rows">
                <div><span className="asset-symbol">B</span><span><b>Bitcoin Cash</b><small>Circle contracts on Chipnet · Mainnet inspection only</small></span><span className="asset-state">Available</span></div>
                <div><span className="asset-symbol pusd-symbol">P</span><span><b>ParyonUSD</b><small>Mainnet identity pinned · verified balance requires the quorum API</small></span><span className="asset-state neutral">Read only</span></div>
              </div>
              <button type="button" className="text-action" onClick={() => navigate("assets")}>View asset details <ArrowRight size={14} /></button>
            </section>
          </>
        )}

        {page === "circles" && (
          <section className="page-section">
            <div className="page-intro">
              <span className="section-kicker">YOUR SAVINGS GROUPS</span>
              <h1>Circle tools</h1>
              <p>Create and manage circles. PUSD uses its own Mainnet CashToken covenant; BCH prototypes remain separate.</p>
            </div>
            <Suspense fallback={<div className="workspace-loading"><span className="loading-orb" />Loading circle tools…</div>}>
              <PusdMainnetCircleWorkspace network={network} walletConnected={connected} />
              <BchMainnetCircleWorkspace network={network} walletConnected={connected} />
              <ClassicBchWorkspace network={network} walletConnected={connected} />
              <V2FeeBchWorkspace network={network} walletConnected={connected} />
            </Suspense>
          </section>
        )}

        {page === "assets" && (
          <section className="page-section">
            <div className="page-intro">
              <span className="section-kicker">ASSETS & VERIFICATION</span>
              <h1>Balances and asset paths</h1>
              <p>Wallet connection and token verification are separate from permission to spend.</p>
            </div>
            <article className="asset-detail-card">
              <div className="asset-detail-heading">
                <span className="asset-symbol">B</span>
                <div><span className="section-kicker">BITCOIN CASH</span><h2>BCH</h2><p>Native BCH for circle reserves, miner fees and payouts.</p></div>
                <span className="asset-state">Chipnet testing</span>
              </div>
              <div className="asset-detail-row"><span>Circle creation and member-credit flow</span><b>Chipnet enabled</b></div>
              <div className="asset-detail-row"><span>Mainnet transaction broadcast</span><b className="locked-state">Locked</b></div>
            </article>
            <article className="asset-detail-card">
              <div className="asset-detail-heading">
                <span className="asset-symbol pusd-symbol">P</span>
                <div><span className="section-kicker">PARYONUSD · CASHTOKEN</span><h2>PUSD</h2><p>Canonical issuer-published Mainnet category.</p></div>
                <span className="asset-state neutral">Mainnet only</span>
              </div>
              <div className="pusd-balance-panel">
                <span className="status-label">AUTHENTICATED WALLET BALANCE</span>
                <strong>{pusdView.status === "ready" ? formatAssetAmount("PUSD", pusdView.amount) + " PUSD" : pusdView.status === "loading" ? "Checking…" : pusdView.status === "error" ? "Unavailable" : "Not checked"}</strong>
                <small>{pusdView.detail}</small>
                <button type="button" className="secondary-button" onClick={() => {
                  if (!connected) { openWallet(); return; }
                  if (network !== "mainnet") { changeNetwork("mainnet"); return; }
                  setPusdRefresh((value) => value + 1);
                }} disabled={pusdView.status === "loading"}>
                  {pusdView.status === "loading" ? "Verifying…" : !connected ? "Connect wallet" : network !== "mainnet" ? "Switch to Mainnet" : "Refresh verified balance"}
                </button>
                {pusdView.status === "ready" && <span className="field-hint">{pusdView.providerConfidence} providers · block {pusdView.tipHeight.toLocaleString()} · {pusdView.utxoCount} authenticated PUSD outputs</span>}
              </div>
              <div className="pusd-transfer-box">
                <div><span className="section-kicker">TRANSFER PLANNER</span><h3>Prepare a PUSD transfer</h3>
                  <p>Builds a transaction preview from authenticated PUSD UTXOs and a live fee quote. It does not sign or broadcast.</p></div>
                <label>Recipient Bitcoin Cash address
                  <input value={pusdRecipient} onChange={(event) => { setPusdRecipient(event.target.value); setPusdTransferPlan(null); setPusdPlanError(""); }} placeholder="bitcoincash:…" autoComplete="off" />
                </label>
                <div className="pusd-transfer-fields">
                  <label>Amount (PUSD)
                    <input value={pusdAmount} onChange={(event) => { setPusdAmount(event.target.value); setPusdTransferPlan(null); setPusdPlanError(""); }} inputMode="decimal" placeholder="0.02" />
                  </label>
                  <label>Maximum miner fee (sats)
                    <input value={pusdMaxFee} onChange={(event) => { setPusdMaxFee(event.target.value); setPusdTransferPlan(null); setPusdPlanError(""); }} inputMode="numeric" />
                  </label>
                </div>
                <button type="button" className="secondary-button" onClick={() => void preparePusdTransfer()} disabled={pusdPlanBusy || pusdView.status !== "ready" || network !== "mainnet"}>
                  {pusdPlanBusy ? "Preparing preview…" : "Prepare transfer preview"}
                </button>
                {pusdPlanError && <p className="classic-error" role="alert">{pusdPlanError}</p>}
                {pusdTransferPlan && (
                  <div className="pusd-plan-summary" role="status">
                    <b>Transfer plan ready · review only</b>
                    <div><span>Recipient receives</span><strong>{formatAssetAmount("PUSD", pusdTransferPlan.recipientPusdAmount)} PUSD</strong></div>
                    <div><span>PUSD returned to your wallet</span><strong>{formatAssetAmount("PUSD", pusdTransferPlan.changePusdAmount)} PUSD</strong></div>
                    <div><span>Estimated BCH miner fee</span><strong>{pusdTransferPlan.minerFeeSatoshis.toString()} sats</strong></div>
                    <div><span>Recipient token carrier</span><strong>{pusdTransferPlan.recipientCarrierSatoshis.toString()} sats</strong></div>
                    <div><span>Selected authenticated inputs</span><strong>{pusdTransferPlan.selectedUtxos.length}</strong></div>
                    <small>Estimated size {pusdTransferPlan.estimatedSizeBytes} bytes · fee rate {pusdTransferPlan.feeRateSatoshisPerKb.toString()} sats/kB. The plan must be rebuilt from fresh chain data before any signature.</small>
                  </div>
                )}
                <button type="button" className="primary-button" disabled={!PUSD_MAINNET_SPENDING_ENABLED || !pusdTransferPlan}
                  title="PUSD Mainnet spending is not yet approved by the security release gate">
                  Send PUSD · Mainnet locked
                </button>
                <small className="field-hint">PUSD sending stays locked until raw transaction inspection, independent wallet testing, fee/carrier validation, and security review are completed. This preview is not a payment.</small>
              </div>
              <div className="asset-detail-row"><span>Token category</span><code>{PUSD_ASSET.categoryId}</code></div>
              <div className="asset-detail-row"><span>Display precision</span><b>2 decimals</b></div>
              <div className="asset-detail-row"><span>PUSD circle covenant</span><b className="locked-state">Mainnet V3 build · signing locked</b></div>
            </article>
          </section>
        )}

        {page === "activity" && (
          <section className="page-section">
            <div className="page-intro">
              <span className="section-kicker">ON-CHAIN RECORDS</span>
              <h1>Activity and records</h1>
              <p>Circle state is refreshed from the chain. Local saved circles are only bookmarks, not evidence of funds.</p>
            </div>
            <article className="asset-detail-card activity-panel">
              <div className="asset-detail-heading">
                <span className="status-card-icon"><Activity size={18} /></span>
                <div><span className="section-kicker">VERIFICATION POLICY</span><h2>Chain-backed records only</h2>
                  <p>Unconfirmed transfers, mixed-input contributions, duplicate receipts and reorged transactions must not be credited.</p></div>
              </div>
              <div className="asset-detail-row"><span>Member receipt accounting</span><b>V2 BCH covenant</b></div>
              <div className="asset-detail-row"><span>Append-only receipt model</span><b>Imported and tested</b></div>
              <div className="asset-detail-row"><span>PUSD circle transactions</span><b className="locked-state">Not enabled</b></div>
            </article>
          </section>
        )}
      </div>

      {walletView.error && <div className="global-wallet-error" role="alert"><ShieldCheck size={17} /><span>{walletView.error}</span><button onClick={() => walletClient?.startFreshPairing()}>Fresh pairing</button></div>}

      {showWallet && (
        <div className="modal-backdrop wallet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowWallet(false); }}>
          <section className="create-modal wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-title">
            <div className="modal-heading">
              <div><span className="section-kicker">WIZARDCONNECT · SELENE</span><h2 id="wallet-title">{connected ? "Wallet details" : "Connect your wallet"}</h2>
                <p>{connected ? "Your public receive address for the selected BCH network." : "Pair with Selene. Your seed phrase and private keys stay in your wallet."}</p></div>
              <button className="modal-close" onClick={() => setShowWallet(false)} aria-label="Close"><X size={19} /></button>
            </div>
            {connected ? (
              <div className="wallet-detail-body">
                <div className="wallet-address-card"><span>{NETWORKS[network].label}</span><code>{walletAddress ?? "Address not available yet"}</code><small>Receive index {walletView.receiveIndex} · public address only</small></div>
                <label className="field-label" htmlFor="selene-address">Match the receive address shown in Selene</label>
                <input id="selene-address" className="form-control" value={seleneAddress} onChange={(event) => setSeleneAddress(event.target.value)} placeholder="Paste Selene receive address" autoComplete="off" />
                <button className="primary-button" onClick={() => {
                  try {
                    const index = walletClient?.matchReceiveAddress(seleneAddress, network, 50) ?? null;
                    setAddressMatchMessage(index === null
                      ? "No match in receive indices 0–50. Check Selene's selected network before sending funds."
                      : "Matched Selene receive address at index " + index + ".");
                  } catch (cause) { setAddressMatchMessage(cause instanceof Error ? cause.message : "Could not match address."); }
                }}>Match Selene address</button>
                {addressMatchMessage && <p className="wallet-match-message" role="status">{addressMatchMessage}</p>}
                <button className="secondary-button" onClick={() => void walletClient?.disconnect()}>Disconnect wallet</button>
              </div>
            ) : (
              <div className="wallet-detail-body">
                {qrDataUrl && <img className="wallet-qr" src={qrDataUrl} alt="WizardConnect pairing QR code" />}
                {walletView.uri && <a className="primary-button wallet-open-link" href={walletView.uri}>Open in Selene <ArrowRight size={15} /></a>}
                {walletView.state === "connecting" && <p className="wallet-match-message">Approve the WizardConnect session in Selene, then return here.</p>}
                {walletView.error && <p className="wallet-match-message" role="alert">{walletView.error}</p>}
                <div className="wallet-modal-actions">
                  <button className="primary-button" onClick={() => {
                    if (!walletClient) { openWallet(); return; }
                    if (walletClient.state === "disconnected") { if (!walletClient.tryResume()) walletClient.connect(); }
                    else if (walletClient.state === "idle") walletClient.connect();
                    else if (walletClient.state === "connecting" || walletClient.state === "reconnecting") walletClient.startFreshPairing();
                  }}>{walletView.state === "reconnecting" ? "Start fresh pairing" : "Retry / connect Selene"}</button>
                  <button className="secondary-button" onClick={() => setShowWallet(false)}>Close</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
      <footer className="app-footer"><span>© 2026 AjoChain</span><span><span className="footer-dot" /> {network === "chipnet" ? "Chipnet testing" : "Mainnet read-only"}</span></footer>
    </main>
  );
}
