import { useEffect, useMemo, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import {
  Activity, ArrowRight, ArrowUpRight, Check, ChevronDown,
  CircleDollarSign, Clock3, CreditCard, LockKeyhole, Plus, ShieldCheck,
  Sparkles, Users, Wallet, X,
} from "lucide-react";
import { wallet } from "./core/wizard-wallet";
import { isAddressForNetwork, NETWORKS, type NetworkId } from "./core/network";
import { validateCircleDraft, type ContributionFrequency } from "./core/circle";
import type { CircleAsset } from "./core/member-ledger";
import { CLOSED_MAINNET_GATES, MAINNET_GATE_KEYS, MAINNET_GATE_LABELS, evaluateMainnetFlow } from "./core/mainnet-flow";
import { formatAssetAmount, isAssetAvailableOnNetwork, parseAssetAmount, PUSD_ASSET } from "./core/assets";
import { fetchPusdWalletBalance } from "./core/pusd-api";

type CircleDraftView = {
  name: string;
  asset: CircleAsset;
  amount: string;
  frequency: ContributionFrequency;
  members: string[];
};

const scheduleLabels: Record<ContributionFrequency, string> = {
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
};

export default function App() {
  const [network, setNetwork] = useState<NetworkId>("mainnet");
  const [showNetworks, setShowNetworks] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const [activeNav, setActiveNav] = useState("overview");
  const [walletView, setWalletView] = useState({ state: wallet.state, uri: wallet.uri, qrUri: wallet.qrUri, walletName: wallet.walletName, error: wallet.error, receiveIndex: wallet.receiveIndex });
  const [showWallet, setShowWallet] = useState(false);
  const [seleneAddress, setSeleneAddress] = useState("");
  const [addressMatchMessage, setAddressMatchMessage] = useState("");
  const [pusdRecipient, setPusdRecipient] = useState("");
  const [pusdAmount, setPusdAmount] = useState("");
  const [pusdReview, setPusdReview] = useState("");
  const [pusdRefresh, setPusdRefresh] = useState(0);
  const [pusdBalanceView, setPusdBalanceView] = useState<{
    status: "idle" | "loading" | "ready" | "error";
    amount: bigint;
    detail: string;
    utxoCount: number;
  }>({ status: "idle", amount: 0n, detail: "Connect a wallet on Mainnet to check PUSD.", utxoCount: 0 });
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [circleName, setCircleName] = useState("");
  const [asset, setAsset] = useState<CircleAsset>("BCH");
  const [amount, setAmount] = useState("0.01");
  const [frequency, setFrequency] = useState<ContributionFrequency>("weekly");
  const [membersText, setMembersText] = useState("You\nMember 2");
  const [draft, setDraft] = useState<CircleDraftView | null>(() => {
    try {
      const saved = window.localStorage.getItem("ajochain-circle-draft-v1");
      if (!saved) return null;
      const parsed = JSON.parse(saved) as CircleDraftView;
      if (typeof parsed.name !== "string" || !["BCH", "PUSD"].includes(parsed.asset) ||
          typeof parsed.amount !== "string" || !["daily", "weekly", "monthly"].includes(parsed.frequency) ||
          !Array.isArray(parsed.members) || parsed.members.length < 2 ||
          !parsed.members.every((member) => typeof member === "string")) return null;
      return parsed;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    try {
      if (draft) window.localStorage.setItem("ajochain-circle-draft-v1", JSON.stringify(draft));
      else window.localStorage.removeItem("ajochain-circle-draft-v1");
    } catch {
      // Storage may be unavailable in private browsing; the current session still works.
    }
  }, [draft]);

  useEffect(() => {
    const syncWallet = () => setWalletView({
      state: wallet.state, uri: wallet.uri, qrUri: wallet.qrUri,
      walletName: wallet.walletName, error: wallet.error, receiveIndex: wallet.receiveIndex,
    });
    const unsubscribe = wallet.onChange(syncWallet);
    syncWallet();
    wallet.tryResume();
    return unsubscribe;
  }, []);

  useEffect(() => {
    let active = true;
    if (walletView.qrUri) {
      void QRCode.toDataURL(walletView.qrUri, { errorCorrectionLevel: "M", margin: 1, width: 240 })
        .then((url) => { if (active) setQrDataUrl(url); })
        .catch(() => { if (active) setQrDataUrl(""); });
    } else {
      setQrDataUrl("");
    }
    return () => { active = false; };
  }, [walletView.qrUri]);

  const mainnetReadiness = evaluateMainnetFlow(CLOSED_MAINNET_GATES);
  const walletAddress = wallet.address(network);

  useEffect(() => {
    let active = true;
    if (network !== "mainnet" || walletView.state !== "connected" || !walletAddress) {
      setPusdBalanceView({
        status: "idle",
        amount: 0n,
        detail: network !== "mainnet"
          ? "PUSD is available only on Bitcoin Cash Mainnet."
          : "Connect a wallet on Mainnet to check PUSD.",
        utxoCount: 0,
      });
      return () => { active = false; };
    }

    setPusdBalanceView({
      status: "loading",
      amount: 0n,
      detail: "Checking raw PUSD outputs and current unspent state across the configured Electrum quorum…",
      utxoCount: 0,
    });
    void fetchPusdWalletBalance(walletAddress)
      .then((result) => {
        if (!active) return;
        setPusdBalanceView({
          status: "ready",
          amount: result.balance,
          detail: result.providerConfidence + " Electrum servers agreed · block " +
            result.tipHeight.toLocaleString() + " · " + result.utxos.length + " authenticated PUSD UTXOs",
          utxoCount: result.utxos.length,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setPusdBalanceView({
          status: "error",
          amount: 0n,
          detail: error instanceof Error ? error.message : "PUSD balance verification failed.",
          utxoCount: 0,
        });
      });

    return () => { active = false; };
  }, [network, walletView.state, walletAddress, pusdRefresh]);
  const connectWallet = () => {
    if (wallet.state === "disconnected") {
      if (!wallet.tryResume()) wallet.connect();
    } else if (wallet.state === "idle") {
      wallet.connect();
    }
    setShowWallet(true);
  };
  const selected = NETWORKS[network];
  const members = useMemo(
    () => membersText.split("\n").map((name) => name.trim()).filter(Boolean),
    [membersText],
  );
  const validation = useMemo(() => validateCircleDraft({
    name: circleName,
    asset,
    contributionAmount: amount,
    frequency,
    members: members.map((name) => ({ name })),
  }), [circleName, asset, amount, frequency, members]);
  const assetNetworkSupported = isAssetAvailableOnNetwork(asset, network);

  const openCreate = () => {
    if (draft) {
      setCircleName(draft.name);
      setAsset(draft.asset);
      setAmount(draft.amount);
      setFrequency(draft.frequency);
      setMembersText(draft.members.join("\n"));
    }
    setAttemptedSubmit(false);
    setShowCreate(true);
  };

  const removeDraft = () => {
    setDraft(null);
    setCircleName("");
    setAsset("BCH");
    setAmount("0.01");
    setFrequency("weekly");
    setMembersText("You\nMember 2");
  };

  const handleDraftSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttemptedSubmit(true);
    if (!validation.valid || !assetNetworkSupported) return;
    setDraft({ name: circleName.trim(), asset, amount: amount.trim(), frequency, members });
    setShowCreate(false);
    setActiveNav("circles");
  };

  const closeCreate = () => {
    setShowCreate(false);
    setAttemptedSubmit(false);
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" onClick={() => setActiveNav("overview")} aria-label="AjoChain home">
          <span className="brand-mark">a</span><span>AjoChain</span>
        </a>
        <div className="workspace-label">YOUR SPACE</div>
        <nav aria-label="Main navigation">
          <a className={activeNav === "overview" ? "nav-item active" : "nav-item"} href="#overview" onClick={() => setActiveNav("overview")}>
            <Activity size={18} /><span>Overview</span>
          </a>
          <a className={activeNav === "circles" ? "nav-item active" : "nav-item"} href="#circles" onClick={() => setActiveNav("circles")}>
            <Users size={18} /><span>My circles</span>
          </a>
          <a className={activeNav === "activity" ? "nav-item active" : "nav-item"} href="#activity" onClick={() => setActiveNav("activity")}>
            <CreditCard size={18} /><span>Activity</span>
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div className="security-note">
            <ShieldCheck size={18} />
            <span><b>Built with care</b><small>Transactions stay locked until verification is complete.</small></span>
          </div>
          <div className="profile">
            <div className="avatar">{walletView.state === "connected" ? "W" : "A"}</div>
            <span><b>{walletView.walletName ?? "Personal workspace"}</b><small>{walletView.state === "connected" ? "Wallet connected" : walletView.state === "reconnecting" ? "Restoring Selene session" : "No wallet connected"}</small></span>
          </div>
        </div>
      </aside>

      <section className="main-panel" id="overview">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> <b>{activeNav === "activity" ? "Activity" : activeNav === "circles" ? "My circles" : "Overview"}</b></div>
          <div className="top-actions">
            <div className="network-wrap">
              <button className="network-button" onClick={() => setShowNetworks(!showNetworks)} aria-expanded={showNetworks}>
                <span className={network === "mainnet" ? "network-dot live" : "network-dot"} />
                <span>{network === "mainnet" ? "Mainnet" : "Chipnet"}</span><ChevronDown size={14} />
              </button>
              {showNetworks && (
                <div className="network-menu">
                  {(["mainnet", "chipnet"] as NetworkId[]).map((id) => (
                    <button key={id} onClick={() => { setNetwork(id); setShowNetworks(false); }}>
                      <span className={id === "mainnet" ? "network-dot live" : "network-dot"} />{NETWORKS[id].label}
                      {network === id && <Check size={14} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className={walletView.state === "connected" ? "connect-button connected" : "connect-button"}
              onClick={() => walletView.state === "connected" ? setShowWallet(true) : connectWallet()}>
              <Wallet size={16} /><span>{walletView.state === "connected" ? (walletView.walletName ?? "Wallet connected") : walletView.state === "reconnecting" ? "Reconnecting…" : walletView.state === "connecting" ? "Waiting for Selene…" : "Connect wallet"}</span>
              {walletView.state === "connected" && <ChevronDown size={14} />}
            </button>
          </div>
        </header>

        <div className="content">
          <section className="hero">
            <div className="hero-copy">
              <div className="eyebrow"><span className="eyebrow-line" /> SAVING IS BETTER TOGETHER</div>
              <h1>Small steps.<br /><em>Shared progress.</em></h1>
              <p className="intro">Build a savings circle with your people. Keep every contribution clear, every member accountable, and every goal in sight.</p>
              <div className="hero-actions">
                <button className="primary-button" onClick={openCreate}><Plus size={17} /> Start a circle</button>
                <a className="subtle-link" href="#how-it-works" onClick={() => setActiveNav("overview")}>How it works <ArrowUpRight size={15} /></a>
              </div>
            </div>
            <div className="hero-visual" aria-hidden="true">
              <div className="visual-ring ring-back" />
              <div className="visual-ring ring-front" />
              <div className="visual-core"><span>₿</span><small>together</small></div>
              <div className="visual-bubble bubble-one"><Users size={17} /></div>
              <div className="visual-bubble bubble-two"><Sparkles size={16} /></div>
              <span className="visual-spark">✳</span>
            </div>
          </section>

          <section className="network-notice" aria-live="polite">
            <div className="notice-icon"><ShieldCheck size={18} /></div>
            <div className="notice-copy">
              <b>{network === "mainnet" ? "Mainnet preview is protected" : "Chipnet preview is protected"}</b>
              <span>{walletView.state === "connected"
                ? "Connected with " + (walletView.walletName ?? "a WizardConnect wallet") + ". Receive address " + (walletAddress ? walletAddress.slice(0, 18) + "…" : "is being derived") + ". Transaction actions remain disabled pending verification."
                : walletView.state === "reconnecting"
                  ? "Selene session interrupted. AjoChain is trying to restore the saved session."
                  : "Connect Selene or another WizardConnect wallet. Signing and broadcasting remain disabled in this build."}</span>
            </div>
            <span className="read-only-pill"><LockKeyhole size={11} /> READ ONLY</span>
          </section>
          {network === "mainnet" && (
            <section className="mainnet-readiness section-card" aria-labelledby="mainnet-readiness-title">
              <div className="mainnet-readiness-heading">
                <div>
                  <span className="section-kicker">BCH BLAZE · MAINNET RELEASE CONTROL</span>
                  <h2 id="mainnet-readiness-title">Mainnet transaction readiness</h2>
                  <p>This build is in read-only mode. No user action can mark a safety gate as passed.</p>
                </div>
                <span className="mainnet-blocked"><LockKeyhole size={13} /> BROADCAST BLOCKED</span>
              </div>
              <div className="mainnet-progress">
                <span>Verified release gates</span><strong>{MAINNET_GATE_KEYS.length - mainnetReadiness.missing.length} / {MAINNET_GATE_KEYS.length}</strong>
                <div className="mainnet-progress-track"><span style={{ width: "0%" }} /></div>
              </div>
              <ul className="mainnet-gate-list">
                {MAINNET_GATE_KEYS.map((key, index) => (
                  <li key={key}>
                    <span className="mainnet-gate-number">{String(index + 1).padStart(2, "0")}</span>
                    <span>{MAINNET_GATE_LABELS[key]}</span>
                    <span className="mainnet-gate-status"><LockKeyhole size={12} /> Pending</span>
                  </li>
                ))}
              </ul>
              <p className="mainnet-readiness-foot">The release guard is fail-closed. Wallet connection, a local circle draft, or selecting Mainnet does not authorize signing or broadcasting.</p>
            </section>
          )}
          {walletView.error && (
            <section className="wallet-error" role="alert">
              <ShieldCheck size={17} /><div><b>Wallet connection needs attention</b><span>{walletView.error}</span></div>
              {walletView.state !== "connected" && <button className="text-action" onClick={() => wallet.startFreshPairing()}>Fresh pairing</button>}
            </section>
          )}

          <section className="metrics-grid" aria-label="Savings overview">
            <article className="metric-card">
              <div className="metric-icon sage"><CircleDollarSign size={18} /></div>
              <span className="metric-label">Total contributed</span>
              <strong>—</strong>
              <small>Appears when verified activity is available</small>
            </article>
            <article className="metric-card">
              <div className="metric-icon lilac"><Users size={18} /></div>
              <span className="metric-label">Active circles</span>
              <strong>{draft ? "1 draft" : "0"}</strong>
              <small>{draft ? "One local preview, not yet on-chain" : "Your circles will live here"}</small>
            </article>
            <article className="metric-card">
              <div className="metric-icon sand"><Clock3 size={18} /></div>
              <span className="metric-label">Next contribution</span>
              <strong>—</strong>
              <small>Schedules appear after a circle is active</small>
            </article>
          </section>

          <section className="workspace-grid">
            <div className="section-card circles-card" id="circles">
              <div className="section-heading">
                <div><span className="section-kicker">YOUR SAVINGS GROUPS</span><h2>My circles</h2><p>Stay close to the goals you are building together.</p></div>
                <button className="icon-button" aria-label="Start a circle" onClick={openCreate}><Plus size={18} /></button>
              </div>
              {draft ? (
                <div className="draft-card">
                  <div className="draft-card-top">
                    <div className="draft-avatar"><Users size={19} /></div>
                    <span className="draft-status">LOCAL DRAFT</span>
                  </div>
                  <h3>{draft.name}</h3>
                  <p className="draft-summary">{draft.members.length} members · {scheduleLabels[draft.frequency].toLowerCase()}</p>
                  <div className="draft-amount"><strong>{draft.amount}</strong><span>{draft.asset} per member</span></div>
                  <div className="draft-members">{draft.members.slice(0, 4).map((member, index) => <span key={`${member}-${index}`}>{member.slice(0, 1).toUpperCase()}</span>)}<small>{draft.members.length} people listed</small></div>
                  <div className="draft-warning"><LockKeyhole size={14} /> This is a page-only preview. It has not been saved on-chain or sent to a wallet.</div>
                  <div className="draft-actions">
                    <button className="text-action" onClick={openCreate}>Edit draft <ArrowRight size={14} /></button>
                    <button className="draft-delete" onClick={removeDraft}>Delete draft</button>
                  </div>
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-illustration"><Users size={26} /><span>+</span></div>
                  <h3>Your first circle starts here</h3>
                  <p>Bring at least two people together, choose BCH or PUSD, and set a rhythm that works for everyone.</p>
                  <button className="text-action" onClick={openCreate}>Set up your first circle <ArrowRight size={15} /></button>
                </div>
              )}
            </div>

            <aside className="section-card guide-card" id="how-it-works">
              <div className="guide-heading"><div className="guide-icon"><Sparkles size={18} /></div><span>THE AJOCHAIN WAY</span></div>
              <h2>Good habits.<br /><em>Shared momentum.</em></h2>
              <div className="guide-step"><span>01</span><div><b>Bring your people</b><small>Start with at least two members.</small></div></div>
              <div className="guide-step"><span>02</span><div><b>Agree on the rhythm</b><small>Choose BCH or PUSD and a schedule.</small></div></div>
              <div className="guide-step"><span>03</span><div><b>Every member keeps contributing</b><small>Receiving a payout does not cancel your next-round obligation.</small></div></div>
              <div className="guide-step"><span>04</span><div><b>No payout if someone falls behind</b><small>Each member must fund their own round credit before the pot can move.</small></div></div>
              <div className="guide-foot"><ShieldCheck size={15} /> Your credit stays yours; one member cannot cover another member\’s shortfall.</div>
            </aside>
          </section>

          <section className="section-card activity-card" id="activity">
            <div className="section-heading">
              <div><span className="section-kicker">YOUR LATEST MOVEMENT</span><h2>Recent activity</h2><p>Verified contributions and payouts will be shown here.</p></div>
              <span className="coming-soon">AWAITING VERIFICATION</span>
            </div>
            <div className="activity-empty"><div className="activity-icon"><Activity size={18} /></div><span>No transactions to show yet.</span><small>Transaction history will appear after wallet, network and contract checks pass.</small></div>
          </section>

          <section className="verification-strip">
            <div><div className="verification-icon"><LockKeyhole size={17} /></div><span><b>Mainnet safeguards</b><small>Wallet validation · transaction inspection · contract review</small></span></div>
            <span className="verification-state"><span className="state-dot" /> Verification in progress</span>
          </section>
          <footer><span>© 2026 AjoChain</span><span><span className="footer-dot" /> Independent BCH build · {selected.label}</span></footer>
        </div>
      </section>

      {showCreate && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCreate(); }}>
          <section className="create-modal" role="dialog" aria-modal="true" aria-labelledby="create-title">
            <div className="modal-heading">
              <div><span className="section-kicker">NEW SAVINGS GROUP</span><h2 id="create-title">Set up your circle</h2><p>Start with the basics. You can review everything before any wallet action.</p></div>
              <button className="modal-close" onClick={closeCreate} aria-label="Close"><X size={19} /></button>
            </div>
            <form onSubmit={handleDraftSubmit} noValidate>
              <label className="field-label" htmlFor="circle-name">Circle name</label>
              <input id="circle-name" className="form-control" value={circleName} onChange={(event) => setCircleName(event.target.value)} placeholder="e.g. Family goals" maxLength={40} />
              <div className="field-row">
                <div><label className="field-label" htmlFor="circle-asset">Savings asset</label>
                  <select id="circle-asset" className="form-control" value={asset} onChange={(event) => setAsset(event.target.value as CircleAsset)}>
                    <option value="BCH">Bitcoin Cash (BCH)</option><option value="PUSD">ParyonUSD (PUSD)</option>
                  </select>
                  {asset === "PUSD" && <small className="field-hint">PUSD mainnet CashToken · 2 decimals · category {PUSD_ASSET.categoryId.slice(0, 10)}… verified. Draft preview only; transfers are not enabled.</small>}
                </div>
                <div><label className="field-label" htmlFor="circle-amount">Contribution per member</label>
                  <input id="circle-amount" className="form-control" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={asset === "PUSD" ? "10.00" : "0.01"} />
                  <small className="field-hint">{asset === "PUSD" ? "PUSD amount, up to 2 decimal places" : "BCH amount, up to 8 decimal places"}</small>
                </div>
              </div>
              <label className="field-label" htmlFor="circle-frequency">Contribution schedule</label>
              <select id="circle-frequency" className="form-control" value={frequency} onChange={(event) => setFrequency(event.target.value as ContributionFrequency)}>
                <option value="weekly">Every week</option><option value="daily">Every day</option><option value="monthly">Every month</option>
              </select>
              <label className="field-label" htmlFor="circle-members">Member names <span>One name per line · minimum 2</span></label>
              <textarea id="circle-members" className="form-control members-input" value={membersText} onChange={(event) => setMembersText(event.target.value)} rows={4} placeholder={"You\nMember 2"} />
              <div className="member-count"><Users size={14} /> {members.length} member{members.length === 1 ? "" : "s"} listed <span>At least 2 required</span></div>
              {attemptedSubmit && (!validation.valid || !assetNetworkSupported) && (
                <div className="form-errors" role="alert">
                  {validation.errors.map((error) => <p key={error}>{error}</p>)}
                  {!assetNetworkSupported && <p>PUSD is a Bitcoin Cash mainnet token. Switch the app network to Mainnet; there is no verified PUSD Chipnet category configured.</p>}
                </div>
              )}
              <div className="draft-disclaimer"><ShieldCheck size={16} /><span><b>Safe preview only</b><small>This creates a temporary on-screen draft. Wallet addresses and member identities are not verified, and no transaction is signed or broadcast.</small></span></div>
              <div className="modal-actions"><button type="button" className="secondary-button" onClick={closeCreate}>Cancel</button><button type="submit" className="primary-button"><span>Preview circle</span><ArrowRight size={16} /></button></div>
            </form>
          </section>
        </div>
      )}
      {showWallet && (
        <div className="modal-backdrop wallet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowWallet(false); }}>
          <section className="create-modal wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-title">
            <div className="modal-heading">
              <div><span className="section-kicker">WIZARDCONNECT · SELENE</span><h2 id="wallet-title">{walletView.state === "connected" ? "Wallet details" : "Connect your wallet"}</h2>
                <p>{walletView.state === "reconnecting" ? "Restoring your saved mobile wallet session…" : walletView.state === "connected" ? "Connected to " + (walletView.walletName ?? "your BCH wallet") + "." : "Pair with Selene. Your seed phrase and private keys stay in your wallet."}</p></div>
              <button className="modal-close" onClick={() => setShowWallet(false)} aria-label="Close"><X size={19} /></button>
            </div>
            {walletView.state === "connected" ? (
              <div className="wallet-detail-body">
                <div className="wallet-address-card"><span>Selected network · {NETWORKS[network].label}</span><code>{walletAddress ?? "Address unavailable"}</code><small>Receive index {walletView.receiveIndex} · public address only</small></div>
                <label className="field-label" htmlFor="selene-address">Match the receive address shown in Selene</label>
                <input id="selene-address" className="form-control" value={seleneAddress} onChange={(event) => setSeleneAddress(event.target.value)} placeholder="Paste Selene BCH receive address" autoComplete="off" />
                <button className="primary-button" onClick={() => {
                  try {
                    const index = wallet.matchReceiveAddress(seleneAddress, network, 50);
                    setAddressMatchMessage(index === null ? "No match in receive indices 0–50. Do not send funds; check Selene’s selected network and public derivation details." : "Matched Selene receive address at index " + index + ".");
                  } catch (error) { setAddressMatchMessage(error instanceof Error ? error.message : "Could not match address."); }
                }}>Match Selene address</button>
                {addressMatchMessage && <p className="wallet-match-message" role="status">{addressMatchMessage}</p>}
                <section className="section-card" aria-labelledby="pusd-wallet-title">
                  <div className="section-heading">
                    <div><span className="section-kicker">CASH TOKENS · MAINNET ONLY</span><h2 id="pusd-wallet-title">ParyonUSD wallet</h2><p>Token category is pinned to the issuer-published PUSD ID.</p></div>
                  </div>
                  <div className="wallet-address-card">
                    <span>PUSD balance</span>
                    <strong>{pusdBalanceView.status === "ready"
                      ? formatAssetAmount("PUSD", pusdBalanceView.amount) + " PUSD"
                      : pusdBalanceView.status === "loading" ? "Checking…" :
                        pusdBalanceView.status === "error" ? "Unavailable" : "Not yet verified"}</strong>
                    <small>{pusdBalanceView.detail}</small>
                    <button className="text-action" disabled={pusdBalanceView.status === "loading"}
                      onClick={() => setPusdRefresh((value) => value + 1)}>
                      Refresh verified balance <ArrowRight size={13} />
                    </button>
                  </div>
                  <div className="wallet-address-card">
                    <span>Canonical PUSD category</span>
                    <code>{PUSD_ASSET.categoryId}</code>
                    <small>2 decimal places · Mainnet only</small>
                  </div>
                  <label className="field-label" htmlFor="pusd-recipient">Recipient BCH address</label>
                  <input id="pusd-recipient" className="form-control" value={pusdRecipient} onChange={(event) => { setPusdRecipient(event.target.value); setPusdReview(""); }} placeholder="bitcoincash:…" autoComplete="off" />
                  <label className="field-label" htmlFor="pusd-amount">PUSD amount</label>
                  <input id="pusd-amount" className="form-control" inputMode="decimal" value={pusdAmount} onChange={(event) => { setPusdAmount(event.target.value); setPusdReview(""); }} placeholder="0.00" />
                  <button className="primary-button" onClick={() => {
                    try {
                      if (network !== "mainnet") throw new Error("PUSD is not configured on Chipnet. Switch to Mainnet.");
                      if (!isAddressForNetwork(pusdRecipient, "mainnet")) throw new Error("Enter a valid Bitcoin Cash mainnet address.");
                      const units = parseAssetAmount("PUSD", pusdAmount);
                      setPusdReview("Details valid: " + formatAssetAmount("PUSD", units) + " PUSD to " + pusdRecipient + ". This is a local review only; balance, UTXOs, BCH fees and transaction outputs are not yet verified.");
                    } catch (error) {
                      setPusdReview(error instanceof Error ? error.message : "Could not validate transfer details.");
                    }
                  }}>Validate transfer details</button>
                  {pusdReview && <p className="wallet-match-message" role="status">{pusdReview}</p>}
                  <p className="wallet-match-message">PUSD balance and UTXOs are verified through raw previous transactions and a live Electrum quorum when the API is configured. Spending remains disabled until fee/carrier planning, transaction signing tests, deployment checks and independent release review are complete.</p>
                </section>
                <button className="secondary-button" onClick={() => void wallet.disconnect()}>Disconnect wallet</button>
              </div>
            ) : (
              <div className="wallet-detail-body">
                {qrDataUrl && <img className="wallet-qr" src={qrDataUrl} alt="WizardConnect pairing QR code" />}
                {walletView.uri && <a className="primary-button wallet-open-link" href={walletView.uri}>Open in Selene <ArrowUpRight size={15} /></a>}
                {walletView.state === "connecting" && <p className="wallet-match-message">Waiting for Selene to approve the WizardConnect session. Keep this page open while switching apps.</p>}
                {walletView.error && <p className="wallet-match-message" role="alert">{walletView.error}</p>}
                <div className="wallet-modal-actions">
                  <button className="primary-button" onClick={() => {
                    if (wallet.state === "disconnected") {
                      if (!wallet.tryResume()) wallet.connect();
                    } else if (wallet.state === "idle") {
                      wallet.connect();
                    } else if (wallet.state === "connecting" || wallet.state === "reconnecting") {
                      wallet.startFreshPairing();
                    }
                  }}>
                    {walletView.state === "disconnected" ? "Retry saved session" : walletView.state === "connecting" || walletView.state === "reconnecting" ? "Start fresh pairing" : "Connect with WizardConnect"}
                  </button>
                  <button className="secondary-button" onClick={() => setShowWallet(false)}>Close</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
