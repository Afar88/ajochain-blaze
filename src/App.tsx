import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Activity, ArrowRight, Check, ChevronDown, Copy, Home,
  Monitor, MoreVertical, Moon, QrCode, RefreshCw, ShieldCheck, Sun, Users, Wallet, X,
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
  dedupeSavedV2FeeCircleRecords,
  getV2FeeCircleRecordIdentity,
} from "./core/v2-fee-circle-records";
import {
  ensureSavedCircleMetadata,
  filterSavedCirclesByNetwork,
  filterSavedCirclesByStatus,
  updateSavedCircleChainStatus,
  type SavedCircleStatus,
} from "./circles/saved-circle-status";
import {
  checkCircleStatusesWithLimits,
  countCircleStatuses,
  shouldAutoHideDiscoveryMessage,
  type ChainCircleSnapshot,
} from "./circles/on-chain-circle-status";
const ClassicBchWorkspace = lazy(() => import("./components/ClassicBchWorkspace"));
const V2FeeBchWorkspace = lazy(() => import("./components/V2FeeBchWorkspace"));
const PusdMainnetCircleWorkspace = lazy(() => import("./components/PusdMainnetCircleWorkspace"));
const BchMainnetCircleWorkspace = lazy(() => import("./components/BchMainnetCircleWorkspace"));
const ActivityRecords = lazy(() => import("./components/ActivityRecords"));

type Page = "overview" | "create-circle" | "my-circles" | "circle-detail" | "assets" | "activity";
type MenuCircleKind = "v2-fee" | "classic" | "bch-mainnet" | "pusd-mainnet";
type MenuCircle = {
  id: string;
  encoded: string;
  name: string;
  label: string;
  detail: string;
  network: NetworkId;
  kind: MenuCircleKind;
  asset: "BCH" | "PUSD";
  contribution: string;
  contributionLabel: string;
  memberCount: number;
  status: SavedCircleStatus;
  completedAt: number | null;
  checkedAt: number | null;
  round: number | null;
};

const BCH_MAINNET_CIRCLES_STORAGE_KEY = "ajochain-blaze:bch-mainnet-circles-deployed:v1";
const PUSD_MAINNET_CIRCLES_STORAGE_KEY = "ajochain-blaze:pusd-mainnet-circles-deployed:v1";
const CLASSIC_CIRCLES_STORAGE_KEY = "ajochain-blaze:classic-circles:v1";
const V2_MENU_STORAGE_KEY = "ajochain-blaze:v2-fee-circles:v1";

function decodeMenuCirclePayload(encoded: string): Record<string, unknown> | null {
  try {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readSavedCircleMenuRecords(): MenuCircle[] {
  const records: MenuCircle[] = [];
  const seen = new Set<string>();
  const add = (
    id: string, kind: MenuCircleKind, encoded: string, name: string, network: NetworkId,
    asset: "BCH" | "PUSD", contribution: string, memberCount: number, savedAt?: number,
  ) => {
    if (seen.has(id)) return;
    seen.add(id);
    let formattedContribution = "";
    let amount = "";
    try {
      formattedContribution = formatAssetAmount(asset, BigInt(contribution));
      amount = formattedContribution + " " + asset;
    } catch { /* use saved date */ }
    const networkLabel = network === "mainnet" ? "Mainnet" : "Chipnet";
    const savedLabel = Number.isSafeInteger(savedAt)
      ? "Saved " + new Date(savedAt as number).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
      : "Saved circle";
    const detail = amount && memberCount > 0
      ? networkLabel + " · " + amount + " · " + memberCount + " members"
      : networkLabel + " · " + savedLabel;
    records.push({
      id, kind, encoded, name: name.trim() || "Ajo circle", detail,
      label: (name.trim() || "Ajo circle") + " · " + detail, network,
      asset, contribution, contributionLabel: formattedContribution || "Contribution unavailable", memberCount,
      status: "unknown", completedAt: null, checkedAt: null, round: null,
    });
  };

  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(V2_MENU_STORAGE_KEY) || "[]");
    for (const entry of dedupeSavedV2FeeCircleRecords(stored)) {
      const identity = getV2FeeCircleRecordIdentity(entry.encoded);
      const payload = decodeMenuCirclePayload(entry.encoded);
      if (!identity || !payload || (identity.network !== "mainnet" && identity.network !== "chipnet")) continue;
      const members = Array.isArray(payload.members) ? payload.members : [];
      add("v2:" + identity.key, identity.network === "mainnet" ? "bch-mainnet" : "v2-fee",
        entry.encoded, identity.name, identity.network, "BCH",
        typeof payload.contribution === "string" ? payload.contribution : "", members.length, entry.savedAt);
    }
  } catch { /* Ignore malformed or unavailable storage. */ }

  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(BCH_MAINNET_CIRCLES_STORAGE_KEY) || "[]");
    if (Array.isArray(stored)) for (const encoded of stored) {
      if (typeof encoded !== "string") continue;
      const identity = getV2FeeCircleRecordIdentity(encoded);
      const payload = decodeMenuCirclePayload(encoded);
      if (!identity || identity.network !== "mainnet" || !payload) continue;
      const members = Array.isArray(payload.members) ? payload.members : [];
      add("v2:" + identity.key, "bch-mainnet", encoded, identity.name, "mainnet", "BCH",
        typeof payload.contribution === "string" ? payload.contribution : "", members.length);
    }
  } catch { /* Ignore malformed or unavailable storage. */ }

  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(PUSD_MAINNET_CIRCLES_STORAGE_KEY) || "[]");
    if (Array.isArray(stored)) for (const encoded of stored) {
      if (typeof encoded !== "string") continue;
      try {
        const payload: unknown = JSON.parse(encoded);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
        const circle = payload as Record<string, unknown>;
        if (circle.network !== "mainnet" ||
            typeof circle.name !== "string" || typeof circle.stateCategory !== "string" ||
            typeof circle.contribution !== "string" || !/^\d+$/.test(circle.contribution) ||
            !Array.isArray(circle.members) || !circle.members.every((member) => typeof member === "string")) continue;
        add("pusd:" + circle.stateCategory.toLowerCase(), "pusd-mainnet", encoded, circle.name, "mainnet", "PUSD",
          circle.contribution, circle.members.length);
      } catch { /* Ignore a damaged PUSD record. */ }
    }
  } catch { /* Ignore malformed or unavailable storage. */ }

  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(CLASSIC_CIRCLES_STORAGE_KEY) || "[]");
    if (Array.isArray(stored)) for (const item of stored) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (typeof record.encoded !== "string") continue;
      const payload = decodeMenuCirclePayload(record.encoded);
      if (!payload || payload.version !== 1 || typeof payload.name !== "string" ||
          (payload.network !== "mainnet" && payload.network !== "chipnet") ||
          typeof payload.contribution !== "string" || !/^\d+$/.test(payload.contribution) ||
          typeof payload.stateCategory !== "string" || !Array.isArray(payload.members)) continue;
      add("classic:" + payload.network + ":" + payload.stateCategory.toLowerCase(), "classic",
        record.encoded, payload.name, payload.network, "BCH", payload.contribution, payload.members.length,
        typeof record.savedAt === "number" ? record.savedAt : undefined);
    }
  } catch { /* Ignore malformed or unavailable storage. */ }

  const duplicateLabels = new Map<string, number>();
  const uniqueRecords = records.map((record) => {
    const count = (duplicateLabels.get(record.label) ?? 0) + 1;
    duplicateLabels.set(record.label, count);
    return count > 1
      ? { ...record, detail: record.detail + " · #" + count, label: record.label + " #" + count }
      : record;
  });
  const metadata = ensureSavedCircleMetadata(window.localStorage, uniqueRecords.map((circle) => ({
    id: circle.id,
    encoded: circle.encoded,
    network: circle.network,
    kind: circle.kind,
    name: circle.name,
    asset: circle.asset,
    contribution: circle.contribution,
    memberCount: circle.memberCount,
  })));
  const byId = new Map(metadata.map((circle) => [circle.id, circle]));
  return uniqueRecords.map((circle) => {
    const saved = byId.get(circle.id);
    return {
      ...circle,
      status: saved?.status ?? "unknown",
      completedAt: saved?.completedAt ?? null,
      checkedAt: saved?.checkedAt ?? null,
      round: saved?.round ?? null,
    };
  });
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
  addressSetRevision: number;
};
export type ReceiveAddressChoice = {
  branch: "receive" | "change";
  index: number;
  address: string;
  confirmedSatoshis: string;
  unconfirmedSatoshis: string;
  hasHistory: boolean;
  hasPendingHistory: boolean;
  status: "confirmed" | "pending" | "unused";
  newest: boolean;
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
export type BchBalanceScan = { address: string; network: NetworkId; totalSatoshis: bigint };

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

export function circleRiskNoticeText(network: NetworkId): string {
  return network === "mainnet"
    ? "Real BCH. The circle contract hasn't had an independent audit yet. Start with small amounts."
    : "Test network. No real money.";
}

const formatBchSatoshis = (satoshis: bigint) => {
  const whole = (satoshis / 100_000_000n).toString();
  const fraction = (satoshis % 100_000_000n).toString().padStart(8, "0");
  return whole + "." + fraction + " BCH";
};

const gatherExplorerUrl = (network: NetworkId, txid: string) =>
  "https://blockexplorer.cash/" + network + "/tx/" + txid;

export function getDiscoveryEffectDependencies(
  sessionIdentity: string | null,
  walletState: WalletView["state"],
  addressSetRevision: number,
  discoveryRun: number,
): [string | null, WalletView["state"], number, number] {
  return [sessionIdentity, walletState, addressSetRevision, discoveryRun];
}

export function getDiscoverySessionKey(
  sessionIdentity: string | null,
  walletState: WalletView["state"],
  addressSetRevision: number,
): string {
  return JSON.stringify([sessionIdentity, walletState, addressSetRevision]);
}

export function getDiscoveryNetworkStatus(
  networkName: string,
  result: PromiseSettledResult<{ foundCount: number }>,
  timedOut: boolean,
): string {
  if (result.status === "rejected") {
    return networkName + ": " + (timedOut ? "timed out" : "unavailable") + ", tap Retry to check again.";
  }
  const count = result.value.foundCount;
  if (timedOut) {
    return networkName + ": timed out" + (count > 0
      ? "; found " + count + " circle" + (count === 1 ? "" : "s")
      : "") + ", tap Retry to check again.";
  }
  return count > 0
    ? networkName + ": found " + count + " circle" + (count === 1 ? "" : "s") + "."
    : networkName + ": checked, none found.";
}

export function getCancelledDiscoveryStatus(networkName: string): string {
  return networkName + ": scan cancelled, tap Retry to check again.";
}

const WALLET_DISCOVERY_CACHE_PREFIX = "ajochain:wallet-circle-discovery:v1:";
const WALLET_DISCOVERY_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
const WALLET_SELECTED_ADDRESS_PREFIX = "ajochain:wallet-selected-address:v1:";

type WalletDiscoveryCache = {
  timestamp: number;
  circles: string[];
};

type WalletStorage = Pick<Storage, "getItem" | "setItem">;

export function getWalletDiscoveryCacheKey(firstReceiveAddress: string, network: NetworkId): string {
  return WALLET_DISCOVERY_CACHE_PREFIX + network + ":" + firstReceiveAddress.trim().toLowerCase();
}

export function readWalletDiscoveryCache(
  storage: Pick<Storage, "getItem">,
  firstReceiveAddress: string,
  network: NetworkId,
  now = Date.now(),
): WalletDiscoveryCache | null {
  if (!firstReceiveAddress.trim()) return null;
  try {
    const raw: unknown = JSON.parse(storage.getItem(getWalletDiscoveryCacheKey(firstReceiveAddress, network)) || "null");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(value.timestamp) || !Array.isArray(value.circles) ||
        !value.circles.every((entry) => typeof entry === "string")) return null;
    if (Number(value.timestamp) > now || now - Number(value.timestamp) > WALLET_DISCOVERY_CACHE_MAX_AGE_MS) return null;
    return { timestamp: Number(value.timestamp), circles: value.circles as string[] };
  } catch { return null; }
}

export function writeWalletDiscoveryCache(
  storage: WalletStorage,
  firstReceiveAddress: string,
  network: NetworkId,
  circles: readonly string[],
  timestamp = Date.now(),
): void {
  if (!firstReceiveAddress.trim()) return;
  storage.setItem(getWalletDiscoveryCacheKey(firstReceiveAddress, network), JSON.stringify({
    timestamp,
    circles: [...new Set(circles)],
  }));
}

export function getMostFundedWalletAddress(
  choices: readonly ReceiveAddressChoice[],
  selectedAddress: string | null = null,
): ReceiveAddressChoice | null {
  if (selectedAddress) {
    const selected = choices.find((choice) => choice.address.toLowerCase() === selectedAddress.toLowerCase());
    if (selected) return selected;
  }
  return [...choices].sort((left, right) => {
    const leftTotal = BigInt(left.confirmedSatoshis) + BigInt(left.unconfirmedSatoshis);
    const rightTotal = BigInt(right.confirmedSatoshis) + BigInt(right.unconfirmedSatoshis);
    if (leftTotal !== rightTotal) return leftTotal > rightTotal ? -1 : 1;
    if (left.branch !== right.branch) return left.branch === "receive" ? -1 : 1;
    return left.index - right.index;
  })[0] ?? null;
}

export function getWalletAddressSelectionKey(firstReceiveAddress: string, network: NetworkId): string {
  return WALLET_SELECTED_ADDRESS_PREFIX + network + ":" + firstReceiveAddress.trim().toLowerCase();
}

/** Restore a wallet's recent discovery result into the ordinary saved-circle lists. */
export function mergeCachedDiscoveryCircles(
  storage: WalletStorage,
  network: NetworkId,
  circles: readonly string[],
): number {
  if (circles.length === 0) return 0;
  if (network === "chipnet") {
    const raw: unknown = JSON.parse(storage.getItem(V2_MENU_STORAGE_KEY) || "[]");
    const existing = dedupeSavedV2FeeCircleRecords(raw);
    const known = new Set(existing.flatMap((entry) => {
      const identity = getV2FeeCircleRecordIdentity(entry.encoded);
      return identity ? [identity.stateCategory.toLowerCase()] : [];
    }));
    const additions = circles.filter((encoded) => {
      const identity = getV2FeeCircleRecordIdentity(encoded);
      return identity?.network === "chipnet" && !known.has(identity.stateCategory.toLowerCase());
    }).map((encoded) => ({ encoded, savedAt: 0 }));
    if (additions.length) storage.setItem(V2_MENU_STORAGE_KEY, JSON.stringify([...existing, ...additions]));
    return additions.length;
  }
  const raw: unknown = JSON.parse(storage.getItem(BCH_MAINNET_CIRCLES_STORAGE_KEY) || "[]");
  const existing = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
  const known = new Set(existing.flatMap((encoded) => {
    const identity = getV2FeeCircleRecordIdentity(encoded);
    return identity?.network === "mainnet" ? [identity.stateCategory.toLowerCase()] : [];
  }));
  const additions = circles.filter((encoded) => {
    const identity = getV2FeeCircleRecordIdentity(encoded);
    return identity?.network === "mainnet" && !known.has(identity.stateCategory.toLowerCase());
  });
  if (additions.length) storage.setItem(BCH_MAINNET_CIRCLES_STORAGE_KEY, JSON.stringify([...existing, ...additions]));
  return additions.length;
}

export function getWalletBchBalanceSummary(input: {
  network: NetworkId;
  connected: boolean;
  walletAddressChoices: readonly ReceiveAddressChoice[];
  currentBchBalanceScan: BchBalanceScan | null;
  receiveAddressScanLoading: boolean;
}): { balanceLabel: string; detailLabel: string; sourceLabel: string } {
  const {
    network, connected, walletAddressChoices, currentBchBalanceScan,
    receiveAddressScanLoading,
  } = input;

  if (!connected) {
    return {
      balanceLabel: "Connect wallet",
      detailLabel: "BCH coins found in your connected wallet",
      sourceLabel: "Wallet not connected",
    };
  }

  if (walletAddressChoices.length > 0) {
    const totalSatoshis = walletAddressChoices.reduce((total, choice) => {
      try {
        const addressTotal = BigInt(choice.confirmedSatoshis) + BigInt(choice.unconfirmedSatoshis);
        return total + (addressTotal > 0n ? addressTotal : 0n);
      } catch {
        return total;
      }
    }, 0n);
    return {
      balanceLabel: formatBchSatoshis(totalSatoshis),
      detailLabel: "Across all wallet addresses",
      sourceLabel: "Receive and change address activity",
    };
  }

  if (currentBchBalanceScan) {
    return {
      balanceLabel: formatBchSatoshis(currentBchBalanceScan.totalSatoshis),
      detailLabel: "BCH coins found in your connected wallet",
      sourceLabel: "Existing wallet coin scan",
    };
  }

  if (receiveAddressScanLoading) {
    return {
      balanceLabel: "Checking…",
      detailLabel: "Across all wallet addresses",
      sourceLabel: "Wallet address scan in progress",
    };
  }

  return {
    balanceLabel: "Not checked yet",
    detailLabel: "BCH coins found in your connected wallet",
    sourceLabel: "No wallet scan in this session",
  };
}

const CREATE_CIRCLE_FORM_HISTORY_KEY = "__ajoCreateCircleFormEntry";

const pageLabels: Record<Page, string> = {
  overview: "Overview",
  "create-circle": "Create a circle",
  "my-circles": "My circles",
  "circle-detail": "Circle details",
  assets: "Wallet",
  activity: "Activity",
};

export default function App() {
  const [network, setNetwork] = useState<NetworkId>(() => getDefaultNetwork(import.meta.env.PROD));
  const [riskNoticeCollapsed, setRiskNoticeCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem("ajochain:circle-risk-notice:v1:" + getDefaultNetwork(import.meta.env.PROD)) === "collapsed";
    } catch { return false; }
  });
  const riskNoticeStorageKey = "ajochain:circle-risk-notice:v1:" + network;
  const [page, setPage] = useState<Page>("overview");
  const [createCircleView, setCreateCircleView] = useState<"choose" | "form">("choose");
  const [createCircleWorkspaceBusy, setCreateCircleWorkspaceBusy] = useState(false);
  const createCircleFormHistoryEntryRef = useRef(false);
  const [circleWorkspace, setCircleWorkspace] = useState<CircleWorkspaceId>(() => getDefaultCircleWorkspace(getDefaultNetwork(import.meta.env.PROD)));
  const [classicInviteRevision, setClassicInviteRevision] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuCircles, setMenuCircles] = useState<MenuCircle[]>(readSavedCircleMenuRecords);
  const [selectedMenuCircle, setSelectedMenuCircle] = useState<string | null>(null);
  const [circleStatusTab, setCircleStatusTab] = useState<"active" | "completed">("active");
  const [mainnetInviteInput, setMainnetInviteInput] = useState("");
  const [mainnetInviteError, setMainnetInviteError] = useState("");
  const [mainnetInviteNotice, setMainnetInviteNotice] = useState("");
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
  const [bchBalanceScan, setBchBalanceScan] = useState<BchBalanceScan | null>(null);
  const [discoveryMessage, setDiscoveryMessage] = useState("");
  const [discoveryRun, setDiscoveryRun] = useState(0);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [circleStatusRetryRun, setCircleStatusRetryRun] = useState(0);
  const [walletView, setWalletView] = useState<WalletView>({
    state: "idle", uri: null, qrUri: null, walletName: null, error: null,
    receiveIndex: 0, mainnetAddressConfirmed: false, addressSetRevision: 0,
  });
  const [showWallet, setShowWallet] = useState(false);
  const [walletAddressChoices, setWalletAddressChoices] = useState<ReceiveAddressChoice[]>([]);
  const [walletAddressPickerExpanded, setWalletAddressPickerExpanded] = useState(false);
  const [showAllWalletAddresses, setShowAllWalletAddresses] = useState(false);
  const [walletAddressRevealed, setWalletAddressRevealed] = useState(false);
  const [showWalletAddressQr, setShowWalletAddressQr] = useState(false);
  const [walletAddressQrDataUrl, setWalletAddressQrDataUrl] = useState("");
  const [selectedWalletAddress, setSelectedWalletAddress] = useState<string | null>(null);
  const [walletBalancesUpdatedAt, setWalletBalancesUpdatedAt] = useState<number | null>(null);
  const [walletBalancesBusy, setWalletBalancesBusy] = useState(false);
  const [receiveAddressScanLoading, setReceiveAddressScanLoading] = useState(false);
  const [receiveAddressScanError, setReceiveAddressScanError] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [seleneAddress, setSeleneAddress] = useState("");
  const [addressMatchMessage, setAddressMatchMessage] = useState("");
  const [addressMatchError, setAddressMatchError] = useState("");
  const [walletBalanceRefreshRequest, setWalletBalanceRefreshRequest] = useState(0);
  const [pusdSignatureError, setPusdSignatureError] = useState("");
  const discoveryManualRequestRef = useRef(false);
  const balanceRefreshHandledRef = useRef(0);
  const walletBalanceScanInFlightRef = useRef(false);
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
  const walletStateLabel = walletView.state === "connecting" ? "Connecting"
    : walletView.state === "reconnecting" ? "Reconnecting"
      : walletView.state === "disconnecting" ? "Disconnecting"
        : walletView.state === "disconnected" ? "Disconnected"
          : connected ? "Connected" : "Connect wallet";

  const walletSessionIdentity = walletClient?.getSessionIdentity() ?? null;
  const discoveryEffectDependencies = getDiscoveryEffectDependencies(
    walletSessionIdentity,
    walletView.state,
    walletView.addressSetRevision,
    discoveryRun,
  );
  const discoveryPriorityAddressesRef = useRef({
    receiveIndex: walletView.receiveIndex,
    choices: walletAddressChoices,
  });
  discoveryPriorityAddressesRef.current = {
    receiveIndex: walletView.receiveIndex,
    choices: walletAddressChoices,
  };
  const discoveryBusyRef = useRef(false);
  const discoveryMessageTimerRef = useRef<number | null>(null);
  const circleStatusScannedKeysRef = useRef(new Set<string>());
  const circleStatusSessionRef = useRef<string | null | undefined>(undefined);
  const circleStatusRetryIdsRef = useRef<string[]>([]);
  const activeDiscoveryRunRef = useRef<{
    sessionKey: string;
    cancelled: boolean;
    cancel: () => void;
  } | null>(null);
  const selectedMainnetReceiveAddress = walletAddressChoices.find((choice) =>
    choice.branch === "receive" && choice.index === walletView.receiveIndex,
  ) ?? null;

  useEffect(() => {
    let timer: number | undefined;
    try {
      const wasCollapsed = window.localStorage.getItem(riskNoticeStorageKey) === "collapsed";
      setRiskNoticeCollapsed(wasCollapsed);
      if (!wasCollapsed) {
        timer = window.setTimeout(() => {
          setRiskNoticeCollapsed(true);
          try { window.localStorage.setItem(riskNoticeStorageKey, "collapsed"); } catch { /* optional persistence */ }
        }, 6_000);
      }
    } catch { setRiskNoticeCollapsed(false); }
    return () => { if (timer !== undefined) window.clearTimeout(timer); };
  }, [riskNoticeStorageKey]);

  useEffect(() => {
    // A network change can also mean Selene is showing a different receive
    // address. Require the user to sync the address for the newly selected
    // BCH network rather than carrying an old confirmation across networks.
    walletClient?.clearReceiveAddressConfirmation(network);
  }, [network, walletClient]);

  // Success and status messages fade quickly. Errors stay until the saver closes them.
  useEffect(() => {
    if (!gatherMessage && !addressMatchMessage && !pusdSignatureMessage) return;
    const timer = window.setTimeout(() => {
      setGatherMessage("");
      setAddressMatchMessage("");
      setPusdSignatureMessage("");
    }, 4_000);
    return () => window.clearTimeout(timer);
  }, [gatherMessage, addressMatchMessage, pusdSignatureMessage]);

  useEffect(() => {
    if (gatherResult?.status !== "success") return;
    const timer = window.setTimeout(() => setGatherResult(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [gatherResult]);
  const selectedCircleRecord = menuCircles.find((circle) =>
    circle.id === selectedMenuCircle && circle.network === network,
  ) ?? null;
  const visibleNetworkCircles = filterSavedCirclesByNetwork(menuCircles, network);
  const visibleStatusCircles = filterSavedCirclesByStatus(visibleNetworkCircles, circleStatusTab);
  const networkCircleCounts = countCircleStatuses(visibleNetworkCircles);
  const menuLabel = pageLabels[page];
  const renderCircleRiskNotice = () => (
    <details
      className="circle-risk-notice"
      open={!riskNoticeCollapsed}
      onToggle={(event) => {
        const collapsed = !event.currentTarget.open;
        setRiskNoticeCollapsed(collapsed);
        try {
          if (collapsed) window.localStorage.setItem(riskNoticeStorageKey, "collapsed");
          else window.localStorage.removeItem(riskNoticeStorageKey);
        } catch { /* notice remains usable when storage is unavailable */ }
      }}
    >
      <summary><ShieldCheck size={18} /> {network === "mainnet" ? "Mainnet safety notice" : "Chipnet notice"} <span>{riskNoticeCollapsed ? "Show" : "Hide"}</span></summary>
      <p>{circleRiskNoticeText(network)}</p>
      <button type="button" className="secondary-button" onClick={() => setMenuOpen(true)}>Change network</button>
    </details>
  );

  useEffect(() => {
    const refreshSavedCircles = () => setMenuCircles(readSavedCircleMenuRecords());
    window.addEventListener("storage", refreshSavedCircles);
    window.addEventListener("ajochain:bch-mainnet-circles-changed", refreshSavedCircles);
    window.addEventListener("ajochain:saved-circles-changed", refreshSavedCircles);
    return () => {
      window.removeEventListener("storage", refreshSavedCircles);
      window.removeEventListener("ajochain:bch-mainnet-circles-changed", refreshSavedCircles);
      window.removeEventListener("ajochain:saved-circles-changed", refreshSavedCircles);
    };
  }, []);

  useEffect(() => {
    if (walletView.state !== "connected") setAddressMatchMessage("");
  }, [walletView.state]);

  const circleStatusSignature = menuCircles.map((circle) =>
    circle.id + ":" + circle.encoded,
  ).join("|");

  useEffect(() => {
    // Re-check saved circles on load, when newly discovered circles are added,
    // and after a wallet reconnect. Status reads are public/read-only chain calls.
    if (circleStatusSessionRef.current !== walletSessionIdentity) {
      circleStatusSessionRef.current = walletSessionIdentity;
      circleStatusScannedKeysRef.current.clear();
    }
    const retryIds = circleStatusRetryIdsRef.current.splice(0);
    const retrySet = new Set(retryIds);
    const targets = menuCircles.filter((circle) => {
      const key = circle.id + ":" + circle.encoded;
      return retrySet.has(circle.id) || !circleStatusScannedKeysRef.current.has(key);
    });
    if (targets.length === 0) return;
    for (const circle of targets) {
      circleStatusScannedKeysRef.current.add(circle.id + ":" + circle.encoded);
    }

    let current = true;
    const readStatus = async (circle: MenuCircle): Promise<ChainCircleSnapshot> => {
      if (circle.kind === "v2-fee" || circle.kind === "bch-mainnet") {
        const [{ decodeV2FeeCircle, readV2FeeCircle }] = await Promise.all([
          import("./core/v2-fee-bch"),
        ]);
        const params = decodeV2FeeCircle(circle.encoded);
        const snapshot = await readV2FeeCircle(params);
        return {
          round: snapshot.round,
          completed: snapshot.completed,
          stateVerified: !snapshot.completed && snapshot.round !== null,
          closedAs: snapshot.closedAs ?? null,
          completedAt: snapshot.completedAt ?? null,
        };
      }
      if (circle.kind === "classic") {
        const { decodeClassicCircle, readClassicCircle } = await import("./core/classic-bch");
        const params = decodeClassicCircle(circle.encoded);
        const snapshot = await readClassicCircle(params);
        return {
          round: snapshot.status.round,
          completed: snapshot.status.round === params.members.length && Boolean(snapshot.status.stateUtxo),
          stateVerified: snapshot.status.stateVerified,
          completedAt: null,
        };
      }
      if (circle.kind === "pusd-mainnet") {
        const { PusdCircleClosedError, readPusdMainnetCircle } = await import("./core/pusd-mainnet-circle");
        const payload: unknown = JSON.parse(circle.encoded);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error("Saved PUSD circle data is invalid.");
        }
        const value = payload as Record<string, unknown>;
        if (value.version !== 3 || value.network !== "mainnet" ||
            typeof value.name !== "string" || !Array.isArray(value.members) ||
            !value.members.every((member) => typeof member === "string") ||
            typeof value.contribution !== "string" || !/^\d+$/.test(value.contribution) ||
            typeof value.maxFee !== "string" || !/^\d+$/.test(value.maxFee) ||
            typeof value.initiator !== "string" || typeof value.stateCategory !== "string" ||
            typeof value.treasury !== "string") {
          throw new Error("Saved PUSD circle data is incomplete.");
        }
        try {
          const snapshot = await readPusdMainnetCircle({
            version: 3,
            network: "mainnet",
            name: value.name,
            members: value.members as string[],
            contribution: BigInt(value.contribution),
            maxFee: BigInt(value.maxFee),
            initiator: value.initiator,
            stateCategory: value.stateCategory,
            treasury: value.treasury,
          });
          return { round: snapshot.round, completed: snapshot.completed, stateVerified: true, completedAt: null };
        } catch (cause) {
          if (cause instanceof PusdCircleClosedError) {
            return {
              round: value.members.length,
              completed: true,
              closedAs: cause.closedAs,
              completedAt: cause.completedAt,
            };
          }
          throw cause;
        }
      }
      throw new Error("No read-only status checker is available for this saved circle type.");
    };

    void (async () => {
      const outcomes = await checkCircleStatusesWithLimits(targets, readStatus, {
        concurrency: 4,
        requestTimeoutMs: 10_000,
        overallTimeoutMs: 45_000,
      });
      if (!current) return;
      for (const outcome of outcomes) {
        const circle = outcome.item;
        updateSavedCircleChainStatus(window.localStorage, {
          id: circle.id,
          encoded: circle.encoded,
          network: circle.network,
          kind: circle.kind,
          name: circle.name,
          asset: circle.asset,
          contribution: circle.contribution,
          memberCount: circle.memberCount,
        }, outcome.result.status, outcome.result.round, outcome.result.completedAt);
      }
      setMenuCircles(readSavedCircleMenuRecords());
    })();

    return () => { current = false; };
  }, [circleStatusSignature, walletSessionIdentity, circleStatusRetryRun]);

  const retryCircleStatus = (circle: MenuCircle) => {
    circleStatusRetryIdsRef.current = [...circleStatusRetryIdsRef.current, circle.id];
    setCircleStatusRetryRun((revision) => revision + 1);
  };

  const openMenuCircle = (circle: MenuCircle) => {
    setSelectedMenuCircle(circle.id);
    setCircleWorkspace(circle.kind === "v2-fee" ? "bch-fair-round"
      : circle.kind === "classic" ? "bch-classic"
        : circle.kind === "bch-mainnet" ? "bch-mainnet" : "pusd-mainnet");
    setPage("circle-detail");
    setMenuOpen(false);
  };

  const clearCreateCircleHistoryEntry = () => {
    const currentState = window.history.state;
    if (currentState && typeof currentState === "object" &&
        CREATE_CIRCLE_FORM_HISTORY_KEY in currentState) {
      const nextState = { ...(currentState as Record<string, unknown>) };
      delete nextState[CREATE_CIRCLE_FORM_HISTORY_KEY];
      window.history.replaceState(nextState, "", window.location.href);
    }
    createCircleFormHistoryEntryRef.current = false;
  };

  const navigate = (next: Page) => {
    clearCreateCircleHistoryEntry();
    if (next === "create-circle") {
      setCreateCircleView("choose");
      setCreateCircleWorkspaceBusy(false);
    }
    if (next === "my-circles") {
      setCircleStatusTab("active");
      setMenuCircles(readSavedCircleMenuRecords());
    }
    setPage(next);
    setMenuOpen(false);
  };

  const enterCreateCircleForm = (workspace: CircleWorkspaceId) => {
    setCircleWorkspace(workspace);
    if (!createCircleFormHistoryEntryRef.current) {
      const currentState = window.history.state && typeof window.history.state === "object"
        ? window.history.state as Record<string, unknown>
        : {};
      window.history.pushState(
        { ...currentState, [CREATE_CIRCLE_FORM_HISTORY_KEY]: true },
        "",
        window.location.href,
      );
      createCircleFormHistoryEntryRef.current = true;
    }
    setCreateCircleView("form");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const leaveCreateCircleForm = () => {
    if (createCircleWorkspaceBusy && !window.confirm(
      "A circle action is still processing. Leaving now could interrupt a wallet signing or broadcast step. Leave this form anyway?",
    )) return;
    clearCreateCircleHistoryEntry();
    setCreateCircleView("choose");
    setCreateCircleWorkspaceBusy(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const importMainnetCircleInvite = (input: string) => {
    const candidate = input.trim();
    const routeMatch = candidate.match(/#\/(bch-mainnet|pusd-mainnet)\/([A-Za-z0-9_-]+)/);
    const encoded = routeMatch?.[2] ?? candidate;
    const payload = decodeMenuCirclePayload(encoded);
    if (!payload || payload.network !== "mainnet" || typeof payload.name !== "string" ||
        typeof payload.stateCategory !== "string" || !Array.isArray(payload.members) ||
        !payload.members.every((member) => typeof member === "string")) {
      throw new Error("Paste a valid BCH or PUSD Mainnet circle invite link.");
    }

    if (payload.covenant === "fee-v3-auto-reserve-mainnet") {
      const identity = getV2FeeCircleRecordIdentity(encoded);
      if (!identity || identity.network !== "mainnet" || payload.version !== 2) {
        throw new Error("This is not a valid BCH Mainnet V3 circle invite.");
      }
      const existing: unknown = JSON.parse(window.localStorage.getItem(BCH_MAINNET_CIRCLES_STORAGE_KEY) || "[]");
      const records = Array.isArray(existing) ? existing.filter((item): item is string => typeof item === "string") : [];
      const next = [encoded, ...records.filter((entry) => getV2FeeCircleRecordIdentity(entry)?.key !== identity.key)].slice(0, 50);
      window.localStorage.setItem(BCH_MAINNET_CIRCLES_STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new Event("ajochain:bch-mainnet-circles-changed"));
      return "BCH Mainnet circle added. Open it from the list to check its on-chain state.";
    }

    if (payload.version === 3 && typeof payload.contribution === "string" &&
        /^\d+$/.test(payload.contribution) && typeof payload.maxFee === "string" &&
        /^\d+$/.test(payload.maxFee)) {
      const identity = payload.stateCategory.toLowerCase();
      const serialized = JSON.stringify(payload);
      const existing: unknown = JSON.parse(window.localStorage.getItem(PUSD_MAINNET_CIRCLES_STORAGE_KEY) || "[]");
      const records = Array.isArray(existing) ? existing.filter((item): item is string => typeof item === "string") : [];
      const next = [serialized, ...records.filter((entry) => {
        try {
          const saved: unknown = JSON.parse(entry);
          if (!saved || typeof saved !== "object") return true;
          const savedCategory = (saved as Record<string, unknown>).stateCategory;
          return typeof savedCategory !== "string" || savedCategory.toLowerCase() !== identity;
        } catch { return true; }
      })].slice(0, 50);
      window.localStorage.setItem(PUSD_MAINNET_CIRCLES_STORAGE_KEY, JSON.stringify(next));
      return "PUSD Mainnet circle added. Open it from the list to check its on-chain state.";
    }

    throw new Error("This invite is not a supported BCH or PUSD Mainnet circle.");
  };

  const joinMainnetCircleWithInvite = () => {
    setMainnetInviteError("");
    setMainnetInviteNotice("");
    try {
      const message = importMainnetCircleInvite(mainnetInviteInput);
      setMenuCircles(readSavedCircleMenuRecords());
      setCircleStatusTab("active");
      setMainnetInviteInput("");
      setMainnetInviteNotice(message);
    } catch (cause) {
      setMainnetInviteError(cause instanceof Error ? cause.message : String(cause));
    }
  };


  useEffect(() => {
    const handleCreateCirclePopState = (event: PopStateEvent) => {
      const state = event.state && typeof event.state === "object"
        ? event.state as Record<string, unknown>
        : {};
      const returningToForm = state[CREATE_CIRCLE_FORM_HISTORY_KEY] === true;
      createCircleFormHistoryEntryRef.current = returningToForm;
      if (page !== "create-circle") return;
      if (returningToForm) {
        setCreateCircleView("form");
        return;
      }
      if (createCircleView !== "form") return;
      if (createCircleWorkspaceBusy && !window.confirm(
        "A circle action is still processing. Leaving now could interrupt a wallet signing or broadcast step. Leave this form anyway?",
      )) {
        const currentState = window.history.state && typeof window.history.state === "object"
          ? window.history.state as Record<string, unknown>
          : {};
        window.history.pushState(
          { ...currentState, [CREATE_CIRCLE_FORM_HISTORY_KEY]: true },
          "",
          window.location.href,
        );
        createCircleFormHistoryEntryRef.current = true;
        return;
      }
      setCreateCircleView("choose");
      setCreateCircleWorkspaceBusy(false);
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener("popstate", handleCreateCirclePopState);
    return () => window.removeEventListener("popstate", handleCreateCirclePopState);
  }, [page, createCircleView, createCircleWorkspaceBusy]);

  useEffect(() => {
    let active = true;
    let lastInviteHash = "";
    const restoreInviteFromHash = () => {
      const hash = window.location.hash;
      if ((hash.startsWith("#/bch-mainnet/") || hash.startsWith("#/pusd-mainnet/")) && hash !== lastInviteHash) {
        lastInviteHash = hash;
        setNetwork("mainnet");
        setPage("my-circles");
        setCircleStatusTab("active");
        setMenuOpen(false);
        setMainnetInviteError("");
        setMainnetInviteNotice("");
        try {
          setMainnetInviteNotice(importMainnetCircleInvite(hash));
          setMenuCircles(readSavedCircleMenuRecords());
        } catch (cause) {
          setMainnetInviteError(cause instanceof Error ? cause.message : String(cause));
        }
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
          setPage("create-circle");
          enterCreateCircleForm("bch-classic");
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
          addressSetRevision: client.addressSetRevision,
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
    const value = showWalletAddressQr ? displayWalletAddress : null;
    if (!value) {
      setWalletAddressQrDataUrl("");
      return () => { active = false; };
    }
    void import("qrcode")
      .then(({ default: QRCode }) => QRCode.toDataURL(value, {
        errorCorrectionLevel: "M", margin: 1, width: 220,
      }))
      .then((url) => { if (active) setWalletAddressQrDataUrl(url); })
      .catch(() => { if (active) setWalletAddressQrDataUrl(""); });
    return () => { active = false; };
  }, [showWalletAddressQr, displayWalletAddress]);

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
    let cancelled = false;
    const shouldRefresh = page === "assets" || showWallet ||
      walletBalanceRefreshRequest > balanceRefreshHandledRef.current;
    if (!shouldRefresh || walletView.state !== "connected" || !walletClient ||
        walletClient.state !== "connected" || walletBalanceScanInFlightRef.current) {
      return () => { cancelled = true; };
    }
    if (walletBalanceRefreshRequest > balanceRefreshHandledRef.current) {
      balanceRefreshHandledRef.current = walletBalanceRefreshRequest;
    }
    const client = walletClient;
    const identity = client.getSessionIdentity();
    const revision = client.addressSetRevision;
    walletBalanceScanInFlightRef.current = true;
    setWalletBalancesBusy(true);
    setReceiveAddressScanLoading(true);
    setReceiveAddressScanError("");
    setPusdView((current) => current.status === "ready"
      ? current
      : { ...current, status: "loading", detail: "Checking your wallet…" });

    void (async () => {
      try {
        const [{ getClassicProvider }, { getNextUnusedReceiveAddressIndex, selectDefaultReceiveAddressIndex }] =
          await Promise.all([import("./core/classic-bch"), import("./core/wizard-wallet")]);

        const walletAddresses = client.listWalletAddresses(network, 49, 20);
        if (walletAddresses.length === 0) throw new Error("Couldn't load your addresses. Reconnect and try again.");
        const receiveAddresses = walletAddresses.filter((entry) => entry.branch === "receive");
        const firstReceiveAddress = receiveAddresses[0]?.address ?? "";
        if (!firstReceiveAddress) throw new Error("Couldn't load your addresses. Reconnect and try again.");

        const provider = await getClassicProvider(network);
        const activityProvider = provider as typeof provider & {
          getAddressActivityForAddresses?: (addresses: readonly string[]) => Promise<Array<{
            address: string; hasHistory: boolean; hasPendingHistory: boolean;
            confirmedSatoshis: bigint; unconfirmedSatoshis: bigint;
          }>>;
        };
        if (typeof activityProvider.getAddressActivityForAddresses !== "function") {
          throw new Error("Couldn't check your wallet balances. Try again.");
        }
        const scanned = await activityProvider.getAddressActivityForAddresses(walletAddresses.map((entry) => entry.address));
        if (cancelled || client.state !== "connected" || client.getSessionIdentity() !== identity ||
            client.addressSetRevision !== revision) return;

        const byAddress = new Map(scanned.map((entry) => [entry.address.toLowerCase(), entry]));
        const activity = walletAddresses.map((entry) => {
          const result = byAddress.get(entry.address.toLowerCase());
          if (!result) throw new Error("The wallet balance check was incomplete. Try again.");
          return { ...result, branch: entry.branch, index: entry.index };
        });
        const receiveActivity = activity.filter((entry) => entry.branch === "receive");
        const nextUnusedIndex = getNextUnusedReceiveAddressIndex(receiveActivity);
        const newestReceive = receiveAddresses.find((entry) => entry.index === nextUnusedIndex) ??
          receiveAddresses[receiveAddresses.length - 1];
        const choices: ReceiveAddressChoice[] = activity.map((entry) => ({
          branch: entry.branch,
          index: entry.index,
          address: entry.address,
          confirmedSatoshis: entry.confirmedSatoshis.toString(),
          unconfirmedSatoshis: entry.unconfirmedSatoshis.toString(),
          hasHistory: entry.hasHistory,
          hasPendingHistory: entry.hasPendingHistory,
          status: entry.confirmedSatoshis > 0n || (entry.hasHistory && !entry.hasPendingHistory)
            ? "confirmed"
            : entry.hasPendingHistory || entry.unconfirmedSatoshis > 0n
              ? "pending" : "unused",
          newest: entry.branch === "receive" && entry.index === newestReceive?.index,
        }));
        setWalletAddressChoices(choices);

        // Keep Selene's active receive address separate from the display address.
        // Circle membership and signing continue to use the explicitly confirmed receive address.
        if (network === "mainnet" && !client.isReceiveAddressConfirmed("mainnet") && receiveActivity.length) {
          const defaultReceiveIndex = selectDefaultReceiveAddressIndex(receiveActivity, nextUnusedIndex);
          client.selectReceiveAddressIndex(defaultReceiveIndex, "mainnet");
        }

        const storedSelected = (() => {
          try { return window.localStorage.getItem(getWalletAddressSelectionKey(firstReceiveAddress, network)); }
          catch { return null; }
        })();
        const nextDisplayAddress = getMostFundedWalletAddress(choices, selectedWalletAddress)?.address
          ?? getMostFundedWalletAddress(choices, storedSelected)?.address
          ?? getMostFundedWalletAddress(choices)?.address ?? null;
        if (nextDisplayAddress) {
          setSelectedWalletAddress(nextDisplayAddress);
          try { window.localStorage.setItem(getWalletAddressSelectionKey(firstReceiveAddress, network), nextDisplayAddress); }
          catch { /* selection still works for this open session */ }
        }

        if (network === "mainnet") {
          const { fetchPusdWalletBalance } = await import("./core/pusd-api");
          const addressSnapshots = await Promise.all(walletAddresses.map((entry) => fetchPusdWalletBalance(entry.address)));
          if (cancelled || client.state !== "connected" || client.getSessionIdentity() !== identity ||
              client.addressSetRevision !== revision) return;
          const uniqueUtxos = new Map<string, AuthenticatedPusdUtxo>();
          for (const snapshot of addressSnapshots) {
            for (const utxo of snapshot.utxos) {
              uniqueUtxos.set(utxo.txid.toLowerCase() + ":" + utxo.vout, utxo);
            }
          }
          const allPusdUtxos = [...uniqueUtxos.values()];
          const allPusdAmount = allPusdUtxos.reduce((total, utxo) => total + (utxo.token?.amount ?? 0n), 0n);
          const activeReceiveAddress = client.address("mainnet");
          const activeSnapshot = activeReceiveAddress
            ? addressSnapshots.find((snapshot) => snapshot.address.toLowerCase() === activeReceiveAddress.toLowerCase())
            : undefined;
          const confidence = Math.min(...addressSnapshots.map((snapshot) => snapshot.providerConfidence));
          const tipHeight = Math.min(...addressSnapshots.map((snapshot) => snapshot.tipHeight));
          setPusdView({
            status: "ready",
            amount: allPusdAmount,
            detail: "Checked across " + walletAddresses.length + " wallet addresses.",
            utxoCount: allPusdUtxos.length,
            providerConfidence: confidence,
            tipHeight,
            // Only the confirmed active receive-address UTXOs are used by the existing transfer planner.
            utxos: activeSnapshot?.utxos ?? [],
            rawPreviousTransactions: activeSnapshot?.rawPreviousTransactions ?? {},
          });
        } else {
          setPusdView((current) => current.status === "ready"
            ? current
            : { ...current, status: "idle", detail: "PUSD balances are available on Mainnet." });
        }

        setWalletBalancesUpdatedAt(Date.now());
        if (bchBalanceScan) {
          const total = choices.reduce((sum, choice) =>
            sum + BigInt(choice.confirmedSatoshis) + BigInt(choice.unconfirmedSatoshis), 0n);
          setBchBalanceScan({
            address: nextDisplayAddress ?? bchBalanceScan.address,
            network,
            totalSatoshis: total,
          });
        }
      } catch (cause) {
        if (!cancelled) {
          setReceiveAddressScanError(cause instanceof Error ? cause.message : "Couldn't check your wallet. Try again.");
          setPusdView((current) => current.status === "ready"
            ? current
            : { ...current, status: "error", detail: cause instanceof Error ? cause.message : "PUSD balance check failed." });
        }
      } finally {
        walletBalanceScanInFlightRef.current = false;
        if (!cancelled) {
          setWalletBalancesBusy(false);
          setReceiveAddressScanLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [page, showWallet, network, walletClient, walletView.state, walletView.addressSetRevision, walletBalanceRefreshRequest]);

  useEffect(() => {
    const requestRefresh = () => setWalletBalanceRefreshRequest((value) => value + 1);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") requestRefresh();
    };
    window.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("ajochain:wallet-balances-refresh", requestRefresh);
    const interval = page === "assets" || showWallet
      ? window.setInterval(requestRefresh, 60_000)
      : undefined;
    return () => {
      window.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("ajochain:wallet-balances-refresh", requestRefresh);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [page, showWallet]);

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
      setPusdPlanError("Choose a Mainnet receive address in Wallet Details before preparing a PUSD transfer.");
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
    setPusdSignatureError("");
    if (!walletClient || walletClient.state !== "connected" || !connected) {
      setPusdSignatureError("Connect Selene before checking this transfer.");
      return;
    }
    if (network !== "mainnet" || pusdView.status !== "ready") {
      setPusdSignatureMessage("Check your Mainnet PUSD balance first.");
      return;
    }
    if (!walletClient.isReceiveAddressConfirmed("mainnet")) {
      setPusdSignatureMessage("Pick your Mainnet address first.");
      return;
    }
    const senderAddress = walletClient.address("mainnet");
    if (!senderAddress || !pusdRecipient.trim()) {
      setPusdSignatureMessage("Check the sender and recipient addresses.");
      return;
    }
    if (!/^\d+$/.test(pusdMaxFee.trim())) {
      setPusdSignatureMessage("Enter the maximum fee in satoshis.");
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
      setPusdSignatureError(cause instanceof Error ? cause.message : "PUSD signature check failed. Nothing was sent.");
    } finally {
      setPusdSignatureBusy(false);
    }
  };

  const openWallet = () => {
    setMenuOpen(false);
    setShowWallet(true);
    const start = (client: WalletClient) => {
      setWalletClient(client);
      if (client.state === "disconnected") {
        if (!client.retrySavedSession()) client.startFreshPairing();
      } else if (client.state === "idle") {
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

  useEffect(() => {
    // Remember circles by the wallet's first receive address and the network.
    const sessionKey = getDiscoverySessionKey(walletSessionIdentity, walletView.state, walletView.addressSetRevision);
    const previousRun = activeDiscoveryRunRef.current;
    if (previousRun && previousRun.sessionKey === sessionKey) return;
    if (previousRun && previousRun.sessionKey !== sessionKey) {
      previousRun.cancel();
      activeDiscoveryRunRef.current = null;
      discoveryBusyRef.current = false;
      setDiscoveryBusy(false);
    }
    if (!walletClient || walletView.state !== "connected" || walletClient.state !== "connected") return;

    const manualRefresh = discoveryManualRequestRef.current;
    discoveryManualRequestRef.current = false;
    if (discoveryMessageTimerRef.current !== null) {
      window.clearTimeout(discoveryMessageTimerRef.current);
      discoveryMessageTimerRef.current = null;
    }

    let chipnetAddresses: ReturnType<WalletClient["listWalletAddresses"]>;
    let mainnetAddresses: ReturnType<WalletClient["listWalletAddresses"]>;
    try {
      chipnetAddresses = walletClient.listWalletAddresses("chipnet", 49, 20);
      mainnetAddresses = walletClient.listWalletAddresses("mainnet", 49, 20);
    } catch {
      return;
    }
    const firstChipReceive = chipnetAddresses.find((entry) => entry.branch === "receive")?.address ?? "";
    const firstMainReceive = mainnetAddresses.find((entry) => entry.branch === "receive")?.address ?? "";
    const chipnetCache = readWalletDiscoveryCache(window.localStorage, firstChipReceive, "chipnet");
    const mainnetCache = readWalletDiscoveryCache(window.localStorage, firstMainReceive, "mainnet");
    const useChipnetCache = !manualRefresh && chipnetCache !== null;
    const useMainnetCache = !manualRefresh && mainnetCache !== null;

    if (chipnetCache && useChipnetCache) {
      try { mergeCachedDiscoveryCircles(window.localStorage, "chipnet", chipnetCache.circles); } catch { /* cache remains available */ }
      window.dispatchEvent(new Event("ajochain:saved-circles-changed"));
    }
    if (mainnetCache && useMainnetCache) {
      try { mergeCachedDiscoveryCircles(window.localStorage, "mainnet", mainnetCache.circles); } catch { /* cache remains available */ }
      window.dispatchEvent(new Event("ajochain:bch-mainnet-circles-changed"));
    }
    if (useChipnetCache || useMainnetCache) setMenuCircles(readSavedCircleMenuRecords());

    const prioritySnapshot = discoveryPriorityAddressesRef.current;
    const selectedReceive = walletClient.address("mainnet");
    let chipnetTimedOut = false;
    let mainnetTimedOut = false;
    let chipnetStatus = useChipnetCache
      ? "Chipnet: restored " + chipnetCache!.circles.length + " saved circle" + (chipnetCache!.circles.length === 1 ? "." : "s.")
      : "Chipnet: checking…";
    let mainnetStatus = useMainnetCache
      ? "Mainnet: restored " + mainnetCache!.circles.length + " saved circle" + (mainnetCache!.circles.length === 1 ? "." : "s.")
      : "Mainnet: checking…";
    const publishStatus = () => {
      setDiscoveryMessage(chipnetStatus + " · " + mainnetStatus);
      if (discoveryMessageTimerRef.current !== null) {
        window.clearTimeout(discoveryMessageTimerRef.current);
        discoveryMessageTimerRef.current = null;
      }
      const terminalStates = [chipnetStatus, mainnetStatus].map((status) =>
        status.includes("checking…") ? "checking" as const
          : /timed out/i.test(status) ? "timeout" as const
            : /unavailable|cancelled/i.test(status) ? "error" as const
              : "success" as const,
      );
      if (shouldAutoHideDiscoveryMessage(terminalStates)) {
        discoveryMessageTimerRef.current = window.setTimeout(() => {
          setDiscoveryMessage("");
          discoveryMessageTimerRef.current = null;
        }, 4_000);
      }
    };
    const run = {
      sessionKey,
      cancelled: false,
      cancel: () => {
        if (run.cancelled) return;
        run.cancelled = true;
        chipnetStatus = getCancelledDiscoveryStatus("Chipnet");
        mainnetStatus = getCancelledDiscoveryStatus("Mainnet");
        publishStatus();
      },
    };

    if (discoveryBusyRef.current) return;
    discoveryBusyRef.current = true;
    activeDiscoveryRunRef.current = run;
    setDiscoveryBusy(!useChipnetCache || !useMainnetCache);
    publishStatus();

    void (async () => {
      try {
        const [{ getClassicProvider }, { discoverV2FeeCircles, encodeV2FeeCircleParams }, { dedupeSavedV2FeeCircleRecords, getV2FeeCircleRecordIdentity }] = await Promise.all([
          import("./core/classic-bch"),
          import("./core/v2-fee-discovery"),
          import("./core/v2-fee-circle-records"),
        ]);
        if (run.cancelled) return;

        await settleIndependentTasks(
          async () => {
            if (useChipnetCache) return { foundCount: chipnetCache!.circles.length };
            const provider = await getClassicProvider("chipnet");
            const addresses = chipnetAddresses.map((entry) => entry.address);
            if (addresses.length === 0) throw new Error("No Chipnet wallet addresses are available.");
            const found = await discoverV2FeeCircles(provider, addresses, undefined, "chipnet", {
              requestTimeoutMs: 10_000,
              overallTimeoutMs: 45_000,
              onTimeout: () => { chipnetTimedOut = true; },
            });
            if (run.cancelled) return { foundCount: 0 };
            const encodedFound = found.map(encodeV2FeeCircleParams);
            const stored: unknown = JSON.parse(window.localStorage.getItem(V2_MENU_STORAGE_KEY) || "[]");
            const existing = dedupeSavedV2FeeCircleRecords(stored);
            const known = new Set(existing.flatMap((record) => {
              const identity = getV2FeeCircleRecordIdentity(record.encoded);
              return identity ? [identity.stateCategory.toLowerCase()] : [];
            }));
            const additions = found
              .filter((params) => !known.has(params.stateCategory.toLowerCase()))
              .map((params) => ({ encoded: encodeV2FeeCircleParams(params), savedAt: 0 }));
            if (additions.length > 0) {
              window.localStorage.setItem(V2_MENU_STORAGE_KEY, JSON.stringify([...existing, ...additions]));
              window.dispatchEvent(new Event("ajochain:saved-circles-changed"));
            }
            writeWalletDiscoveryCache(window.localStorage, firstChipReceive, "chipnet", encodedFound);
            if (!run.cancelled) setMenuCircles(readSavedCircleMenuRecords());
            return { foundCount: found.length };
          },
          async () => {
            if (useMainnetCache) return { foundCount: mainnetCache!.circles.length };
            if (mainnetAddresses.length === 0) throw new Error("No Mainnet wallet addresses are available.");
            const knownActiveAddresses = prioritySnapshot.choices
              .filter((choice) => choice.hasHistory || choice.hasPendingHistory ||
                BigInt(choice.confirmedSatoshis) > 0n || BigInt(choice.unconfirmedSatoshis) > 0n)
              .sort((left, right) => {
                const a = BigInt(left.confirmedSatoshis) + BigInt(left.unconfirmedSatoshis);
                const b = BigInt(right.confirmedSatoshis) + BigInt(right.unconfirmedSatoshis);
                return a === b ? left.index - right.index : a > b ? -1 : 1;
              }).map((choice) => choice.address);
            const priorityAddresses = [
              ...(selectedReceive ? [selectedReceive] : []),
              ...knownActiveAddresses,
            ];
            const provider = await getClassicProvider("mainnet");
            const mainnetFound = await discoverV2FeeCircles(
              provider, mainnetAddresses.map((entry) => entry.address), undefined, "mainnet",
              {
                priorityAddresses,
                requestTimeoutMs: 10_000,
                overallTimeoutMs: 45_000,
                onTimeout: () => { mainnetTimedOut = true; },
              },
            );
            if (run.cancelled) return { foundCount: 0 };
            const encodedFound = mainnetFound.map(encodeV2FeeCircleParams);
            const savedMainnet: unknown = JSON.parse(window.localStorage.getItem(BCH_MAINNET_CIRCLES_STORAGE_KEY) || "[]");
            const savedList = Array.isArray(savedMainnet)
              ? savedMainnet.filter((entry): entry is string => typeof entry === "string") : [];
            const savedCategories = new Set(savedList.flatMap((encoded) => {
              const identity = getV2FeeCircleRecordIdentity(encoded);
              return identity ? [identity.stateCategory.toLowerCase()] : [];
            }));
            const mainnetAdditions = mainnetFound.filter((params) =>
              !savedCategories.has(params.stateCategory.toLowerCase()),
            );
            if (mainnetAdditions.length > 0) {
              window.localStorage.setItem(BCH_MAINNET_CIRCLES_STORAGE_KEY, JSON.stringify([
                ...savedList, ...mainnetAdditions.map(encodeV2FeeCircleParams),
              ]));
            }
            writeWalletDiscoveryCache(window.localStorage, firstMainReceive, "mainnet", encodedFound);
            window.dispatchEvent(new Event("ajochain:bch-mainnet-circles-changed"));
            if (!run.cancelled) setMenuCircles(readSavedCircleMenuRecords());
            return { foundCount: mainnetFound.length };
          },
          (result) => {
            if (run.cancelled || useChipnetCache) return;
            chipnetStatus = getDiscoveryNetworkStatus("Chipnet", result, chipnetTimedOut);
            publishStatus();
          },
          (result) => {
            if (run.cancelled || useMainnetCache) return;
            mainnetStatus = getDiscoveryNetworkStatus("Mainnet", result, mainnetTimedOut);
            publishStatus();
          },
        );
      } catch {
        if (!run.cancelled) {
          if (!useChipnetCache) chipnetStatus = "Chipnet: unavailable, tap Check again.";
          if (!useMainnetCache) mainnetStatus = "Mainnet: unavailable, tap Check again.";
          publishStatus();
        }
      } finally {
        if (activeDiscoveryRunRef.current === run) {
          activeDiscoveryRunRef.current = null;
          discoveryBusyRef.current = false;
          setDiscoveryBusy(false);
        }
      }
    })();
  }, discoveryEffectDependencies);

  const gatherWalletCoins = async () => {
    if (!walletClient || walletClient.state !== "connected" || !walletAddress || gatherBusy) return;

    // First action: scan and display the exact existing plan. No signature or
    // broadcast is requested until the saver presses the review CTA below.
    if (!gatherPlan) {
      const gatherNetwork = network;
      const destinationAddress = walletClient.address(gatherNetwork);
      if (!destinationAddress) {
        setGatherResult({ status: "error", message: "Wallet address is not available. Reconnect and try again." });
        return;
      }
      if (gatherNetwork === "mainnet" && !walletClient.isReceiveAddressConfirmed("mainnet")) {
        setGatherResult({ status: "error", message: "Pick an address first." });
        return;
      }
      const gatherWalletIdentity = gatherNetwork === "mainnet" ? walletClient.getSessionIdentity() : null;
      if (gatherNetwork === "mainnet" && !gatherWalletIdentity) {
        setGatherResult({ status: "error", message: "Reconnect Selene before combining BCH." });
        return;
      }
      setGatherBusy(true);
      setGatherResult(null);
      setBchBalanceScan(null);
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
        setBchBalanceScan({ address: destinationAddress, network: gatherNetwork, totalSatoshis: plan.totalSatoshis });
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
        window.dispatchEvent(new Event("ajochain:wallet-balances-refresh"));
      } else {
        const txid = await prepared.provider.sendRawTransaction(signed.signedTransaction);
        setGatherResult({ status: "success", txid, network: gatherNetwork });
        window.dispatchEvent(new Event("ajochain:wallet-balances-refresh"));
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
    if (page === "circle-detail") setPage("my-circles");
    setSelectedMenuCircle(null);
    setMenuOpen(false);
    setAddressMatchMessage("");
    setSeleneAddress("");
  };

  // Keep the derived address visible even before Selene's current Receive
  // screen has been explicitly matched. Users need to compare this candidate
  // with the address shown in Selene before confirming it in Wallet Details.
  const shortAddress = (value: string | null) =>
    value ? value.slice(0, 13) + "…" + value.slice(-4) : "Address unavailable…";
  const updatedAgeLabel = (timestamp: number | null) => {
    if (!timestamp) return "Not updated yet";
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 10) return "Updated just now";
    if (seconds < 60) return "Updated " + seconds + "s ago";
    const minutes = Math.floor(seconds / 60);
    return "Updated " + minutes + "m ago";
  };
  const currentBchBalanceScan = bchBalanceScan && bchBalanceScan.network === network
    ? bchBalanceScan
    : null;
  const walletBchBalanceSummary = getWalletBchBalanceSummary({
    network,
    connected,
    walletAddressChoices,
    currentBchBalanceScan,
    receiveAddressScanLoading,
  });
  const selectedWalletAddressChoice = getMostFundedWalletAddress(walletAddressChoices, selectedWalletAddress);
  const displayWalletAddress = selectedWalletAddressChoice?.address ?? walletAddress;
  const firstWalletReceiveAddress = walletAddressChoices.find((choice) =>
    choice.branch === "receive",
  )?.address ?? "";
  const walletAddressSelectionKey = firstWalletReceiveAddress
    ? getWalletAddressSelectionKey(firstWalletReceiveAddress, network)
    : null;
  const selectedReceiveAddressChoice = walletAddressChoices.find((choice) =>
    choice.branch === "receive" && choice.index === walletView.receiveIndex,
  ) ?? null;
  const sortedWalletAddressChoices = [...walletAddressChoices].sort((left, right) => {
    const leftTotal = BigInt(left.confirmedSatoshis) + BigInt(left.unconfirmedSatoshis);
    const rightTotal = BigInt(right.confirmedSatoshis) + BigInt(right.unconfirmedSatoshis);
    if (leftTotal !== rightTotal) return leftTotal > rightTotal ? -1 : 1;
    if (left.branch !== right.branch) return left.branch === "receive" ? -1 : 1;
    return left.index - right.index;
  });
  const visibleWalletAddressChoices = showAllWalletAddresses
    ? sortedWalletAddressChoices
    : sortedWalletAddressChoices.filter((choice) =>
        BigInt(choice.confirmedSatoshis) + BigInt(choice.unconfirmedSatoshis) > 0n,
      );
  const selectedAddressPendingOnly = network === "mainnet" && Boolean(selectedReceiveAddressChoice &&
    BigInt(selectedReceiveAddressChoice.confirmedSatoshis) === 0n &&
    (BigInt(selectedReceiveAddressChoice.unconfirmedSatoshis) > 0n || selectedReceiveAddressChoice.hasPendingHistory));


  const renderCircleRows = (circles: MenuCircle[], compact = false) => (
    <div className={compact ? "my-circles-list compact-list" : "my-circles-list"}>
      {circles.map((circle) => (
        <div className="my-circle-entry" key={circle.id}>
          <button type="button" className="my-circle-row" onClick={() => openMenuCircle(circle)}>
            <span className="my-circle-copy">
              <b>{circle.name}</b>
              <span>{circle.asset} · {circle.contributionLabel} · {circle.memberCount} members</span>
              <small>{circle.status === "completed" || circle.status === "cancelled"
                ? (circle.status === "cancelled" ? "Cancelled" : "Completed") +
                  (circle.completedAt ? " · " + new Date(circle.completedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "")
                : circle.status === "unknown"
                  ? circle.checkedAt === null ? "Checking on-chain status…" : "Status unavailable · latest chain read failed"
                  : circle.round === null
                    ? "Checking round progress · " + circle.memberCount + " members"
                    : "Round " + Math.min(circle.round + 1, circle.memberCount) + " of " + circle.memberCount}</small>
            </span>
            <span className={
              circle.status === "completed" ? "my-circle-status completed"
                : circle.status === "cancelled" ? "my-circle-status cancelled"
                  : circle.status === "unknown" ? circle.checkedAt === null ? "my-circle-status checking" : "my-circle-status unavailable" : "my-circle-status"
            }>{circle.status === "completed" ? "Completed"
              : circle.status === "cancelled" ? "Cancelled"
                : circle.status === "unknown" ? circle.checkedAt === null ? "Checking…" : "Status unavailable" : "Active"}</span>
            <ArrowRight size={17} />
          </button>
          {circle.status === "unknown" && circle.checkedAt !== null && (
            <button type="button" className="secondary-button circle-status-retry"
              onClick={() => retryCircleStatus(circle)}>Retry status check</button>
          )}
        </div>
      ))}
    </div>
  );

  const renderCircleTabs = () => (
    <div className="my-circles-tabs" role="tablist" aria-label="Circle status">
      <button type="button" role="tab" aria-selected={circleStatusTab === "active"}
        className={circleStatusTab === "active" ? "selected" : ""}
        onClick={() => setCircleStatusTab("active")}>Active ({networkCircleCounts.active})</button>
      <button type="button" role="tab" aria-selected={circleStatusTab === "completed"}
        className={circleStatusTab === "completed" ? "selected" : ""}
        onClick={() => setCircleStatusTab("completed")}>Completed ({networkCircleCounts.completed})</button>
    </div>
  );

  return (
    <main className="app-shell compact-app">
      <header className="app-header">
        <a className="brand" href="#overview" onClick={() => navigate("overview")} aria-label="AjoChain home">
          <span className="brand-mark">a</span><span>AjoChain</span>
        </a>
        <div className="header-actions">
          <button type="button" className="header-network-pill" onClick={() => {
            setMenuCircles(readSavedCircleMenuRecords());
            setMenuOpen(true);
          }} aria-label={"Selected network: " + NETWORKS[network].label + ". Open network options."}>
            <span className="network-dot" />{network === "mainnet" ? "Mainnet" : "Chipnet"}
          </button>
          <button
            className={"header-wallet-chip wallet-state-" + walletView.state}
            type="button"
            onClick={openWallet}
            aria-label={"Wallet status: " + walletStateLabel + ". Open wallet details."}
          >
            <span className={"wallet-state-dot " + (connected ? "is-connected" : "is-idle")} />
            {connected && displayWalletAddress ? shortAddress(displayWalletAddress) : walletStateLabel}
          </button>
          {connected && displayWalletAddress && (
            <button className="header-wallet-copy" type="button" aria-label="Copy wallet address"
              onClick={() => { if (displayWalletAddress) void navigator.clipboard.writeText(displayWalletAddress).catch(() => undefined); }}>
              <Copy size={15} />
            </button>
          )}
          <button
            className={menuOpen ? "menu-trigger menu-trigger-open" : "menu-trigger"}
            type="button"
            aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={menuOpen}
            aria-controls="ajochain-dropdown"
            onClick={() => {
              setMenuCircles(readSavedCircleMenuRecords());
              setMenuOpen((value) => !value);
            }}
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
                <button className={page === "my-circles" || page === "circle-detail" ? "dropdown-item active" : "dropdown-item"} onClick={() => navigate("my-circles")}>
                  <Users size={17} /><span>My circles</span>{(page === "my-circles" || page === "circle-detail") && <Check size={15} />}
                </button>
                <button className={page === "assets" ? "dropdown-item active" : "dropdown-item"} onClick={() => navigate("assets")}>
                  <Wallet size={17} /><span>Wallet</span>{page === "assets" && <Check size={15} />}
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
                    <span className="network-dot" />
                    <span>{id === "chipnet" ? "Chipnet" : "Mainnet"}</span>
                    {network === id && <Check size={14} />}
                  </button>
                ))}
              </div>
              <div className="dropdown-divider" />
              <button type="button" className="dropdown-wallet" onClick={openWallet}>
                <span className="dropdown-wallet-icon"><Wallet size={17} /></span>
                <span><b>{connected ? walletView.walletName ?? "Wallet connected" : "Connect wallet"}</b><small>{connected ? shortAddress(displayWalletAddress) : walletView.state === "reconnecting" ? "Reconnecting…" : "Selene"}</small></span>
                <ArrowRight size={16} />
              </button>
            </section>
          </>
        )}
      </header>

      <div className="page-body">

        {page === "overview" && (
          <>
            {renderCircleRiskNotice()}
            <section className="welcome-hero overview-clean-hero">
              <h1>Your Ajo savings circle, on Bitcoin Cash.</h1>
              <div className="hero-actions">
                <button className="primary-button hero-cta" type="button" onClick={() => navigate("create-circle")}>
                  Create a circle <ArrowRight size={16} />
                </button>
                <button className="secondary-button hero-secondary-cta" type="button" onClick={() => navigate("my-circles")}>
                  My circles
                </button>
              </div>
            </section>
          </>
        )}

        {page === "create-circle" && (
          <section className="page-section create-circle-page">
            {renderCircleRiskNotice()}
            {createCircleView === "choose" ? (
              <>
                <div className="page-intro">
                  <span className="section-kicker">YOUR SAVINGS GROUPS</span>
                  <h1>Create a circle</h1>
                  <p>Choose what your group wants to save in, set the amount and members, then review the circle setup before taking action.</p>
                </div>
                <section className="circle-choice-guide" aria-label="Choose a circle type">
                  <div className="circle-choice-heading">
                    <div><span className="section-kicker">CHOOSE YOUR CIRCLE</span><h2>What kind of circle do you want?</h2>
                      <p>{network === "mainnet" ? "Choose BCH or PUSD. These are separate circles with their own member lists and payments." : "Try the circle options on Chipnet first."}</p></div>
                  </div>
                  <div className="circle-choice-grid">
                    {network === "mainnet" && <>
                      <button type="button" className={circleWorkspace === "bch-mainnet" ? "circle-choice-card selected" : "circle-choice-card"} aria-pressed={circleWorkspace === "bch-mainnet"} onClick={() => enterCreateCircleForm("bch-mainnet")}>
                        <span className="circle-choice-top"><span className="circle-choice-symbol">BCH</span><span className="circle-choice-status">Mainnet</span></span>
                        <b>BCH savings circle</b>
                        <span>For groups saving in Bitcoin Cash. Tracks member contributions and reserves the next installment for each non-final payout.</span>
                        <small>Best when your group wants native BCH and individual member accounting.</small>
                      </button>
                      <button type="button" className={circleWorkspace === "pusd-mainnet" ? "circle-choice-card selected" : "circle-choice-card"} aria-pressed={circleWorkspace === "pusd-mainnet"} onClick={() => enterCreateCircleForm("pusd-mainnet")}>
                        <span className="circle-choice-top"><span className="circle-choice-symbol pusd">PUSD</span><span className="circle-choice-status">Mainnet</span></span>
                        <b>PUSD savings circle</b>
                        <span>For groups that prefer ParyonUSD instead of BCH. Contributions and payouts are denominated in PUSD, with BCH needed separately for network fees.</span>
                        <small>Choose this if your group wants a stable-value token rather than BCH price exposure.</small>
                      </button>
                    </>}
                    {network === "chipnet" && <>
                      <button type="button" className={circleWorkspace === "bch-fair-round" ? "circle-choice-card selected" : "circle-choice-card"} aria-pressed={circleWorkspace === "bch-fair-round"} onClick={() => enterCreateCircleForm("bch-fair-round")}>
                        <span className="circle-choice-top"><span className="circle-choice-symbol">BCH</span><span className="circle-choice-status testing">Chipnet · test</span></span>
                        <b>BCH savings circle</b>
                        <span>Experimental member-credit model. Members fund the current round; a non-final recipient carries one next contribution forward in their own receipt.</span>
                        <small>Try this option for the newer round-by-round savings experience.</small>
                      </button>
                      <button type="button" className={circleWorkspace === "bch-classic" ? "circle-choice-card selected" : "circle-choice-card"} aria-pressed={circleWorkspace === "bch-classic"} onClick={() => enterCreateCircleForm("bch-classic")}>
                        <span className="circle-choice-top"><span className="circle-choice-symbol">BCH</span><span className="circle-choice-status testing">Chipnet · legacy</span></span>
                        <b>Classic BCH savings circle</b>
                        <span>A simple rotating savings group with a shared BCH pot and a set order for payouts.</span>
                        <small>Use this option for older circles or simple compatibility testing.</small>
                      </button>
                    </>}
                  </div>
                  
                </section>
              </>
            ) : (
              <>
                <button type="button" className="secondary-button create-circle-back" onClick={leaveCreateCircleForm}>
                  ← Back to circle types
                </button>
                <Suspense fallback={<div className="workspace-loading"><span className="loading-orb" />Loading your circle form…</div>}>
                  {network === "mainnet" && circleWorkspace === "bch-mainnet" && (
                    <BchMainnetCircleWorkspace key="create-bch-mainnet" network={network} walletConnected={connected}
                      selectedAddressPendingOnly={selectedAddressPendingOnly}
                      onOpenWalletDetails={openWallet} onBusyChange={setCreateCircleWorkspaceBusy} />
                  )}
                  {network === "mainnet" && circleWorkspace === "pusd-mainnet" && (
                    <PusdMainnetCircleWorkspace key="create-pusd-mainnet" network={network} walletConnected={connected}
                      selectedAddressPendingOnly={selectedAddressPendingOnly}
                      onBusyChange={setCreateCircleWorkspaceBusy} />
                  )}
                  {network === "chipnet" && circleWorkspace === "bch-fair-round" && (
                    <V2FeeBchWorkspace key="create-bch-fair-round" network={network} walletConnected={connected}
                      view="create" onCircleSaved={() => setMenuCircles(readSavedCircleMenuRecords())}
                      onBusyChange={setCreateCircleWorkspaceBusy} />
                  )}
                  {circleWorkspace === "bch-classic" && (
                    <ClassicBchWorkspace key={classicInviteRevision + "-create-classic"} network={network}
                      walletConnected={connected} onBusyChange={setCreateCircleWorkspaceBusy} />
                  )}
                </Suspense>
              </>
            )}
          </section>
        )}


        {page === "my-circles" && (
          <section className="page-section my-circles-page">
            {renderCircleRiskNotice()}
            <div className="page-intro">
              <span className="section-kicker">YOUR SAVINGS CIRCLES</span>
              <h1>{network === "mainnet" ? "Mainnet circles" : "Chipnet test circles"}</h1>
              <p>Circles are shown only for the network selected in the navigation menu. Status is read from the selected network's blockchain.</p>
            </div>
            <div className="circle-scan-summary-row">
              <span className="circle-scan-summary" role="status">✓ {NETWORKS[network].label}: {networkCircleCounts.active} active, {networkCircleCounts.completed} completed</span>
              {visibleNetworkCircles.some((circle) => circle.status === "unknown") &&
                <span className="circle-scan-warning" role="status">{visibleNetworkCircles.filter((circle) => circle.status === "unknown").length} status check(s) unavailable</span>}
            </div>
            {network === "mainnet" && (
              <section className="pusd-mainnet-saved mainnet-invite-join" aria-label="Join a Mainnet circle">
                <div className="section-heading">
                  <div><span className="section-kicker">INVITE</span><h2>Join a circle</h2></div>
                </div>
                <label>Circle invite link
                  <input value={mainnetInviteInput} onChange={(event) => setMainnetInviteInput(event.target.value)}
                    placeholder="Paste a BCH or PUSD Mainnet invite link" autoComplete="off" />
                </label>
                <button type="button" className="secondary-button" disabled={!mainnetInviteInput.trim()}
                  onClick={joinMainnetCircleWithInvite}>Join with invite</button>
                {mainnetInviteError && <p className="classic-error" role="alert">{mainnetInviteError}</p>}
                {mainnetInviteNotice && <p className="classic-notice" role="status">{mainnetInviteNotice}</p>}
              </section>
            )}
            {renderCircleTabs()}
            {visibleStatusCircles.length === 0 ? (
              <div className="my-circles-empty">
                {circleStatusTab === "active" ? (
                  <>
                    <h2>No active circles on {network === "mainnet" ? "Mainnet" : "Chipnet"} yet</h2>
                    <p>New circles appear here as soon as they are saved and their chain status is checked.</p>
                    <button type="button" className="primary-button" onClick={() => navigate("create-circle")}>Create a circle</button>
                  </>
                ) : (
                  <>
                    <h2>No completed circles yet</h2>
                    <p>Completed payouts and confirmed cancellations move here after the blockchain check. Cancelled circles are labelled separately.</p>
                  </>
                )}
              </div>
            ) : renderCircleRows(visibleStatusCircles)}
          </section>
        )}

        {page === "circle-detail" && selectedCircleRecord && (
          <section className="page-section">
            {renderCircleRiskNotice()}
            <button type="button" className="secondary-button my-circles-back" onClick={() => {
              setMenuCircles(readSavedCircleMenuRecords());
              setSelectedMenuCircle(null);
              setPage("my-circles");
            }}>← Back to My circles</button>
            <div className="page-intro">
              <span className="section-kicker">YOUR SAVINGS CIRCLE</span>
              <h1>{selectedCircleRecord?.name ?? "Circle details"}</h1>
              <p>Review contributions, member progress and the next payout for this circle.</p>
            </div>
            <Suspense fallback={<div className="workspace-loading"><span className="loading-orb" />Loading your circle…</div>}>
              {selectedCircleRecord?.kind === "v2-fee" && (
                <V2FeeBchWorkspace key={selectedCircleRecord.id} network={network} walletConnected={connected} view="circle" selectedCircle={selectedCircleRecord.encoded} />
              )}
              {selectedCircleRecord?.kind === "classic" && (
                <ClassicBchWorkspace key={selectedCircleRecord.id} network={network} walletConnected={connected} selectedCircle={selectedCircleRecord.encoded} />
              )}
              {selectedCircleRecord?.kind === "bch-mainnet" && (
                <BchMainnetCircleWorkspace key={selectedCircleRecord.id} network={network} walletConnected={connected}
                  selectedAddressPendingOnly={selectedAddressPendingOnly} onOpenWalletDetails={openWallet} selectedCircle={selectedCircleRecord.encoded} />
              )}
              {selectedCircleRecord?.kind === "pusd-mainnet" && (
                <PusdMainnetCircleWorkspace key={selectedCircleRecord.id} network={network} walletConnected={connected}
                  selectedAddressPendingOnly={selectedAddressPendingOnly} selectedCircle={selectedCircleRecord.encoded} />
              )}
            </Suspense>
          </section>
        )}

        {page === "assets" && (
          <section className="page-section wallet-page">
            <div className="page-intro">
              <span className="section-kicker">SAVE YOUR WAY</span>
              <h1>Bitcoin Cash or digital dollars</h1>
              <p>Your circle, your currency. Fees are always shown before you sign.</p>
            </div>

            <section className="asset-preview wallet-save-options">
              <div className="asset-preview-rows">
                <div>
                  <span className="asset-symbol">B</span>
                  <span>
                    <b>Bitcoin Cash</b>
                    <small>Fast, low-fee savings. Practise free on Chipnet, then save for real on Mainnet.</small>
                  </span>
                  <span className="asset-state">Live</span>
                </div>
                <div>
                  <span className="asset-symbol pusd-symbol">P</span>
                  <span>
                    <b>ParyonUSD (PUSD)</b>
                    <small>Save in steady dollars, no bank needed. Balances checked straight on the blockchain.</small>
                  </span>
                  <span className="asset-state neutral">Mainnet</span>
                </div>
              </div>
            </section>

            <article className="asset-detail-card wallet-balance-card">
              <div className="wallet-balance-heading">
                <div>
                  <span className="section-kicker">WALLET</span>
                  <h2>{connected ? walletView.walletName ?? "Selene wallet" : "Connect your wallet"}</h2>
                  <small>{connected ? shortAddress(displayWalletAddress) : "Connect Selene to see your balances."}</small>
                </div>
              </div>
              <div className="wallet-balance-total">
                <span>BCH total</span>
                <strong>{walletBchBalanceSummary.balanceLabel}</strong>
              </div>
              <div className="wallet-balance-list">
                <div className="wallet-balance-row">
                  <span className="asset-symbol pusd-symbol">P</span>
                  <div><b>ParyonUSD</b><small>Across your wallet addresses</small></div>
                  <strong>{!connected ? "Connect wallet" : network !== "mainnet" ? "Mainnet only" : pusdView.status === "ready" ? formatAssetAmount("PUSD", pusdView.amount) + " PUSD" : pusdView.status === "loading" ? "Checking…" : "Not checked"}</strong>
                </div>
              </div>
              <div className="wallet-balance-actions">
                <span className="wallet-updated-age" role="status">{updatedAgeLabel(walletBalancesUpdatedAt)}</span>
                <button type="button" className="secondary-button" onClick={() => {
                  if (!connected) { openWallet(); return; }
                  setWalletBalanceRefreshRequest((value) => value + 1);
                }} disabled={walletBalancesBusy}>
                  <RefreshCw size={15} className={walletBalancesBusy ? "activity-spin" : ""} />
                  {walletBalancesBusy ? "Refreshing…" : "Refresh"}
                </button>
                <button type="button" className="secondary-button" onClick={openWallet}>
                  {connected ? "Wallet details" : "Connect wallet"}
                </button>
              </div>
              {receiveAddressScanError && (
                <div className="classic-error wallet-balance-error" role="alert">
                  <span>{receiveAddressScanError}</span>
                  <button type="button" aria-label="Close error" onClick={() => setReceiveAddressScanError("")}>×</button>
                </div>
              )}
            </article>

            <details className="technical-details wallet-technical-details">
              <summary>Details</summary>
              <div className="asset-detail-row"><span>Selected network</span><b>{NETWORKS[network].label}</b></div>
              <div className="asset-detail-row"><span>Receive address</span><b>{connected && walletClient?.isReceiveAddressConfirmed(network) ? "Confirmed" : connected ? "Choose address" : "Wallet not connected"}</b></div>
              <div className="asset-detail-row"><span>BCH balance check</span><b>{walletBalancesUpdatedAt ? "Updated" : "Not checked"}</b></div>
              <div className="asset-detail-row"><span>PUSD balance check</span><b>{pusdView.status === "ready" ? "Updated" : pusdView.status === "loading" ? "Checking" : pusdView.status === "error" ? "Unavailable" : "Not checked"}</b></div>
              {pusdView.status === "ready" && <p>{pusdView.providerConfidence} sources · block {pusdView.tipHeight.toLocaleString()} · {pusdView.utxoCount} PUSD coins.</p>}
              {pusdView.status !== "ready" && <p>{pusdView.detail}</p>}
              <div className="asset-detail-row"><span>PUSD transfers</span><b>{PUSD_MAINNET_SPENDING_ENABLED ? "Available after wallet checks" : "Not available yet"}</b></div>
            </details>

            <details className="wallet-tools-disclosure">
              <summary>Advanced</summary>
              <div className="pusd-transfer-box">
                <div><span className="section-kicker">TRANSFER PREVIEW</span><h3>Prepare a PUSD transfer</h3>
                  <p>Review a transfer using the PUSD coins in your wallet and the latest network fee estimate. Nothing is sent from this preview.</p></div>
                <label>Recipient Bitcoin Cash address
                  <input value={pusdRecipient} onChange={(event) => { setPusdRecipient(event.target.value); setPusdTransferPlan(null); setPusdSignatureMessage(""); setPusdPlanError(""); setPusdSignatureError(""); }} placeholder="bitcoincash:…" autoComplete="off" />
                </label>
                <div className="pusd-transfer-fields">
                  <label>Amount (PUSD)
                    <input value={pusdAmount} onChange={(event) => { setPusdAmount(event.target.value); setPusdTransferPlan(null); setPusdSignatureMessage(""); setPusdPlanError(""); setPusdSignatureError(""); }} inputMode="decimal" placeholder="0.02" />
                  </label>
                  <label>Maximum miner fee (sats)
                    <input value={pusdMaxFee} onChange={(event) => { setPusdMaxFee(event.target.value); setPusdTransferPlan(null); setPusdSignatureMessage(""); setPusdPlanError(""); setPusdSignatureError(""); }} inputMode="numeric" />
                  </label>
                </div>
                <button type="button" className="secondary-button" onClick={() => void preparePusdTransfer()} disabled={pusdPlanBusy || pusdView.status !== "ready" || network !== "mainnet"}>
                  {pusdPlanBusy ? "Preparing preview…" : "Prepare transfer preview"}
                </button>
                {pusdPlanError && <div className="classic-error" role="alert"><span>{pusdPlanError}</span><button type="button" aria-label="Close error" onClick={() => setPusdPlanError("")}>×</button></div>}
                {pusdTransferPlan && (
                  <div className="pusd-plan-summary" role="status">
                    <b>Transfer plan ready · review only</b>
                    <div><span>Recipient receives</span><strong>{formatAssetAmount("PUSD", pusdTransferPlan.recipientPusdAmount)} PUSD</strong></div>
                    <div><span>PUSD returned to your wallet</span><strong>{formatAssetAmount("PUSD", pusdTransferPlan.changePusdAmount)} PUSD</strong></div>
                    <div><span>Estimated BCH miner fee</span><strong>{pusdTransferPlan.minerFeeSatoshis.toString()} sats</strong></div>
                    <div><span>BCH needed for delivery</span><strong>{pusdTransferPlan.recipientCarrierSatoshis.toString()} sats</strong></div>
                    <div><span>Coins selected</span><strong>{pusdTransferPlan.selectedUtxos.length}</strong></div>
                    <details className="technical-details"><summary>Details</summary><p>Estimated size {pusdTransferPlan.estimatedSizeBytes} bytes · fee rate {pusdTransferPlan.feeRateSatoshisPerKb.toString()} sats/kB. The plan must be rebuilt from fresh chain data before any signature.</p></details>
                  </div>
                )}
                <button type="button" className="secondary-button" disabled={!pusdTransferPlan || pusdSignatureBusy || !connected || network !== "mainnet"}
                  onClick={() => void verifyPusdTransferSignature()}>
                  {pusdSignatureBusy ? "Test signing…" : "Test sign · no money sent"}
                </button>
                {pusdSignatureMessage && <p className="classic-notice" role="status">{pusdSignatureMessage}</p>}
                {pusdSignatureError && <div className="classic-error" role="alert"><span>{pusdSignatureError}</span><button type="button" aria-label="Close error" onClick={() => setPusdSignatureError("")}>×</button></div>}
                <button type="button" className="primary-button" disabled={!PUSD_MAINNET_SPENDING_ENABLED || !pusdTransferPlan}
                  title="PUSD Mainnet spending is not yet approved by the security release gate">
                  Send PUSD · Mainnet locked
                </button>
                <small className="field-hint">PUSD sending remains locked while its safety review is completed.</small>
              </div>
            </details>
          </section>
        )}

        {page === "activity" && (
          <Suspense fallback={<section className="page-section"><p className="classic-empty">Loading chain-backed activity…</p></section>}>
            <ActivityRecords network={network} key={"activity-" + network} />
          </Suspense>
        )}
      </div>

      {walletView.error && (
        <div className="global-wallet-error" role="alert">
          <ShieldCheck size={17} />
          <span>{walletView.error}</span>
          <div className="global-wallet-error-actions">
            <button type="button" onClick={() => {
              if (!walletClient) return;
              if (walletClient.retrySavedSession()) return;
              if (walletClient.state === "disconnected") walletClient.startFreshPairing();
              else if (walletClient.state === "idle") walletClient.connect();
            }}>Reconnect</button>
            <button type="button" aria-label="Close error" onClick={() => setWalletView((view) => ({ ...view, error: null }))}>×</button>
          </div>
        </div>
      )}

      {showWallet && (
        <div className="modal-backdrop wallet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowWallet(false); }}>
          <section className="create-modal wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-title">
            <div className="modal-heading">
              <div>
                <h2 id="wallet-title">Wallet</h2>
                {!connected && <p>Connect Selene. Your keys never leave your phone.</p>}
              </div>
              <button className="modal-close" onClick={() => setShowWallet(false)} aria-label="Close"><X size={19} /></button>
            </div>
            {connected ? (
              <div className="wallet-detail-body">
                <div className="wallet-detail-balances">
                  <span className="wallet-detail-label">BITCOIN CASH</span>
                  <strong className="wallet-detail-bch-total">{walletBchBalanceSummary.balanceLabel}</strong>
                  <div className="wallet-detail-pusd">
                    <span>ParyonUSD</span>
                    <b>{network !== "mainnet" ? "Mainnet only" : pusdView.status === "ready"
                      ? formatAssetAmount("PUSD", pusdView.amount) + " PUSD"
                      : pusdView.status === "loading" ? "Checking…" : pusdView.status === "error" ? "Unavailable" : "Not checked"}</b>
                  </div>
                  <div className="wallet-updated-row">
                    <small role="status">{updatedAgeLabel(walletBalancesUpdatedAt)}</small>
                    <button type="button" className="secondary-button wallet-refresh-button"
                      disabled={walletBalancesBusy}
                      onClick={() => setWalletBalanceRefreshRequest((value) => value + 1)}>
                      <RefreshCw size={14} className={walletBalancesBusy ? "activity-spin" : ""} />
                      {walletBalancesBusy ? "Refreshing…" : "Refresh"}
                    </button>
                  </div>
                </div>

                <div className="wallet-address-card">
                  <span>{NETWORKS[network].label} · {selectedWalletAddressChoice?.branch === "change" ? "Change address" : "Receive address"}</span>
                  <button type="button" className="wallet-address-display" onClick={() => setWalletAddressRevealed((value) => !value)}>
                    <code>{walletAddressRevealed ? displayWalletAddress ?? "Address unavailable" : shortAddress(displayWalletAddress)}</code>
                    <small>{walletAddressRevealed ? "Hide full address" : "Show full address"}</small>
                  </button>
                  <div className="wallet-address-actions">
                    <button type="button" className="secondary-button wallet-copy-address" disabled={!displayWalletAddress}
                      onClick={() => { if (displayWalletAddress) void navigator.clipboard.writeText(displayWalletAddress).catch(() => undefined); }}>
                      <Copy size={14} /> Copy address
                    </button>
                    <button type="button" className="secondary-button" disabled={!displayWalletAddress}
                      onClick={() => setShowWalletAddressQr((value) => !value)}>
                      <QrCode size={14} /> {showWalletAddressQr ? "Hide QR" : "Show QR"}
                    </button>
                  </div>
                  {showWalletAddressQr && walletAddressQrDataUrl && <img className="wallet-qr wallet-address-qr" src={walletAddressQrDataUrl} alt="Wallet address QR code" />}
                </div>

                <section className="receive-address-picker wallet-address-picker" aria-labelledby="wallet-address-picker-title">
                  <div className="receive-address-picker-heading">
                    <div>
                      <b id="wallet-address-picker-title">Wallet addresses</b>
                      <small>Receive and change addresses, with balances.</small>
                    </div>
                    {receiveAddressScanLoading && <span className="receive-address-scan-state">Updating…</span>}
                  </div>
                  {receiveAddressScanError && (
                    <div className="classic-error" role="alert">
                      <span>{receiveAddressScanError}</span>
                      <button type="button" aria-label="Close error" onClick={() => setReceiveAddressScanError("")}>×</button>
                    </div>
                  )}
                  {!walletAddressChoices.length && !receiveAddressScanLoading && (
                    <p className="field-hint">Couldn't load your addresses. Reconnect and try again.</p>
                  )}
                  {walletAddressChoices.length > 0 && (
                    <>
                      <button type="button" className="receive-address-change"
                        onClick={() => setWalletAddressPickerExpanded((value) => !value)}>
                        {walletAddressPickerExpanded ? "Close address list" : "Change address"}
                      </button>
                      {walletAddressPickerExpanded && (
                        <>
                          <div className="receive-address-choice-list wallet-address-choice-list">
                            {visibleWalletAddressChoices.map((choice) => {
                              const total = BigInt(choice.confirmedSatoshis) + BigInt(choice.unconfirmedSatoshis);
                              const selected = displayWalletAddress?.toLowerCase() === choice.address.toLowerCase();
                              const activeReceive = choice.branch === "receive" && network === "mainnet" &&
                                walletView.receiveIndex === choice.index && walletClient.isReceiveAddressConfirmed("mainnet");
                              return (
                                <button type="button" key={choice.branch + ":" + choice.index}
                                  className={selected ? "receive-address-choice selected" : "receive-address-choice"}
                                  aria-pressed={selected}
                                  onClick={() => {
                                    try {
                                      if (choice.branch === "receive" && network === "mainnet") {
                                        const selectedReceive = walletClient?.selectReceiveAddressIndex(choice.index, "mainnet");
                                        if (!selectedReceive) throw new Error("Reconnect Selene first.");
                                      }
                                      setSelectedWalletAddress(choice.address);
                                      setWalletAddressRevealed(false);
                                      if (walletAddressSelectionKey) {
                                        window.localStorage.setItem(walletAddressSelectionKey, choice.address);
                                      }
                                      setWalletAddressPickerExpanded(false);
                                      setAddressMatchMessage("");
                                      setAddressMatchError("");
                                    } catch (cause) {
                                      setAddressMatchError(cause instanceof Error ? cause.message : "Couldn't change this address.");
                                    }
                                  }}>
                                  <span className="receive-address-choice-copy">
                                    <b>{shortAddress(choice.address)}</b>
                                    <small>{formatBchSatoshis(total)} · {choice.branch === "receive" ? "Receive" : "Change"}</small>
                                  </span>
                                  <span className="receive-address-choice-tags">
                                    {activeReceive && <small className="receive-address-selected">Active</small>}
                                    {selected && <small className="receive-address-selected">Selected</small>}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                          {!showAllWalletAddresses && sortedWalletAddressChoices.length > visibleWalletAddressChoices.length && (
                            <button type="button" className="text-action" onClick={() => setShowAllWalletAddresses(true)}>
                              Show all {sortedWalletAddressChoices.length} addresses
                            </button>
                          )}
                          {showAllWalletAddresses && (
                            <button type="button" className="text-action" onClick={() => setShowAllWalletAddresses(false)}>
                              Show addresses with coins
                            </button>
                          )}
                          <small className="field-hint">This changes the wallet view only.</small>
                        </>
                      )}
                    </>
                  )}
                  {network === "mainnet" && selectedAddressPendingOnly && (
                    <p className="receive-address-pending-warning" role="alert">Wait 1 confirmation, then create.</p>
                  )}
                  {network === "mainnet" && (
                    <small className="field-hint">
                      {walletClient?.isReceiveAddressConfirmed("mainnet") ? "Address confirmed ✓" : "Address not confirmed yet."}
                    </small>
                  )}
                </section>

                {network === "chipnet" && (
                  <details className="technical-details">
                    <summary>Details</summary>
                    <label className="field-label" htmlFor="selene-address">Pick the address shown in Selene.</label>
                    <input id="selene-address" className="form-control" value={seleneAddress}
                      onChange={(event) => setSeleneAddress(event.target.value)}
                      placeholder="Paste the address shown in Selene" autoComplete="off" />
                    <button className="primary-button" onClick={() => {
                      try {
                        const index = walletClient?.confirmReceiveAddress(seleneAddress, network, 250) ?? null;
                        if (index === null) {
                          setAddressMatchError("This address isn't in your wallet. Check Selene is on Mainnet and reconnect.");
                        } else {
                          setAddressMatchMessage("Address confirmed ✓");
                        }
                      } catch (cause) {
                        setAddressMatchError(cause instanceof Error ? cause.message : "Couldn't confirm this address.");
                      }
                    }}>Confirm address</button>
                  </details>
                )}
                {addressMatchMessage && <p className="wallet-match-message" role="status">{addressMatchMessage}</p>}
                {addressMatchError && (
                  <div className="classic-error" role="alert"><span>{addressMatchError}</span>
                    <button type="button" aria-label="Close error" onClick={() => setAddressMatchError("")}>×</button>
                  </div>
                )}

                <details className="wallet-tools-disclosure">
                  <summary>Advanced</summary>
                  {(network === "chipnet" || network === "mainnet") && walletAddress && (
                    <section className="gather-card" aria-labelledby="gather-title">
                      <div className="gather-card-heading">
                        <h3 id="gather-title">Combine BCH</h3>
                        <p>Combine your BCH into one coin. Tokens aren't touched.</p>
                      </div>
                      {!gatherPlan && (
                        <button className="secondary-button gather-scan-button"
                          disabled={gatherBusy || (network === "mainnet" && !walletClient?.isReceiveAddressConfirmed("mainnet"))}
                          onClick={() => void gatherWalletCoins()}>
                          {gatherBusy ? "Checking your coins…" : network === "mainnet" && !walletClient?.isReceiveAddressConfirmed("mainnet")
                            ? "Pick an address first." : "Find BCH in my wallet"}
                        </button>
                      )}
                      {gatherPlan && (
                        <div className="gather-review" aria-live="polite">
                          <div className="gather-review-row"><span>Total BCH found</span><strong>{formatBchSatoshis(gatherPlan.plan.totalSatoshis)}</strong></div>
                          <div className="gather-review-row gather-destination"><span>Goes to your wallet</span><code>{shortAddress(gatherPlan.plan.destination)}</code></div>
                          <div className="gather-review-row"><span>Network fee</span><strong>{formatBchSatoshis(gatherPlan.plan.fee)}</strong></div>
                          <div className="gather-review-row"><span>After the fee</span><strong>{formatBchSatoshis(gatherPlan.plan.outputSatoshis)}</strong></div>
                          <details className="technical-details">
                            <summary>Details</summary>
                            <p>{gatherPlan.plan.inputCount} BCH inputs. Nothing has been signed or sent yet.</p>
                          </details>
                          <button type="button" className="primary-button gather-confirm-button" disabled={gatherBusy} onClick={() => void gatherWalletCoins()}>
                            {gatherBusy ? "Waiting for Selene…" : "Combine into one coin"}
                          </button>
                          <button type="button" className="secondary-button gather-cancel-button" disabled={gatherBusy} onClick={() => { setGatherPlan(null); setGatherMessage(""); }}>
                            Cancel
                          </button>
                        </div>
                      )}
                      {gatherBusy && gatherMessage && <p className="wallet-match-message" role="status">{gatherMessage}</p>}
                      {gatherResult?.status === "success" && (
                        <div className="gather-result gather-success" role="status">
                          <b>Done. Confirms in a few minutes.</b>
                          <a href={gatherExplorerUrl(gatherResult.network, gatherResult.txid)} target="_blank" rel="noreferrer">View transaction <code>{shortTxid(gatherResult.txid)}</code></a>
                        </div>
                      )}
                      {gatherResult?.status === "error" && (
                        <div className="gather-result gather-error" role="alert">
                          <button type="button" aria-label="Close error" onClick={() => setGatherResult(null)}>×</button>
                          <b>Couldn't combine your BCH. Try again.</b>
                          <span>{gatherResult.message}</span>
                        </div>
                      )}
                    </section>
                  )}
                </details>

                <div className="wallet-modal-actions">
                  <button type="button" className="secondary-button" onClick={() => void walletClient?.disconnect()}>Disconnect</button>
                  <button type="button" className="primary-button" onClick={() => setShowWallet(false)}>Done</button>
                </div>
              </div>
            ) : (
              <div className="wallet-detail-body">
                {qrDataUrl && <img className="wallet-qr" src={qrDataUrl} alt="Selene connection QR code" />}
                {walletView.uri && <a className="primary-button wallet-open-link" href={walletView.uri}>Open in Selene <ArrowRight size={15} /></a>}
                {walletView.state === "connecting" && <p className="wallet-match-message">Approve in Selene, then come back.</p>}
                {walletView.state === "reconnecting" && <p className="wallet-match-message" role="status">Reconnecting…</p>}
                {walletView.state === "disconnected" && <p className="wallet-match-message" role="status">Disconnected.</p>}
                {walletView.error && <div className="classic-error" role="alert"><span>{walletView.error}</span>
                  <button type="button" aria-label="Close error" onClick={() => setWalletView((view) => ({ ...view, error: null }))}>×</button>
                </div>}
                <div className="wallet-modal-actions">
                  <button className="primary-button" onClick={() => {
                    if (!walletClient) { openWallet(); return; }
                    if (!walletClient.retrySavedSession()) {
                      if (walletClient.state === "idle") walletClient.connect();
                      else if (walletClient.state === "disconnected") walletClient.startFreshPairing();
                    }
                  }}>Reconnect</button>
                  <button className="secondary-button" onClick={() => setShowWallet(false)}>Close</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
      <footer className="app-footer"><span>© 2026 AjoChain</span><a href="https://github.com/Afar88/ajochain-blaze/blob/main/docs/MAINNET_PROOF.md" style={{ color: "var(--primary)", fontWeight: 800, textDecoration: "underline" }}>On-chain proof</a><span><span className="footer-dot" /> {network === "chipnet" ? "Chipnet testing" : "Mainnet · wallet-authorized transactions"}</span></footer>
    </main>
  );
}
