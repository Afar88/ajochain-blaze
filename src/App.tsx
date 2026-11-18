import { lazy, Suspense, useEffect, useState } from "react";
import {
  Activity, ArrowRight, Check, ChevronDown, Coins, Home,
  Monitor, MoreVertical, Moon, ShieldCheck, Sun, Users, Wallet, X,
} from "lucide-react";
import { getDefaultNetwork, NETWORKS, type NetworkId } from "./core/network-config";
import { getDefaultCircleWorkspace, resolveCircleWorkspaceForNetwork, type CircleWorkspaceId } from "./core/circle-network-options";
import { formatAssetAmount, parseAssetAmount, PUSD_ASSET } from "./core/assets";
import type { PusdTransferPlan } from "./core/pusd-transaction-builder";
import type { AuthenticatedPusdUtxo } from "./core/pusd-utxo";
import { PUSD_MAINNET_SPENDING_ENABLED } from "./core/pusd-mainnet-guard";
import {
  dedupeSavedV2FeeCircleMenuRecords,
  getV2FeeCircleRecordIdentity,
} from "./core/v2-fee-circle-records";
const ClassicBchWorkspace = lazy(() => import("./components/ClassicBchWorkspace"));
const V2FeeBchWorkspace = lazy(() => import("./components/V2FeeBchWorkspace"));
const PusdMainnetCircleWorkspace = lazy(() => import("./components/PusdMainnetCircleWorkspace"));
const BchMainnetCircleWorkspace = lazy(() => import("./components/BchMainnetCircleWorkspace"));
const ActivityRecords = lazy(() => import("./components/ActivityRecords"));

type Page = "overview" | "create-circle" | "circle-detail" | "assets" | "activity";
type MenuCircle = { encoded: string; name: string; label: string };

const V2_MENU_STORAGE_KEY = "ajochain-blaze:v2-fee-circles:v1";
function readSavedV2MenuCircles(): MenuCircle[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(V2_MENU_STORAGE_KEY) || "[]");
    const unique = dedupeSavedV2FeeCircleMenuRecords(stored);
    const records = unique.flatMap((entry) => {
      const identity = getV2FeeCircleRecordIdentity(entry.encoded);
      return identity ? [{ ...entry, name: identity.name }] : [];
    });
    return records.map((record) => ({
      encoded: record.encoded,
      name: record.name,
      label: record.name,
    }));
  } catch {
    return [];
  }
}
type ThemePreference = "system" | "light" | "dark";
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
  "create-circle": "Create a circle",
  "circle-detail": "My circle",
  assets: "Assets",
  activity: "Activity",
};

export default function App() {
  const [network, setNetwork] = useState<NetworkId>(() => getDefaultNetwork(import.meta.env.PROD));
  const [page, setPage] = useState<Page>("overview");
  const [circleWorkspace, setCircleWorkspace] = useState<CircleWorkspaceId>(() => getDefaultCircleWorkspace(getDefaultNetwork(import.meta.env.PROD)));
  const [classicInviteRevision, setClassicInviteRevision] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuCircles, setMenuCircles] = useState<MenuCircle[]>(readSavedV2MenuCircles);
  const [selectedMenuCircle, setSelectedMenuCircle] = useState<string | null>(null);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    if (typeof window === "undefined") return "system";
    try {
      const saved = window.localStorage.getItem("ajochain-theme");
      return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
    } catch {
      return "system";
    }
  });
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
  const [pusdSignatureBusy, setPusdSignatureBusy] = useState(false);
  const [pusdSignatureMessage, setPusdSignatureMessage] = useState("");

  const walletAddress = walletClient?.address(network) ?? null;
  const connected = walletView.state === "connected";
  const menuLabel = page === "circle-detail"
    ? menuCircles.find((circle) => circle.encoded === selectedMenuCircle)?.name ?? "My circle"
    : pageLabels[page];

  useEffect(() => {
    const refreshSavedCircles = () => setMenuCircles(readSavedV2MenuCircles());
    window.addEventListener("storage", refreshSavedCircles);
    return () => window.removeEventListener("storage", refreshSavedCircles);
  }, []);

  // Discover circle invites registered by other members. The registry is only
  // a discovery index: every new invite is decoded and its live covenant
  // state/receipts are re-read from Chipnet before it is saved or shown.
  // Poll while connected so a circle created by another member appears without
  // requiring a link, a page refresh, or a wallet reconnection.
  useEffect(() => {
    let active = true;
    // Discovery is always for Chipnet circles, even when the production
    // workspace opens on Mainnet. Selecting a discovered circle switches its
    // detail view to Chipnet; the app's selected network must not hide it.
    if (walletView.state !== "connected" || !walletClient) {
      return () => { active = false; };
    }
    const addresses = walletClient.receiveAddresses("chipnet", 50);
    if (addresses.length === 0) return () => { active = false; };

    const syncDiscovery = async () => {
      try {
        const existing = readSavedV2MenuCircles();
        const { discoverVerifiedCircles, registerSavedCirclesForDiscovery } =
          await import("./core/circle-discovery-client");
        const savedInvites = existing.map((circle) => circle.encoded);
        const discovered = await discoverVerifiedCircles(addresses, savedInvites);
        // Recover circles created before the dedicated database was attached.
        // The helper checks member ownership from the connected receive branch
        // and verifies each live Chipnet state/receipt before registration.
        await registerSavedCirclesForDiscovery(addresses, savedInvites);
        if (!active) return;
        const existingRecords = existing.map((circle) => ({
          encoded: circle.encoded,
          savedAt: Date.now(),
        }));
        const merged = dedupeSavedV2FeeCircleMenuRecords([...discovered, ...existingRecords]);
        try {
          window.localStorage.setItem(V2_MENU_STORAGE_KEY, JSON.stringify(merged));
        } catch {
          // The current session can still display verified discoveries.
        }
        setMenuCircles(merged.flatMap((record) => {
          const identity = getV2FeeCircleRecordIdentity(record.encoded);
          return identity ? [{
            encoded: record.encoded,
            name: identity.name,
            label: identity.name,
          }] : [];
        }));
      } catch {
        // Missing backend configuration or a temporary outage must not block
        // normal wallet use or the existing share-link restoration flow.
      }
    };

    void syncDiscovery();
    const poll = window.setInterval(() => { void syncDiscovery(); }, 30_000);
    return () => {
      active = false;
      window.clearInterval(poll);
    };
  }, [walletView.state, walletView.receiveIndex, walletClient]);

  useEffect(() => {
    let active = true;
    let lastInviteHash = "";
    const restoreInviteFromHash = () => {
      const hash = window.location.hash;
      if (!hash.startsWith("#/classic/") || hash === lastInviteHash) return;
      lastInviteHash = hash;
      // Keep the Classic contract and CashScript dependencies lazy for normal app visits.
      void import("./core/circle-account").then(({ restoreClassicCircleFromInvite, saveClassicCircle }) => {
        if (!active) return;
        try {
          // Shared Classic invite URLs are directly restorable on a fresh device.
          // Save the decoded invite locally before attempting any network reads.
          const params = restoreClassicCircleFromInvite(window.location.href);
          saveClassicCircle(window.localStorage, params);
          setClassicInviteRevision((revision) => revision + 1);
          setNetwork(params.network);
          setCircleWorkspace("bch-classic");
          setPage("create-circle");
          setMenuOpen(false);
        } catch {
          // Do not silently switch workspaces for a malformed or unsupported link.
        }
      }).catch(() => {
        // Keep the app usable if the optional Classic invite module cannot load.
        lastInviteHash = "";
      });
    };
    restoreInviteFromHash();
    window.addEventListener("hashchange", restoreInviteFromHash);
    return () => {
      active = false;
      window.removeEventListener("hashchange", restoreInviteFromHash);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = themePreference === "system"
        ? (media.matches ? "dark" : "light")
        : themePreference;
      root.dataset.theme = resolved;
      root.style.colorScheme = resolved;
    };
    applyTheme();
    try {
      window.localStorage.setItem("ajochain-theme", themePreference);
    } catch {
      // The selected theme still works for this session when storage is unavailable.
    }
    if (themePreference !== "system") return;
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themePreference]);

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
    setPusdSignatureMessage("");
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

  const verifyPusdTransferSignature = async () => {
    setPusdSignatureMessage("");
    if (!walletClient || walletClient.state !== "connected" || !connected) {
      setPusdSignatureMessage("Connect Selene through WizardConnect before testing the PUSD signature path.");
      return;
    }
    if (network !== "mainnet" || pusdView.status !== "ready") {
      setPusdSignatureMessage("A verified Mainnet PUSD balance is required before signature verification.");
      return;
    }
    const senderAddress = walletClient.address("mainnet");
    if (!senderAddress || !pusdRecipient.trim()) {
      setPusdSignatureMessage("Confirm the connected sender address and a valid recipient address.");
      return;
    }
    if (!/^\d+$/.test(pusdMaxFee.trim())) {
      setPusdSignatureMessage("Maximum miner fee must be entered as whole satoshis.");
      return;
    }
    setPusdSignatureBusy(true);
    try {
      const [
        { buildPusdTransferPlan },
        { cashAddressToExpectedLockingBytecode, fetchPusdWalletBalance, fetchPusdFeeQuote },
      ] = await Promise.all([
        import("./core/pusd-transaction-builder"),
        import("./core/pusd-api"),
      ]);
      // Rebuild from a fresh authenticated UTXO snapshot and current fee quote
      // immediately before asking Selene to sign. Never sign the stale preview.
      const [freshBalance, feeQuote] = await Promise.all([
        fetchPusdWalletBalance(senderAddress),
        fetchPusdFeeQuote(),
      ]);
      const freshPlan = buildPusdTransferPlan({
        authenticatedUtxos: freshBalance.utxos,
        requiredPusdAmount: parseAssetAmount("PUSD", pusdAmount),
        recipientLockingBytecode: cashAddressToExpectedLockingBytecode(pusdRecipient),
        changeLockingBytecode: cashAddressToExpectedLockingBytecode(senderAddress),
        feeRateSatoshisPerKb: feeQuote.feeRateSatoshisPerKb,
        maxFeeSatoshis: BigInt(pusdMaxFee.trim()),
      });
      const verified = await walletClient.signAndVerify(
        freshPlan,
        freshPlan.walletInputs,
        "Verify PUSD Mainnet transfer to " + pusdRecipient.trim() + " (local verification only; never broadcast)",
      );
      setPusdTransferPlan(freshPlan);
      setPusdSignatureMessage(
        "Selene signed the freshly rebuilt PUSD transfer and AjoChain passed exact input/output comparison, CashTokens output comparison, 0x61 sighash checks and BCH 2026 VM verification (" +
        verified.decoded.inputs.length + " inputs, " + verified.decoded.outputs.length +
        " outputs). The signed bytes were discarded. Nothing was broadcast and no PUSD payment occurred.",
      );
      setPusdView((current) => ({
        ...current,
        amount: freshBalance.balance,
        utxos: freshBalance.utxos,
        rawPreviousTransactions: freshBalance.rawPreviousTransactions,
        tipHeight: freshBalance.tipHeight,
        providerConfidence: freshBalance.providerConfidence,
        utxoCount: freshBalance.utxos.length,
        detail: "Refreshed " + freshBalance.providerConfidence + " provider-authenticated wallet UTXOs immediately before local signature verification.",
      }));
    } catch (cause) {
      setPusdSignatureMessage(cause instanceof Error ? cause.message : "PUSD signature verification failed. Nothing was broadcast.");
    } finally {
      setPusdSignatureBusy(false);
    }
  };

  const openWallet = () => {
    setMenuOpen(false);
    setShowWallet(true);
    const start = (client: WalletClient) => {
      setWalletClient(client);
      if (client.state === "disconnected" || client.state === "idle") {
        // A fresh page starts idle even when an encrypted WizardConnect session
        // exists. Try that saved session before creating a new pairing.
        if (!client.tryResume()) client.connect();
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
    setCircleWorkspace((current) => resolveCircleWorkspaceForNetwork(current, next));
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
            {menuOpen ? <X size={19} /> : <MoreVertical size={21} />}
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
                <button className={page === "create-circle" ? "dropdown-item active" : "dropdown-item"} onClick={() => navigate("create-circle")}>
                  <Users size={17} /><span>Create a circle</span>{page === "create-circle" && <Check size={15} />}
                </button>
                {menuCircles.length > 0 && (
                  <>
                    <div className="dropdown-label circle-menu-label">YOUR CIRCLES</div>
                    {menuCircles.map((circle) => (
                      <button
                        key={circle.encoded}
                        className={page === "circle-detail" && selectedMenuCircle === circle.encoded ? "dropdown-item active" : "dropdown-item"}
                        onClick={() => {
                          setSelectedMenuCircle(circle.encoded);
                          setNetwork("chipnet");
                          setCircleWorkspace("bch-fair-round");
                          navigate("circle-detail");
                        }}
                      >
                        <Users size={16} /><span>{circle.label}</span>
                        {page === "circle-detail" && selectedMenuCircle === circle.encoded && <Check size={15} />}
                      </button>
                    ))}
                  </>
                )}
                <button className={page === "assets" ? "dropdown-item active" : "dropdown-item"} onClick={() => navigate("assets")}>
                  <Coins size={17} /><span>Assets & balances</span>{page === "assets" && <Check size={15} />}
                </button>
                <button className={page === "activity" ? "dropdown-item active" : "dropdown-item"} onClick={() => navigate("activity")}>
                  <Activity size={17} /><span>Activity & records</span>{page === "activity" && <Check size={15} />}
                </button>
              </nav>
              <div className="dropdown-divider" />
              <div className="dropdown-label">APPEARANCE</div>
              <div className="theme-choice" role="group" aria-label="Appearance">
                <button
                  type="button"
                  className={themePreference === "system" ? "theme-choice-item selected" : "theme-choice-item"}
                  aria-pressed={themePreference === "system"}
                  onClick={() => setThemePreference("system")}
                >
                  <Monitor size={15} /><span>System</span>
                </button>
                <button
                  type="button"
                  className={themePreference === "light" ? "theme-choice-item selected" : "theme-choice-item"}
                  aria-pressed={themePreference === "light"}
                  onClick={() => setThemePreference("light")}
                >
                  <Sun size={15} /><span>Light</span>
                </button>
                <button
                  type="button"
                  className={themePreference === "dark" ? "theme-choice-item selected" : "theme-choice-item"}
                  aria-pressed={themePreference === "dark"}
                  onClick={() => setThemePreference("dark")}
                >
                  <Moon size={15} /><span>Dark</span>
                </button>
              </div>
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
              <button className="primary-button hero-cta" type="button" onClick={() => navigate("create-circle")}>
                Create a circle <ArrowRight size={16} />
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
                <div><span className="asset-symbol">B</span><span><b>Bitcoin Cash</b><small>Chipnet testing · Mainnet V3 genesis preview only</small></span><span className="asset-state">Available</span></div>
                <div><span className="asset-symbol pusd-symbol">P</span><span><b>ParyonUSD</b><small>Mainnet identity pinned · verified balance requires the quorum API</small></span><span className="asset-state neutral">Read only</span></div>
              </div>
              <button type="button" className="text-action" onClick={() => navigate("assets")}>View asset details <ArrowRight size={14} /></button>
            </section>
          </>
        )}

        {page === "create-circle" && (
          <section className="page-section">
            <div className="page-intro">
              <span className="section-kicker">YOUR SAVINGS GROUPS</span>
              <h1>Create a circle</h1>
              <p>{network === "mainnet" ? "BCH and PUSD are available together as separate Mainnet circle workspaces. Prepare each asset independently; signing and broadcast remain locked pending release approval." : "Choose the Chipnet circle model you want to create. Each saved circle will appear as its own named menu item."}</p>
            </div>
            <section className="circle-choice-guide" aria-label="Choose a circle type">
              <div className="circle-choice-heading">
                <div><span className="section-kicker">CHOOSE YOUR CIRCLE</span><h2>What kind of circle do you want?</h2>
                  <p>{network === "mainnet" ? "Both Mainnet asset workspaces are shown below, so you can prepare BCH and PUSD circles without switching assets." : "Choose the Chipnet circle rules that suit your group. Chipnet funds have no real-money value."}</p></div>
              </div>
              <div className="circle-choice-grid">
                {network === "mainnet" && <>
                <button type="button" className={circleWorkspace === "bch-mainnet" ? "circle-choice-card selected" : "circle-choice-card"} aria-pressed={circleWorkspace === "bch-mainnet"} onClick={() => { setCircleWorkspace("bch-mainnet"); document.getElementById("bch-mainnet-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
                  <span className="circle-choice-top"><span className="circle-choice-symbol">BCH</span><span className="circle-choice-status locked">Mainnet · preview</span></span>
                  <b>BCH automatic-reserve circle</b>
                  <span>For groups saving in Bitcoin Cash. Tracks member contributions and reserves the next installment for each non-final payout.</span>
                  <small>Best when your group wants native BCH and individual member accounting.</small>
                </button>
                <button type="button" className={circleWorkspace === "pusd-mainnet" ? "circle-choice-card selected" : "circle-choice-card"} aria-pressed={circleWorkspace === "pusd-mainnet"} onClick={() => { setCircleWorkspace("pusd-mainnet"); document.getElementById("pusd-mainnet-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
                  <span className="circle-choice-top"><span className="circle-choice-symbol pusd">PUSD</span><span className="circle-choice-status locked">Mainnet · preview</span></span>
                  <b>PUSD stable-value circle</b>
                  <span>For groups that prefer ParyonUSD instead of BCH. Contributions and payouts are denominated in PUSD, with BCH needed separately for network fees.</span>
                  <small>Choose this if your group wants a stable-value token rather than BCH price exposure.</small>
                </button>
                </>}
                {network === "chipnet" && <>
                <button type="button" className={circleWorkspace === "bch-fair-round" ? "circle-choice-card selected" : "circle-choice-card"} aria-pressed={circleWorkspace === "bch-fair-round"} onClick={() => setCircleWorkspace("bch-fair-round")}>
                  <span className="circle-choice-top"><span className="circle-choice-symbol">BCH</span><span className="circle-choice-status testing">Chipnet · test</span></span>
                  <b>Fair-round BCH circle</b>
                  <span>Experimental member-credit model. Members fund the current round; a non-final recipient carries one next contribution forward in their own receipt.</span>
                  <small>Recommended for testing the newer member-credit and automatic-reserve experience.</small>
                </button>
                <button type="button" className={circleWorkspace === "bch-classic" ? "circle-choice-card selected" : "circle-choice-card"} aria-pressed={circleWorkspace === "bch-classic"} onClick={() => setCircleWorkspace("bch-classic")}>
                  <span className="circle-choice-top"><span className="circle-choice-symbol">BCH</span><span className="circle-choice-status testing">Chipnet · legacy</span></span>
                  <b>Classic BCH circle</b>
                  <span>Original rotating savings circle with a simple aggregate BCH pot and payout order. It does not provide per-member contribution attribution.</span>
                  <small>Use for existing Classic V1 circles or compatibility testing, not for the newer accounting model.</small>
                </button>
                </>}
              </div>
              <p className="circle-choice-disclaimer"><ShieldCheck size={15} /> {network === "mainnet" ? "Mainnet circles are unsigned previews. No BCH or PUSD Mainnet circle can accept deposits or send payouts yet." : "Chipnet is a testing network only. Use test BCH; it has no real-money value and cannot be used as Mainnet funds."}</p>
            </section>
            <Suspense fallback={<div className="workspace-loading"><span className="loading-orb" />Loading Mainnet asset workspaces…</div>}>
              {network === "mainnet" && <>
                <div className="mainnet-dual-workspaces">
                  <div id="bch-mainnet-workspace" className="circle-workspace-panel"><BchMainnetCircleWorkspace network={network} walletConnected={connected} /></div>
                  <div id="pusd-mainnet-workspace" className="circle-workspace-panel"><PusdMainnetCircleWorkspace network={network} walletConnected={connected} /></div>
                </div>
                {/* Legacy invite links remain accessible as a read-only compatibility workspace. */}
                {circleWorkspace === "bch-classic" && <div className="circle-workspace-panel"><ClassicBchWorkspace key={classicInviteRevision} network={network} walletConnected={connected} /></div>}
              </>}
              {network === "chipnet" && <>
                <div className="circle-workspace-panel" hidden={circleWorkspace !== "bch-fair-round"}>
                  <V2FeeBchWorkspace
                    network={network}
                    walletConnected={connected}
                    view="create"
                    onCircleSaved={() => setMenuCircles(readSavedV2MenuCircles())}
                  />
                </div>
                <div className="circle-workspace-panel" hidden={circleWorkspace !== "bch-classic"}><ClassicBchWorkspace key={classicInviteRevision} network={network} walletConnected={connected} /></div>
              </>}
            </Suspense>
          </section>
        )}

        {page === "circle-detail" && selectedMenuCircle && (
          <section className="page-section">
            <div className="page-intro">
              <span className="section-kicker">YOUR SAVINGS CIRCLE</span>
              <h1>{menuCircles.find((circle) => circle.encoded === selectedMenuCircle)?.name ?? "My circle"}</h1>
              <p>This circle has its own place in the menu. Review member credits, contribution status, payout readiness and cancellation options here.</p>
            </div>
            <Suspense fallback={<div className="workspace-loading"><span className="loading-orb" />Loading your circle…</div>}>
              <V2FeeBchWorkspace
                key={selectedMenuCircle}
                network={network}
                walletConnected={connected}
                view="circle"
                selectedCircle={selectedMenuCircle}
              />
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
                <span className="asset-state neutral">Mainnet preview only</span>
              </div>
              <div className="asset-detail-row"><span>Chipnet circle tests</span><b>Available</b></div>
              <div className="asset-detail-row"><span>Mainnet V3 genesis preview</span><b>Unsigned only</b></div>
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
                  <input value={pusdRecipient} onChange={(event) => { setPusdRecipient(event.target.value); setPusdTransferPlan(null); setPusdSignatureMessage(""); setPusdPlanError(""); }} placeholder="bitcoincash:…" autoComplete="off" />
                </label>
                <div className="pusd-transfer-fields">
                  <label>Amount (PUSD)
                    <input value={pusdAmount} onChange={(event) => { setPusdAmount(event.target.value); setPusdTransferPlan(null); setPusdSignatureMessage(""); setPusdPlanError(""); }} inputMode="decimal" placeholder="0.02" />
                  </label>
                  <label>Maximum miner fee (sats)
                    <input value={pusdMaxFee} onChange={(event) => { setPusdMaxFee(event.target.value); setPusdTransferPlan(null); setPusdSignatureMessage(""); setPusdPlanError(""); }} inputMode="numeric" />
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
                <button type="button" className="secondary-button" disabled={!pusdTransferPlan || pusdSignatureBusy || !connected || network !== "mainnet"}
                  onClick={() => void verifyPusdTransferSignature()}>
                  {pusdSignatureBusy ? "Verifying Selene signature…" : "Verify Selene signature · no broadcast"}
                </button>
                {pusdSignatureMessage && <p className="classic-notice" role="status">{pusdSignatureMessage}</p>}
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
          <Suspense fallback={<section className="page-section"><p className="classic-empty">Loading chain-backed activity…</p></section>}>
            <ActivityRecords />
          </Suspense>
        )}
      </div>

      {walletView.error && <div className="global-wallet-error" role="alert"><ShieldCheck size={17} /><span>{walletView.error}</span><div className="global-wallet-error-actions">
        <button onClick={() => { if (walletClient && !walletClient.retrySavedSession()) walletClient.connect(); }}>Retry saved session</button>
        <button onClick={() => walletClient?.startFreshPairing()}>Fresh pairing</button>
      </div></div>}

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
                <div className="wallet-address-card"><span>{NETWORKS[network].label}</span><code>{walletAddress ?? "Address not available yet"}</code>{walletAddress
                  ? <small>Live WizardConnect receive key · address index {walletView.receiveIndex} · public address only</small>
                  : <small className="wallet-match-message">WizardConnect is connected, but no valid live receive key is available yet. Check the Selene session and reconnect if needed.</small>}</div>
                <label className="field-label" htmlFor="selene-address">Verify against the receive address shown in Selene</label>
                <input id="selene-address" className="form-control" value={seleneAddress} onChange={(event) => setSeleneAddress(event.target.value)} placeholder="Paste Selene receive address to verify derivation" autoComplete="off" />
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
                    if (!walletClient.retrySavedSession()) {
                      if (walletClient.state === "idle" || walletClient.state === "disconnected") walletClient.connect();
                    }
                  }}>Retry saved session / connect</button>
                  <button className="secondary-button" onClick={() => walletClient?.startFreshPairing()}>Start fresh pairing</button>
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
