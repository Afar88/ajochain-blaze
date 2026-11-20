import { lazy, Suspense, useEffect, useState } from "react";
import {
  Activity, ArrowRight, Check, ChevronDown, Coins, Home,
  Monitor, MoreVertical, Moon, ShieldCheck, Sun, Users, Wallet, X,
} from "lucide-react";
import { getDefaultNetwork, NETWORKS, type NetworkId } from "./core/network-config";
import { settleIndependentTasks } from "./core/independent-network-tasks";
import { getDefaultCircleWorkspace, resolveCircleWorkspaceForNetwork, type CircleWorkspaceId } from "./core/circle-network-options";
import { formatAssetAmount, parseAssetAmount, PUSD_ASSET } from "./core/assets";
import type { PusdTransferPlan } from "./core/pusd-transaction-builder";
import type { AuthenticatedPusdUtxo } from "./core/pusd-utxo";
import type { NetworkProvider } from "cashscript";
import type { WalletConsolidationPlan } from "./core/wallet-consolidation";
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

const BCH_MAINNET_CIRCLES_STORAGE_KEY = "ajochain-blaze:bch-mainnet-circles-deployed:v1";
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
  mainnetAddressConfirmed: boolean;
};
type PreparedGather = {
  network: NetworkId;
  destinationAddress: string;
  walletAddresses: ReturnType<WalletClient["listWalletAddresses"]>;
  walletIdentity: ReturnType<WalletClient["getSessionIdentity"]>;
  provider: NetworkProvider;
  plan: WalletConsolidationPlan;
};
type GatherResult =
  | { status: "success"; txid: string; network: NetworkId }
  | { status: "error"; message: string };

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

const formatBchSatoshis = (satoshis: bigint) => {
  const whole = (satoshis / 100_000_000n).toString();
  const fraction = (satoshis % 100_000_000n).toString().padStart(8, "0");
  return whole + "." + fraction + " BCH";
};

const gatherExplorerUrl = (network: NetworkId, txid: string) =>
  "https://blockexplorer.cash/" + network + "/tx/" + txid;

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
    if (typeof window === "undefined") return "dark";
    try {
      const saved = window.localStorage.getItem("ajochain-theme");
      return saved === "light" || saved === "dark" || saved === "system" ? saved : "dark";
    } catch {
      return "dark";
    }
  });
  const [walletClient, setWalletClient] = useState<WalletClient | null>(null);
  const [gatherBusy, setGatherBusy] = useState(false);
  const [gatherMessage, setGatherMessage] = useState("");
  const [gatherPlan, setGatherPlan] = useState<PreparedGather | null>(null);
  const [gatherResult, setGatherResult] = useState<GatherResult | null>(null);
  const [discoveryMessage, setDiscoveryMessage] = useState("");
  const [discoveryRun, setDiscoveryRun] = useState(0);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [walletView, setWalletView] = useState<WalletView>({
    state: "idle", uri: null, qrUri: null, walletName: null, error: null,
    receiveIndex: 0, mainnetAddressConfirmed: false,
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

  useEffect(() => {
    // A network change can also mean Selene is showing a different receive
    // address. Require the user to sync the address for the newly selected
    // BCH network rather than carrying an old confirmation across networks.
    walletClient?.clearReceiveAddressConfirmation(network);
  }, [network, walletClient]);

  // Status messages are transient: show them while relevant and clear them
  // automatically so the page returns to a clean state.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setGatherMessage("");
      setDiscoveryMessage("");
      setAddressMatchMessage("");
      setPusdSignatureMessage("");
      setPusdPlanError("");
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, [gatherMessage, discoveryMessage, addressMatchMessage, pusdSignatureMessage, pusdPlanError]);

  const menuLabel = page === "circle-detail"
    ? menuCircles.find((circle) => circle.encoded === selectedMenuCircle)?.name ?? "My circle"
    : pageLabels[page];

  useEffect(() => {
    const refreshSavedCircles = () => setMenuCircles(readSavedV2MenuCircles());
    window.addEventListener("storage", refreshSavedCircles);
    return () => window.removeEventListener("storage", refreshSavedCircles);
  }, []);

  useEffect(() => {
    if (walletView.state !== "connected") setAddressMatchMessage("");
  }, [walletView.state]);

  useEffect(() => {
    let active = true;
    let lastInviteHash = "";
    const restoreInviteFromHash = () => {
      const hash = window.location.hash;
      if (hash.startsWith("#/bch-mainnet/") && hash !== lastInviteHash) {
        // BchMainnetCircleWorkspace validates and saves the invite from the hash when it mounts.
        lastInviteHash = hash;
        setNetwork("mainnet");
        setPage("create-circle");
        setMenuOpen(false);
        return;
      }
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
          mainnetAddressConfirmed: client.isReceiveAddressConfirmed("mainnet"),
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
          ? "PUSD is available on Bitcoin Cash Mainnet. Switch networks to check your balance."
          : "Connect your wallet to check PUSD.",
        utxoCount: 0, providerConfidence: 0, tipHeight: 0, utxos: [], rawPreviousTransactions: {},
      });
      return () => { active = false; };
    }
    if (!walletClient.isReceiveAddressConfirmed("mainnet")) {
      setPusdView({
        status: "idle", amount: 0n,
        detail: "Sync the Mainnet receive address currently shown in Selene under Wallet Details before checking this wallet's PUSD balance.",
        utxoCount: 0, providerConfidence: 0, tipHeight: 0, utxos: [], rawPreviousTransactions: {},
      });
      setPusdTransferPlan(null);
      setPusdPlanError("");
      setPusdSignatureMessage("");
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
      detail: "Checking your PUSD coins on the blockchain…",
      utxoCount: 0, providerConfidence: 0, tipHeight: 0, utxos: [], rawPreviousTransactions: {},
    });
    void import("./core/pusd-api")
      .then(({ fetchPusdWalletBalance }) => fetchPusdWalletBalance(address))
      .then((result) => {
        if (!active) return;
        setPusdView({
          status: "ready",
          amount: result.balance,
          detail: "Balance checked on the blockchain · block " +
            result.tipHeight.toLocaleString() + " · " + result.utxos.length + " PUSD coins found",
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
  }, [page, network, walletView.state, walletView.receiveIndex, walletView.mainnetAddressConfirmed, walletClient, pusdRefresh]);

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
    if (!walletClient.isReceiveAddressConfirmed("mainnet")) {
      setPusdPlanError("Sync the Mainnet receive address currently shown in Selene under Wallet Details before preparing a PUSD transfer.");
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
    if (!walletClient.isReceiveAddressConfirmed("mainnet")) {
      setPusdSignatureMessage("Sync the Mainnet receive address currently shown in Selene before testing the PUSD signature.");
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
      if (!walletClient.isReceiveAddressConfirmed("mainnet") ||
          walletClient.address("mainnet") !== senderAddress) {
        throw new Error("Selene's confirmed Mainnet address changed during PUSD preparation. The signed request was not started; sync the address and retry.");
      }
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
      if (!walletClient.isReceiveAddressConfirmed("mainnet") ||
          walletClient.address("mainnet") !== senderAddress) {
        throw new Error("Selene's confirmed Mainnet address changed after signing. The signed bytes were discarded; nothing was broadcast.");
      }
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
        detail: "Refreshed " + freshBalance.providerConfidence + " wallet coins immediately before checking the signature.",
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

  useEffect(() => {
    // Discovery is read-only and uses the connected wallet's own addresses on each BCH network.
    // Each network is isolated so a failed Chipnet endpoint cannot hide working Mainnet circles.
    if (!walletClient || walletView.state !== "connected" || walletClient.state !== "connected") return;
    let cancelled = false;
    setDiscoveryBusy(true);
    setDiscoveryMessage("Checking Chipnet and BCH Mainnet for circles that include this wallet…");
    void (async () => {
      try {
        const [{ getClassicProvider, getMainnetDiscoveryProvider }, { discoverV2FeeCircles, encodeV2FeeCircleParams }, { dedupeSavedV2FeeCircleRecords, getV2FeeCircleRecordIdentity }] = await Promise.all([
          import("./core/classic-bch"),
          import("./core/v2-fee-discovery"),
          import("./core/v2-fee-circle-records"),
        ]);
        if (cancelled) return;

        const [chipnetResult, mainnetResult] = await settleIndependentTasks(
          async () => {
            const provider = await getClassicProvider("chipnet");
            const addresses = walletClient.listWalletAddresses("chipnet").map((entry) => entry.address);
            if (addresses.length === 0) throw new Error("No Chipnet receive/change addresses are available from this wallet.");
            const found = await discoverV2FeeCircles(provider, addresses);
            if (cancelled) return 0;

            const stored: unknown = JSON.parse(window.localStorage.getItem(V2_MENU_STORAGE_KEY) || "[]");
            const existing = dedupeSavedV2FeeCircleRecords(stored);
            const knownCategories = new Set(existing.flatMap((record) => {
              const identity = getV2FeeCircleRecordIdentity(record.encoded);
              return identity ? [identity.stateCategory.toLowerCase()] : [];
            }));
            const additions = found
              .filter((params) => !knownCategories.has(params.stateCategory.toLowerCase()))
              .map((params) => ({ encoded: encodeV2FeeCircleParams(params), savedAt: 0 }));
            if (additions.length > 0) {
              window.localStorage.setItem(V2_MENU_STORAGE_KEY, JSON.stringify([...existing, ...additions]));
              setMenuCircles(readSavedV2MenuCircles());
            }
            return additions.length;
          },
          async () => {
            const mainnetAddresses = walletClient.listWalletAddresses("mainnet").map((entry) => entry.address);
            if (mainnetAddresses.length === 0) throw new Error("No Mainnet receive/change addresses are available from this wallet.");
            const mainnetFound = await discoverV2FeeCircles(getMainnetDiscoveryProvider(), mainnetAddresses, undefined, "mainnet");
            if (cancelled) return 0;

            const savedMainnet: unknown = JSON.parse(window.localStorage.getItem(BCH_MAINNET_CIRCLES_STORAGE_KEY) || "[]");
            const savedList = Array.isArray(savedMainnet) ? savedMainnet.filter((entry): entry is string => typeof entry === "string") : [];
            const savedCategories = new Set(savedList.flatMap((encoded) => {
              const identity = getV2FeeCircleRecordIdentity(encoded);
              return identity ? [identity.stateCategory.toLowerCase()] : [];
            }));
            const mainnetAdditions = mainnetFound.filter((params) => !savedCategories.has(params.stateCategory.toLowerCase()));
            if (mainnetAdditions.length > 0) {
              window.localStorage.setItem(BCH_MAINNET_CIRCLES_STORAGE_KEY, JSON.stringify([...savedList, ...mainnetAdditions.map(encodeV2FeeCircleParams)]));
              window.dispatchEvent(new Event("ajochain:bch-mainnet-circles-changed"));
            }
            return mainnetAdditions.length;
          },
        );

        if (cancelled) return;
        const chipnetMessage = chipnetResult.status === "fulfilled"
          ? chipnetResult.value > 0
            ? "Chipnet: found " + chipnetResult.value + " new circle" + (chipnetResult.value === 1 ? "" : "s") + "."
            : "Chipnet: checked; no new circles found."
          : "Chipnet: discovery unavailable; invite links still work.";
        const mainnetMessage = mainnetResult.status === "fulfilled"
          ? mainnetResult.value > 0
            ? "Mainnet: found " + mainnetResult.value + " new BCH circle" + (mainnetResult.value === 1 ? "" : "s") + "."
            : "Mainnet: checked; no new circles found."
          : "Mainnet: discovery unavailable; invite links still work.";
        setDiscoveryMessage(chipnetMessage + " " + mainnetMessage);
      } catch {
        if (!cancelled) setDiscoveryMessage("Couldn't load on-chain circle discovery. Invite links still work.");
      } finally {
        if (!cancelled) setDiscoveryBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [walletClient, walletView.state, discoveryRun]);

  const gatherWalletCoins = async () => {
    if (!walletClient || walletClient.state !== "connected" || !walletAddress || gatherBusy) return;

    // First action: scan and display the exact existing plan. No signature or
    // broadcast is requested until the saver presses the review CTA below.
    if (!gatherPlan) {
      const gatherNetwork = network;
      const destinationAddress = walletClient.address(gatherNetwork);
      if (!destinationAddress) {
        setGatherResult({ status: "error", message: "The connected Selene receive address is not available for this network." });
        return;
      }
      if (gatherNetwork === "mainnet" && !walletClient.isReceiveAddressConfirmed("mainnet")) {
        setGatherResult({ status: "error", message: "Sync the Mainnet receive address currently shown in Selene under Wallet Details before gathering real BCH." });
        return;
      }
      const gatherWalletIdentity = gatherNetwork === "mainnet" ? walletClient.getSessionIdentity() : null;
      if (gatherNetwork === "mainnet" && !gatherWalletIdentity) {
        setGatherResult({ status: "error", message: "WizardConnect has not supplied a verifiable Selene wallet identity. Reconnect Selene before gathering Mainnet BCH." });
        return;
      }
      setGatherBusy(true);
      setGatherResult(null);
      setGatherMessage("Checking your wallet for BCH coins…");
      try {
        const [{ getClassicProvider }, { planWalletConsolidation }] = await Promise.all([
          import("./core/classic-bch"),
          import("./core/wallet-consolidation"),
        ]);
        // Keep the same verified provider and existing consolidation planner.
        const provider = await getClassicProvider(gatherNetwork);
        const walletAddresses = walletClient.listWalletAddresses(gatherNetwork);
        if (walletAddresses.length === 0) throw new Error("No wallet receive/change addresses are available on " + gatherNetwork + ".");

        // Keep any legacy circle setup output out of the gather plan, exactly as before.
        const pendingSetupOutpoints = new Set<string>();
        const setupPrefix = "ajochain:classic-genesis-setup:v1:" + gatherNetwork + ":";
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          if (!key?.startsWith(setupPrefix)) continue;
          try {
            const txid = JSON.parse(window.localStorage.getItem(key) ?? "null")?.txid;
            if (typeof txid === "string") pendingSetupOutpoints.add(txid.toLowerCase() + ":0");
          } catch { /* ignore malformed records */ }
        }

        const plan = await planWalletConsolidation(
          provider,
          walletAddresses,
          destinationAddress,
          pendingSetupOutpoints,
          gatherNetwork,
        );
        if (gatherNetwork === "mainnet" && gatherWalletIdentity) {
          setGatherMessage("Coins found. Confirming the same Selene wallet before showing your review…");
          await walletClient.waitForConfirmedSession(gatherWalletIdentity, destinationAddress, walletAddresses, "mainnet", 25_000);
        }
        setGatherPlan({
          network: gatherNetwork,
          destinationAddress,
          walletAddresses,
          walletIdentity: gatherWalletIdentity,
          provider,
          plan,
        });
        setGatherMessage("");
      } catch (cause) {
        setGatherResult({
          status: "error",
          message: cause instanceof Error ? cause.message : "Could not check your BCH coins.",
        });
        setGatherMessage("");
      } finally {
        setGatherBusy(false);
      }
      return;
    }

    // Second action: reuse the reviewed amounts and destination. Abort if the
    // wallet or selected network changed after the preview was prepared.
    const prepared = gatherPlan;
    const gatherNetwork = prepared.network;
    const destinationAddress = prepared.destinationAddress;
    const plan = prepared.plan;
    const gatherWalletIdentity = prepared.walletIdentity;
    const walletAddresses = prepared.walletAddresses;
    if (network !== gatherNetwork || walletClient.address(gatherNetwork) !== destinationAddress ||
        (gatherNetwork === "mainnet" && walletClient.getSessionIdentity() !== gatherWalletIdentity)) {
      setGatherPlan(null);
      setGatherResult({ status: "error", message: "Your wallet or network changed. Check your coins again before gathering." });
      return;
    }

    setGatherBusy(true);
    setGatherResult(null);
    try {
      const networkLabel = gatherNetwork === "mainnet" ? "Mainnet" : "Chipnet";
      if (gatherNetwork === "mainnet" && gatherWalletIdentity) {
        setGatherMessage("Confirming Selene is still connected to the same wallet…");
        await walletClient.waitForConfirmedSession(gatherWalletIdentity, destinationAddress, walletAddresses, "mainnet", 20_000);
      }
      setGatherMessage("Waiting for Selene to approve the BCH gather…");
      const signed = await walletClient.signAndVerify(
        plan.wc,
        plan.walletInputs,
        "Gather your " + networkLabel + " BCH into one coin for AjoChain",
        plan.inputPaths,
      );
      if (gatherNetwork === "mainnet") {
        if (!gatherWalletIdentity) throw new Error("The original Selene wallet identity is unavailable. The signed transaction was not broadcast.");
        setGatherMessage("Signature received. Rechecking the same Selene wallet before submitting the BCH gather…");
        await walletClient.waitForConfirmedSession(gatherWalletIdentity, destinationAddress, walletAddresses, "mainnet", 20_000);
        const response = await fetch("/api/bch/gather", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            walletAddresses: walletAddresses.map((entry) => entry.address),
            destinationAddress: plan.destination,
            signedTransactionHex: signed.signedTransaction,
          }),
        });
        const payload = await response.json().catch(() => ({})) as {
          error?: unknown;
          network?: string;
          txid?: string;
          relayStatus?: string;
          broadcast?: boolean;
        };
        if (!response.ok) {
          throw new Error(typeof payload.error === "string" ? payload.error : "Mainnet BCH gather could not be verified or relayed.");
        }
        if (payload.network !== "mainnet" || payload.broadcast !== true ||
            typeof payload.txid !== "string" || !/^[0-9a-f]{64}$/i.test(payload.txid)) {
          throw new Error("The Mainnet gather API returned an incomplete result. Check the transaction before trying again.");
        }
        setGatherResult({ status: "success", txid: payload.txid, network: gatherNetwork });
      } else {
        const txid = await prepared.provider.sendRawTransaction(signed.signedTransaction);
        setGatherResult({ status: "success", txid, network: gatherNetwork });
      }
      setGatherPlan(null);
      setGatherMessage("");
    } catch (cause) {
      setGatherResult({
        status: "error",
        message: cause instanceof Error ? cause.message : "Could not gather coins.",
      });
      setGatherPlan(null);
      setGatherMessage("");
    } finally {
      setGatherBusy(false);
    }
  };

  const changeNetwork = (next: NetworkId) => {
    setNetwork(next);
    setCircleWorkspace((current) => resolveCircleWorkspaceForNetwork(current, next));
    setMenuOpen(false);
    setAddressMatchMessage("");
    setSeleneAddress("");
  };

  // Keep the derived address visible even before Selene's current Receive
  // screen has been explicitly matched. Users need to compare this candidate
  // with the address shown in Selene before confirming it in Wallet Details.
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
                    <div className="dropdown-label circle-menu-label">CIRCLE RECORDS</div>
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
              <div className="welcome-kicker"><span /> AJO · ESUSU · ON BITCOIN CASH</div>
              <h1>Your Ajo savings circle,<br /><em>on Bitcoin Cash.</em></h1>
              <p>Save with people you trust. Everyone puts in the same amount, one member collects each round, and the rules are kept by the blockchain, not a middleman.</p>
              <button className="primary-button hero-cta" type="button" onClick={() => navigate("create-circle")}>
                Create a circle <ArrowRight size={16} />
              </button>
            </section>

            <section className="how-ajo-works" aria-labelledby="how-ajo-works-title">
              <div className="how-ajo-heading">
                <span className="section-kicker">SIMPLE, TOGETHER</span>
                <h2 id="how-ajo-works-title">How Ajo works</h2>
              </div>
              <ol className="how-ajo-steps">
                <li><span className="how-ajo-number">01</span><div><b>Join</b><small>Join a circle with people you trust.</small></div></li>
                <li><span className="how-ajo-number">02</span><div><b>Contribute each round</b><small>Everyone adds the agreed amount.</small></div></li>
                <li><span className="how-ajo-number">03</span><div><b>Collect your turn</b><small>One member receives the pot each round.</small></div></li>
              </ol>
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
                  <small>{network === "chipnet" ? "Testing environment · no real funds" : "Real money · you approve every payment in your wallet"}</small></div>
                <button type="button" className="status-action" onClick={() => setMenuOpen(true)}>Change <ChevronDown size={13} /></button>
              </article>
            </section>

            <section className="asset-preview">
              <div><span className="section-kicker">SUPPORTED ASSETS</span><h2>BCH and PUSD</h2><p>Pick what your circle saves in. Fees are always shown up front.</p></div>
              <div className="asset-preview-rows">
                <div><span className="asset-symbol">B</span><span><b>Bitcoin Cash</b><small>Save in Bitcoin Cash · practise free on the test network first</small></span><span className="asset-state">Available</span></div>
                <div><span className="asset-symbol pusd-symbol">P</span><span><b>ParyonUSD</b><small>Save in dollars with ParyonUSD · balances checked on the blockchain</small></span><span className="asset-state neutral">Read only</span></div>
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
              <p>Choose what your group wants to save in, set the amount and members, then review the circle setup before taking action.</p>
            </div>
            <section className="circle-choice-guide" aria-label="Choose a circle type">
              <div className="circle-choice-heading">
                <div><span className="section-kicker">CHOOSE YOUR CIRCLE</span><h2>What kind of circle do you want?</h2>
                  <p>{network === "mainnet" ? "Choose BCH or PUSD. These are separate circles with their own member lists and payments." : "Try the circle options on Chipnet first. Test coins have no real-money value."}</p></div>
              </div>
              <div className="circle-choice-grid">
                {network === "mainnet" && <>
                <button type="button" className={circleWorkspace === "bch-mainnet" ? "circle-choice-card selected" : "circle-choice-card"} aria-pressed={circleWorkspace === "bch-mainnet"} onClick={() => { setCircleWorkspace("bch-mainnet"); document.getElementById("bch-mainnet-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
                  <span className="circle-choice-top"><span className="circle-choice-symbol">BCH</span><span className="circle-choice-status">Mainnet · live</span></span>
                  <b>BCH savings circle</b>
                  <span>For groups saving in Bitcoin Cash. Tracks member contributions and reserves the next installment for each non-final payout.</span>
                  <small>Best when your group wants native BCH and individual member accounting.</small>
                </button>
                <button type="button" className={circleWorkspace === "pusd-mainnet" ? "circle-choice-card selected" : "circle-choice-card"} aria-pressed={circleWorkspace === "pusd-mainnet"} onClick={() => { setCircleWorkspace("pusd-mainnet"); document.getElementById("pusd-mainnet-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
                  <span className="circle-choice-top"><span className="circle-choice-symbol pusd">PUSD</span><span className="circle-choice-status">Mainnet · live</span></span>
                  <b>PUSD savings circle</b>
                  <span>For groups that prefer ParyonUSD instead of BCH. Contributions and payouts are denominated in PUSD, with BCH needed separately for network fees.</span>
                  <small>Choose this if your group wants a stable-value token rather than BCH price exposure.</small>
                </button>
                </>}
                {network === "chipnet" && <>
                <button type="button" className={circleWorkspace === "bch-fair-round" ? "circle-choice-card selected" : "circle-choice-card"} aria-pressed={circleWorkspace === "bch-fair-round"} onClick={() => setCircleWorkspace("bch-fair-round")}>
                  <span className="circle-choice-top"><span className="circle-choice-symbol">BCH</span><span className="circle-choice-status testing">Chipnet · test</span></span>
                  <b>BCH savings circle</b>
                  <span>Experimental member-credit model. Members fund the current round; a non-final recipient carries one next contribution forward in their own receipt.</span>
                  <small>Try this option for the newer round-by-round savings experience.</small>
                </button>
                <button type="button" className={circleWorkspace === "bch-classic" ? "circle-choice-card selected" : "circle-choice-card"} aria-pressed={circleWorkspace === "bch-classic"} onClick={() => setCircleWorkspace("bch-classic")}>
                  <span className="circle-choice-top"><span className="circle-choice-symbol">BCH</span><span className="circle-choice-status testing">Chipnet · legacy</span></span>
                  <b>Classic BCH savings circle</b>
                  <span>A simple rotating savings group with a shared BCH pot and a set order for payouts.</span>
                  <small>Use this option for older circles or simple compatibility testing.</small>
                </button>
                </>}
              </div>
              <p className="circle-choice-disclaimer"><ShieldCheck size={15} /> {network === "mainnet" ? "BCH and PUSD Mainnet circles use real funds and unaudited contracts; start small." : "Chipnet is a testing network only. Use test BCH; it has no real-money value and cannot be used as Mainnet funds."}</p>
            </section>
            <Suspense fallback={<div className="workspace-loading"><span className="loading-orb" />Loading Mainnet asset workspaces…</div>}>
              {network === "mainnet" && <>
                <div className="mainnet-dual-workspaces">
                  <div id="bch-mainnet-workspace" className="circle-workspace-panel"><BchMainnetCircleWorkspace
                    network={network}
                    walletConnected={connected}
                    onOpenWalletDetails={openWallet}
                  /></div>
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
                <span className="asset-state neutral">Mainnet live</span>
              </div>
              <div className="asset-detail-row"><span>Chipnet circle tests</span><b>Available</b></div>
              <div className="asset-detail-row"><span>Mainnet V3 circles</span><b>Enabled</b></div>
              <div className="asset-detail-row"><span>Mainnet circle broadcast</span><b>Enabled</b></div>
            </article>
            <article className="asset-detail-card">
              <div className="asset-detail-heading">
                <span className="asset-symbol pusd-symbol">P</span>
                <div><span className="section-kicker">PARYONUSD · DOLLAR TOKEN</span><h2>PUSD</h2><p>Official ParyonUSD asset on Mainnet.</p></div>
                <span className="asset-state neutral">Mainnet only</span>
              </div>
              <div className="pusd-balance-panel">
                <span className="status-label">YOUR PUSD BALANCE</span>
                <strong>{pusdView.status === "ready" ? formatAssetAmount("PUSD", pusdView.amount) + " PUSD" : pusdView.status === "loading" ? "Checking…" : pusdView.status === "error" ? "Unavailable" : "Not checked"}</strong>
                <small>{pusdView.detail}</small>
                <button type="button" className="secondary-button" onClick={() => {
                  if (!connected) { openWallet(); return; }
                  if (network !== "mainnet") { changeNetwork("mainnet"); return; }
                  setPusdRefresh((value) => value + 1);
                }} disabled={pusdView.status === "loading"}>
                  {pusdView.status === "loading" ? "Checking…" : !connected ? "Connect wallet" : network !== "mainnet" ? "Switch to Mainnet" : "Refresh balance"}
                </button>
                {pusdView.status === "ready" && <div className="field-hint">{pusdView.utxoCount} PUSD coins checked on the blockchain
                  <details className="technical-details"><summary>Technical details</summary><p>{pusdView.providerConfidence} independent providers · block {pusdView.tipHeight.toLocaleString()} · {pusdView.utxoCount} authenticated CashToken UTXOs.</p></details></div>}
              </div>
              <div className="pusd-transfer-box">
                <div><span className="section-kicker">TRANSFER PLANNER</span><h3>Prepare a PUSD transfer</h3>
                  <p>Shows a transfer preview from the PUSD coins in your wallet and the latest network fee estimate. Nothing is sent.</p></div>
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
                    <div><span>BCH needed for delivery</span><strong>{pusdTransferPlan.recipientCarrierSatoshis.toString()} sats</strong></div>
                    <div><span>Coins selected</span><strong>{pusdTransferPlan.selectedUtxos.length}</strong></div>
                    <details className="technical-details"><summary>Technical details</summary><p>Estimated size {pusdTransferPlan.estimatedSizeBytes} bytes · fee rate {pusdTransferPlan.feeRateSatoshisPerKb.toString()} sats/kB. The plan must be rebuilt from fresh chain data before any signature.</p></details>
                  </div>
                )}
                <button type="button" className="secondary-button" disabled={!pusdTransferPlan || pusdSignatureBusy || !connected || network !== "mainnet"}
                  onClick={() => void verifyPusdTransferSignature()}>
                  {pusdSignatureBusy ? "Checking Selene approval…" : "Check Selene approval · no payment"}
                </button>
                {pusdSignatureMessage && <p className="classic-notice" role="status">{pusdSignatureMessage}</p>}
                <button type="button" className="primary-button" disabled={!PUSD_MAINNET_SPENDING_ENABLED || !pusdTransferPlan}
                  title="PUSD Mainnet spending is not yet approved by the security release gate">
                  Send PUSD · Mainnet locked
                </button>
                <small className="field-hint">PUSD sending stays locked until raw transaction inspection, independent wallet testing, fee/carrier validation, and security review are completed. This preview is not a payment.</small>
              </div>
              <details className="technical-details"><summary>Technical details</summary><div className="asset-detail-row"><span>Token identifier</span><code>{PUSD_ASSET.categoryId}</code></div><div className="asset-detail-row"><span>Display precision</span><b>2 decimals</b></div></details>
              <div className="asset-detail-row"><span>PUSD circle rules</span><b className="locked-state">Mainnet setup · payments locked</b></div>
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
                  ? <small>Derived receive address · index {walletView.receiveIndex}. Selene may rotate to another receive index; those addresses can belong to the same seed, but they are different on-chain addresses. Sync the currently displayed Selene Receive address below before creating or managing a circle.</small>
                  : <small className="wallet-match-message">WizardConnect is connected, but no valid live receive key is available yet. Check the Selene session and reconnect if needed.</small>}</div>
                <label className="field-label" htmlFor="selene-address">Sync with the address currently shown on Selene's {NETWORKS[network].label} Receive screen</label>
                <input id="selene-address" className="form-control" value={seleneAddress} onChange={(event) => setSeleneAddress(event.target.value)} placeholder="Paste the current Selene receive address" autoComplete="off" />
                <button className="primary-button" onClick={() => {
                  try {
                    const index = walletClient?.confirmReceiveAddress(seleneAddress, network, 250) ?? null;
                    setAddressMatchMessage(index === null
                      ? "No match in receive indices 0–250 of this connected receive key. Check Selene's Mainnet Receive screen and network. If it still does not match, this session may expose a different receive path; do not create a circle with the stale address."
                      : "Confirmed Selene's current receive address (index " + index + "). Mainnet circle creation will now use this exact address as Member 1.");
                  } catch (cause) { setAddressMatchMessage(cause instanceof Error ? cause.message : "Could not match address."); }
                }}>Sync Selene address</button>
                {addressMatchMessage && <p className="wallet-match-message" role="status">{addressMatchMessage}</p>}
                <small className="field-hint">
                  {walletClient?.isReceiveAddressConfirmed(network)
                    ? "Current Selene receive address confirmed for this wallet connection."
                    : "This connection's current receive address is not confirmed yet."}
                </small>
                {(network === "chipnet" || network === "mainnet") && walletAddress && <>
                  <section className="gather-card" aria-labelledby="gather-title">
                    <div className="gather-card-heading">
                      <span className="section-kicker">WALLET CLEAN-UP</span>
                      <h3 id="gather-title">Gather BCH coins</h3>
                      <p>Bring your available BCH into one coin in your own wallet. PUSD and other tokens are left untouched.</p>
                    </div>
                    {!gatherPlan && (
                      <button className="secondary-button gather-scan-button"
                        disabled={gatherBusy || (network === "mainnet" && !walletClient?.isReceiveAddressConfirmed("mainnet"))}
                        onClick={() => void gatherWalletCoins()}>
                        {gatherBusy ? "Checking your coins…" : network === "mainnet" && !walletClient?.isReceiveAddressConfirmed("mainnet")
                          ? "Sync Selene address before checking coins"
                          : "Find BCH coins in my wallet"}
                      </button>
                    )}
                    {gatherPlan && (
                      <div className="gather-review" aria-live="polite">
                        <div className="gather-review-row"><span>Total BCH found</span><strong>{formatBchSatoshis(gatherPlan.plan.totalSatoshis)}</strong></div>
                        <div className="gather-review-row gather-destination"><span>Goes to your wallet</span><code>{gatherPlan.plan.destination}</code></div>
                        <div className="gather-review-row"><span>Network fee</span><strong>{formatBchSatoshis(gatherPlan.plan.fee)}</strong></div>
                        <div className="gather-review-row"><span>After the fee</span><strong>{formatBchSatoshis(gatherPlan.plan.outputSatoshis)}</strong></div>
                        <details className="technical-details">
                          <summary>Technical details</summary>
                          <p>{gatherPlan.plan.inputCount} BCH inputs are used. The fee is the existing estimated miner fee. Nothing has been signed or sent yet.</p>
                        </details>
                        <button type="button" className="primary-button gather-confirm-button" disabled={gatherBusy} onClick={() => void gatherWalletCoins()}>
                          {gatherBusy ? "Waiting for Selene…" : "Gather to my wallet"}
                        </button>
                        <button type="button" className="secondary-button gather-cancel-button" disabled={gatherBusy} onClick={() => { setGatherPlan(null); setGatherMessage(""); }}>
                          Cancel
                        </button>
                      </div>
                    )}
                    {gatherBusy && gatherMessage && <p className="wallet-match-message" role="status">{gatherMessage}</p>}
                    {gatherResult?.status === "success" && (
                      <div className="gather-result gather-success" role="status">
                        <b>BCH gathered successfully</b>
                        <span>Your BCH is on its way back to your wallet. The transaction may take time to confirm.</span>
                        <a href={gatherExplorerUrl(gatherResult.network, gatherResult.txid)} target="_blank" rel="noreferrer">View transaction <code>{gatherResult.txid}</code></a>
                      </div>
                    )}
                    {gatherResult?.status === "error" && (
                      <div className="gather-result gather-error" role="alert">
                        <b>We couldn't gather your BCH</b>
                        <span>{gatherResult.message}</span>
                        <button type="button" className="secondary-button" onClick={() => { setGatherResult(null); setGatherPlan(null); }}>Try again</button>
                      </div>
                    )}
                    {network === "mainnet" && <small className="field-hint">Mainnet uses real BCH. Review the total and fee before asking Selene to approve. The coins return to your wallet.</small>}
                  </section>
                </>}
                <button className="secondary-button" disabled={discoveryBusy} onClick={() => setDiscoveryRun((run) => run + 1)}>Check for my circles</button>
                {discoveryMessage && <p className="wallet-match-message" role="status">{discoveryMessage}</p>}
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
      <footer className="app-footer"><span>© 2026 AjoChain</span><span><span className="footer-dot" /> {network === "chipnet" ? "Chipnet testing" : "Mainnet · wallet-authorized transactions"}</span></footer>
    </main>
  );
}
