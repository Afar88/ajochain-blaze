import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Activity, ArrowRight, Check, ChevronDown, Copy, Home,
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

export function getWalletBchBalanceSummary(input: {
  network: NetworkId;
  connected: boolean;
  receiveAddressChoices: readonly ReceiveAddressChoice[];
  currentBchBalanceScan: BchBalanceScan | null;
  receiveAddressScanLoading: boolean;
}): { balanceLabel: string; detailLabel: string; sourceLabel: string } {
  const {
    network, connected, receiveAddressChoices, currentBchBalanceScan,
    receiveAddressScanLoading,
  } = input;

  if (!connected) {
    return {
      balanceLabel: "Connect wallet",
      detailLabel: "BCH coins found in your connected wallet",
      sourceLabel: "Wallet not connected",
    };
  }

  if (receiveAddressChoices.length > 0) {
    const totalSatoshis = receiveAddressChoices.reduce((total, choice) => {
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
      sourceLabel: "All receive and change addresses",
    };
  }

  if (currentBchBalanceScan) {
    return {
      balanceLabel: formatBchSatoshis(currentBchBalanceScan.totalSatoshis),
      detailLabel: "BCH coins found in your connected wallet",
      sourceLabel: "Existing wallet coin scan",
    };
  }

  if (network === "mainnet" && receiveAddressScanLoading) {
    return {
      balanceLabel: "Checking…",
      detailLabel: "Across your wallet addresses",
      sourceLabel: "Receive-address activity scan in progress",
    };
  }

  return {
    balanceLabel: "Not checked yet",
    detailLabel: "BCH coins found in your connected wallet",
    sourceLabel: "No wallet scan in this session",
  };
}

export type WalletDiscoveryCache = { updatedAt: number; circles: string[] };

export function getWalletDiscoveryCacheKey(firstReceiveAddress: string, network: NetworkId): string {
  return "ajochain:discovery-cache:v1:" + network + ":" + firstReceiveAddress.trim().toLowerCase();
}
export function readWalletDiscoveryCache(
  storage: Pick<Storage, "getItem">, firstReceiveAddress: string, network: NetworkId,
): WalletDiscoveryCache | null {
  if (!firstReceiveAddress.trim()) return null;
  try {
    const raw: unknown = JSON.parse(storage.getItem(getWalletDiscoveryCacheKey(firstReceiveAddress, network)) || "null");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(item.updatedAt) || !Array.isArray(item.circles) ||
        !item.circles.every((circle) => typeof circle === "string")) return null;
    return { updatedAt: item.updatedAt as number, circles: item.circles as string[] };
  } catch { return null; }
}
export function writeWalletDiscoveryCache(
  storage: Pick<Storage, "setItem">, firstReceiveAddress: string, network: NetworkId,
  circles: readonly string[], updatedAt = Date.now(),
): void {
  if (!firstReceiveAddress.trim()) return;
  storage.setItem(getWalletDiscoveryCacheKey(firstReceiveAddress, network), JSON.stringify({
    updatedAt, circles: [...new Set(circles)],
  }));
}
export function shouldScanWalletDiscovery(cache: WalletDiscoveryCache | null, manual: boolean, now = Date.now()): boolean {
  return manual || !cache || now - cache.updatedAt > 30 * 60 * 1000;
}
export function getWalletAddressChoiceKey(choice: Pick<ReceiveAddressChoice, "branch" | "index">): string {
  return choice.branch + ":" + choice.index;
}
export function getDefaultReceiveAddressIndex(choices: readonly ReceiveAddressChoice[]): number | null {
  const funded = choices.filter((choice) => choice.branch === "receive").map((choice) => {
    let total = 0n;
    try { total = BigInt(choice.confirmedSatoshis) + BigInt(choice.unconfirmedSatoshis); } catch { /* invalid value */ }
    return { index: choice.index, total };
  }).sort((left, right) => left.total === right.total
    ? left.index - right.index : left.total > right.total ? -1 : 1);
  return funded[0]?.index ?? null;
}
export function formatUpdatedAgo(updatedAt: number | null, now = Date.now()): string {
  if (updatedAt === null) return "Not updated yet";
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return seconds + "s ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  return Math.floor(minutes / 60) + "h ago";
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
  const [receiveAddressChoices, setReceiveAddressChoices] = useState<ReceiveAddressChoice[]>([]);
  const [receiveAddressPickerExpanded, setReceiveAddressPickerExpanded] = useState(true);
  const [receiveAddressScanLoading, setReceiveAddressScanLoading] = useState(false);
  const [receiveAddressScanError, setReceiveAddressScanError] = useState("");
  const [walletShowAllAddresses, setWalletShowAllAddresses] = useState(false);
  const [walletDisplayAddressKey, setWalletDisplayAddressKey] = useState<string | null>(null);
  const [walletFullAddressOpen, setWalletFullAddressOpen] = useState(false);
  const [walletAddressQrOpen, setWalletAddressQrOpen] = useState(false);
  const [addressQrDataUrl, setAddressQrDataUrl] = useState("");
  const [walletBalanceRefreshRun, setWalletBalanceRefreshRun] = useState(0);
  const [lastWalletBalanceUpdatedAt, setLastWalletBalanceUpdatedAt] = useState<number | null>(null);
  const [walletBalancesRefreshing, setWalletBalancesRefreshing] = useState(false);
  const [walletNow, setWalletNow] = useState(Date.now());
  const walletBalanceRefreshBusyRef = useRef(false);
  const discoveryRunHandledRef = useRef(0);
  const [walletErrorDismissed, setWalletErrorDismissed] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [seleneAddress, setSeleneAddress] = useState("");
  const [addressMatchMessage, setAddressMatchMessage] = useState("");

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
    choices: receiveAddressChoices,
  });
  discoveryPriorityAddressesRef.current = {
    receiveIndex: walletView.receiveIndex,
    choices: receiveAddressChoices,
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
  const sortedWalletAddressChoices = [...receiveAddressChoices].sort((left, right) => {
    const leftTotal = BigInt(left.confirmedSatoshis) + BigInt(left.unconfirmedSatoshis);
    const rightTotal = BigInt(right.confirmedSatoshis) + BigInt(right.unconfirmedSatoshis);
    if ((leftTotal > 0n) !== (rightTotal > 0n)) return leftTotal > 0n ? -1 : 1;
    if (leftTotal !== rightTotal) return leftTotal > rightTotal ? -1 : 1;
    if (left.branch !== right.branch) return left.branch === "receive" ? -1 : 1;
    return left.index - right.index;
  });
  const selectedWalletAddressChoice = sortedWalletAddressChoices.find((choice) =>
    getWalletAddressChoiceKey(choice) === walletDisplayAddressKey,
  ) ?? sortedWalletAddressChoices[0] ?? null;
  const walletDisplayAddress = selectedWalletAddressChoice?.address ?? walletAddress;
  const visibleWalletAddressChoices = walletShowAllAddresses
    ? sortedWalletAddressChoices
    : sortedWalletAddressChoices.filter((choice) =>
        BigInt(choice.confirmedSatoshis) + BigInt(choice.unconfirmedSatoshis) > 0n ||
        getWalletAddressChoiceKey(choice) === walletDisplayAddressKey,
      );

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

  // Success and progress messages fade quickly. Errors remain until dismissed.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setGatherMessage("");
      setAddressMatchMessage("");
      setPusdSignatureMessage("");
      setMainnetInviteNotice("");
    }, 4_000);
    return () => window.clearTimeout(timer);
  }, [gatherMessage, addressMatchMessage, pusdSignatureMessage, mainnetInviteNotice]);

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
    setWalletErrorDismissed(false);
    if (walletView.state !== "connected") setAddressMatchMessage("");
  }, [walletView.state, walletView.error]);

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
    const walletSurfaceOpen = showWallet || page === "assets";
    if (!walletSurfaceOpen || !walletClient || walletClient.state !== "connected" || walletView.state !== "connected") return;

    let active = true;
    const client = walletClient;
    const identity = client.getSessionIdentity();
    const revision = client.addressSetRevision;
    const refreshBalances = async () => {
      if (document.visibilityState !== "visible" || walletBalanceRefreshBusyRef.current) return;
      walletBalanceRefreshBusyRef.current = true;
      setWalletBalancesRefreshing(true);
      setReceiveAddressScanLoading(true);
      setReceiveAddressScanError("");
      try {
        const [{ getClassicProvider }, { fetchPusdWalletBalance }] = await Promise.all([
          import("./core/classic-bch"), import("./core/pusd-api"),
        ]);
        const entries = client.listWalletAddresses(network, 49, 20);
        if (!entries.length) throw new Error("Couldn't load your addresses. Reconnect and try again.");
        const provider = await getClassicProvider(network);
        const activityProvider = provider as typeof provider & {
          getAddressActivityForAddresses?: (addresses: readonly string[]) => Promise<Array<{
            address: string; hasHistory: boolean; hasPendingHistory: boolean;
            confirmedSatoshis: bigint; unconfirmedSatoshis: bigint;
          }>>;
        };
        if (typeof activityProvider.getAddressActivityForAddresses !== "function") {
          throw new Error("Wallet balances could not be checked right now.");
        }
        const scanned = await activityProvider.getAddressActivityForAddresses(entries.map((entry) => entry.address));
        if (!active || client.state !== "connected" || client.getSessionIdentity() !== identity ||
            client.addressSetRevision !== revision) return;
        const byAddress = new Map(scanned.map((entry) => [entry.address.toLowerCase(), entry]));
        const choices: ReceiveAddressChoice[] = entries.map((entry) => {
          const result = byAddress.get(entry.address.toLowerCase());
          if (!result) throw new Error("A wallet address could not be checked. Try refreshing again.");
          const confirmed = result.confirmedSatoshis > 0n;
          const pending = result.unconfirmedSatoshis > 0n || result.hasPendingHistory;
          return {
            branch: entry.branch, index: entry.index, address: entry.address,
            confirmedSatoshis: result.confirmedSatoshis.toString(),
            unconfirmedSatoshis: result.unconfirmedSatoshis.toString(),
            hasHistory: result.hasHistory, hasPendingHistory: result.hasPendingHistory,
            status: confirmed || (result.hasHistory && !pending) ? "confirmed" : pending ? "pending" : "unused",
            newest: false,
          };
        });
        setReceiveAddressChoices(choices);

        const mainnetFirstReceive = entries.find((entry) => entry.branch === "receive" && entry.index === 0);
        const networkFirstReceive = entries.find((entry) => entry.branch === "receive" && entry.index === 0);
        if (networkFirstReceive) {
          const receiveSelectionStorageKey = "ajochain:wallet-receive-selection:v1:" + network + ":" + networkFirstReceive.address.toLowerCase();
          const savedIndex = Number(window.localStorage.getItem(receiveSelectionStorageKey));
          const savedExists = Number.isSafeInteger(savedIndex) &&
            choices.some((choice) => choice.branch === "receive" && choice.index === savedIndex);
          if (!client.isReceiveAddressConfirmed(network)) {
            client.selectReceiveAddressIndex(savedExists ? savedIndex : getDefaultReceiveAddressIndex(choices) ?? 0, network);
          }
          const displayStorageKey = "ajochain:wallet-address-display:v1:" + network + ":" + networkFirstReceive.address.toLowerCase();
          const savedDisplayKey = window.localStorage.getItem(displayStorageKey);
          const savedDisplayExists = savedDisplayKey !== null &&
            choices.some((choice) => getWalletAddressChoiceKey(choice) === savedDisplayKey);
          const defaultDisplay = [...choices].sort((left, right) => {
            const l = BigInt(left.confirmedSatoshis) + BigInt(left.unconfirmedSatoshis);
            const r = BigInt(right.confirmedSatoshis) + BigInt(right.unconfirmedSatoshis);
            return l === r ? 0 : l > r ? -1 : 1;
          })[0];
          setWalletDisplayAddressKey(savedDisplayExists ? savedDisplayKey :
            defaultDisplay ? getWalletAddressChoiceKey(defaultDisplay) : getWalletAddressChoiceKey({ branch: "receive", index: client.receiveIndex }));
        }
        const totalSatoshis = choices.reduce((total, choice) =>
          total + BigInt(choice.confirmedSatoshis) + BigInt(choice.unconfirmedSatoshis), 0n);
        const activeReceiveAddress = client.address(network) ?? networkFirstReceive?.address ?? entries[0].address;
        setBchBalanceScan({ address: activeReceiveAddress, network, totalSatoshis });

        if (network === "mainnet") {
          const snapshots: Awaited<ReturnType<typeof fetchPusdWalletBalance>>[] = [];
          for (let offset = 0; offset < entries.length; offset += 6) {
            const batch = entries.slice(offset, offset + 6);
            snapshots.push(...await Promise.all(batch.map((entry) => fetchPusdWalletBalance(entry.address))));
            if (!active || client.state !== "connected" || client.getSessionIdentity() !== identity ||
                client.addressSetRevision !== revision) return;
          }
          const utxoMap = new Map<string, AuthenticatedPusdUtxo>();
          const rawPreviousTransactions: Record<string, string> = {};
          for (const snapshot of snapshots) {
            for (const utxo of snapshot.utxos) utxoMap.set(utxo.txid + ":" + utxo.vout, utxo);
            Object.assign(rawPreviousTransactions, snapshot.rawPreviousTransactions);
          }
          const utxos = [...utxoMap.values()];
          const amount = utxos.reduce((sum, utxo) => sum + (utxo.token?.amount ?? 0n), 0n);
          setPusdView({
            status: "ready", amount, detail: "Checked across all wallet addresses.",
            utxoCount: utxos.length,
            providerConfidence: snapshots.length ? Math.min(...snapshots.map((snapshot) => snapshot.providerConfidence)) : 0,
            tipHeight: snapshots.length ? Math.min(...snapshots.map((snapshot) => snapshot.tipHeight)) : 0,
            utxos, rawPreviousTransactions,
          });
        } else {
          setPusdView((current) => ({ ...current, status: "idle", detail: "PUSD is available on Mainnet." }));
        }
        setLastWalletBalanceUpdatedAt(Date.now());
      } catch (cause) {
        if (active) {
          const message = cause instanceof Error ? cause.message : "Wallet balances could not be refreshed.";
          setReceiveAddressScanError(message);
          if (network === "mainnet") setPusdView((current) => ({
            ...current,
            status: current.amount > 0n ? "ready" : "error",
            detail: current.amount > 0n ? "Couldn't refresh PUSD. Showing your last balance." : message,
          }));
        }
      } finally {
        setReceiveAddressScanLoading(false);
        setWalletBalancesRefreshing(false);
        walletBalanceRefreshBusyRef.current = false;
      }
    };
    void refreshBalances();
    const handleVisible = () => {
      if (document.visibilityState === "visible") {
        setWalletNow(Date.now());
        void refreshBalances();
      }
    };
    const handleManualRefresh = () => { void refreshBalances(); };
    const interval = window.setInterval(() => {
      setWalletNow(Date.now());
      void refreshBalances();
    }, 60_000);
    document.addEventListener("visibilitychange", handleVisible);
    window.addEventListener("ajochain:wallet-balances-refresh", handleManualRefresh);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisible);
      window.removeEventListener("ajochain:wallet-balances-refresh", handleManualRefresh);
    };
  }, [showWallet, page, network, walletClient, walletView.state, walletView.addressSetRevision, walletBalanceRefreshRun]);

  useEffect(() => {
    let active = true;
    if (!showWallet || !connected || !walletDisplayAddress) {
      setAddressQrDataUrl("");
      return () => { active = false; };
    }
    void import("qrcode")
      .then(({ default: QRCode }) => QRCode.toDataURL(walletDisplayAddress, {
        errorCorrectionLevel: "M", margin: 1, width: 220,
      }))
      .then((url) => { if (active) setAddressQrDataUrl(url); })
      .catch(() => { if (active) setAddressQrDataUrl(""); });
    return () => { active = false; };
  }, [showWallet, connected, walletDisplayAddress]);

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
    if (!walletClient || walletClient.state !== "connected" || !connected) {
      setPusdSignatureMessage("Connect Selene through WizardConnect before testing the PUSD signature path.");
      return;
    }
    if (network !== "mainnet" || pusdView.status !== "ready") {
      setPusdSignatureMessage("A verified Mainnet PUSD balance is required before signature verification.");
      return;
    }
    if (!walletClient.isReceiveAddressConfirmed("mainnet")) {
      setPusdSignatureMessage("Choose a Mainnet receive address in Wallet Details before testing the PUSD signature.");
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
    // Discovery is read-only and uses the connected wallet's own addresses on each BCH network.
    // This trigger is scoped to the wallet session and address set, not address-picker activity.
    const manualDiscovery = discoveryRun > discoveryRunHandledRef.current;
    if (manualDiscovery) discoveryRunHandledRef.current = discoveryRun;
    if (!showWallet && !manualDiscovery) return;
    let firstReceiveAddress = "";
    let chipnetFirstReceiveAddress = "";
    try {
      firstReceiveAddress = walletClient.listWalletAddresses("mainnet", 0, 0)
        .find((entry) => entry.branch === "receive" && entry.index === 0)?.address ?? "";
      chipnetFirstReceiveAddress = walletClient.listWalletAddresses("chipnet", 0, 0)
        .find((entry) => entry.branch === "receive" && entry.index === 0)?.address ?? "";
    } catch { /* The connected wallet check below handles unavailable address paths. */ }
    const chipnetCache = chipnetFirstReceiveAddress
      ? readWalletDiscoveryCache(window.localStorage, chipnetFirstReceiveAddress, "chipnet") : null;
    const mainnetCache = firstReceiveAddress
      ? readWalletDiscoveryCache(window.localStorage, firstReceiveAddress, "mainnet") : null;
    const scanChipnet = shouldScanWalletDiscovery(chipnetCache, manualDiscovery);
    const scanMainnet = shouldScanWalletDiscovery(mainnetCache, manualDiscovery);
    const restoreCachedCircles = () => {
      if (chipnetCache?.circles.length) {
        try {
          const stored: unknown = JSON.parse(window.localStorage.getItem(V2_MENU_STORAGE_KEY) || "[]");
          const entries = Array.isArray(stored) ? stored.filter((item) =>
            item && typeof item === "object" && typeof (item as Record<string, unknown>).encoded === "string",
          ) as Array<{ encoded: string; savedAt?: number }> : [];
          const byEncoded = new Map(entries.map((entry) => [entry.encoded, entry]));
          for (const encoded of chipnetCache.circles) byEncoded.set(encoded, { encoded, savedAt: 0 });
          window.localStorage.setItem(V2_MENU_STORAGE_KEY, JSON.stringify([...byEncoded.values()]));
        } catch { /* keep the cache usable if storage is unavailable */ }
      }
      if (mainnetCache?.circles.length) {
        try {
          const stored: unknown = JSON.parse(window.localStorage.getItem(BCH_MAINNET_CIRCLES_STORAGE_KEY) || "[]");
          const entries = Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : [];
          window.localStorage.setItem(BCH_MAINNET_CIRCLES_STORAGE_KEY,
            JSON.stringify([...new Set([...entries, ...mainnetCache.circles])]));
        } catch { /* keep the cache usable if storage is unavailable */ }
      }
      setMenuCircles(readSavedCircleMenuRecords());
    };
    restoreCachedCircles();
    if (!scanChipnet && !scanMainnet) {
      setDiscoveryMessage("");
      return;
    }
    const sessionKey = getDiscoverySessionKey(
      walletSessionIdentity,
      walletView.state,
      walletView.addressSetRevision,
    );
    const previousRun = activeDiscoveryRunRef.current;
    if (previousRun && previousRun.sessionKey === sessionKey) {
      // Repeated trigger for the same session: leave the in-flight scan alone.
      return;
    }
    if (previousRun && previousRun.sessionKey !== sessionKey) {
      previousRun.cancel();
      activeDiscoveryRunRef.current = null;
      discoveryBusyRef.current = false;
      setDiscoveryBusy(false);
    }

    if (!walletClient || walletView.state !== "connected" || walletClient.state !== "connected") {
      return;
    }
    if (discoveryMessageTimerRef.current !== null) {
      window.clearTimeout(discoveryMessageTimerRef.current);
      discoveryMessageTimerRef.current = null;
    }

    // Snapshot selected and active receive addresses exactly once at scan start.
    // Changes to receiveAddressChoices/receiveIndex do not restart this run.
    const prioritySnapshot = discoveryPriorityAddressesRef.current;
    let chipnetTimedOut = false;
    let mainnetTimedOut = false;
    let chipnetStatus = scanChipnet ? "Chipnet: checking…" : "Chipnet: saved circles loaded.";
    let mainnetStatus = scanMainnet ? "Mainnet: checking…" : "Mainnet: saved circles loaded.";
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

    if (discoveryBusyRef.current) {
      // Ignore a duplicate trigger while this wallet session is already scanning.
      return;
    }
    discoveryBusyRef.current = true;
    activeDiscoveryRunRef.current = run;
    setDiscoveryBusy(true);
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
            if (!scanChipnet) return { foundCount: chipnetCache?.circles.length ?? 0 };
            const provider = await getClassicProvider("chipnet");
            const addresses = walletClient.listWalletAddresses("chipnet").map((entry) => entry.address);
            if (addresses.length === 0) throw new Error("No Chipnet receive/change addresses are available from this wallet.");
            const found = await discoverV2FeeCircles(provider, addresses, undefined, "chipnet", {
              requestTimeoutMs: 10_000,
              overallTimeoutMs: 45_000,
              onTimeout: () => { chipnetTimedOut = true; },
            });
            if (run.cancelled) return { foundCount: 0 };

            const stored: unknown = JSON.parse(window.localStorage.getItem(V2_MENU_STORAGE_KEY) || "[]");
            const existing = dedupeSavedV2FeeCircleRecords(stored);
            const knownCategories = new Set(existing.flatMap((record) => {
              const identity = getV2FeeCircleRecordIdentity(record.encoded);
              return identity ? [identity.stateCategory.toLowerCase()] : [];
            }));
            const encodedFound = found.map(encodeV2FeeCircleParams);
            if (chipnetFirstReceiveAddress) writeWalletDiscoveryCache(
              window.localStorage, chipnetFirstReceiveAddress, "chipnet", encodedFound,
            );
            const additions = found
              .filter((params) => !knownCategories.has(params.stateCategory.toLowerCase()))
              .map((params) => ({ encoded: encodeV2FeeCircleParams(params), savedAt: 0 }));
            if (additions.length > 0) {
              window.localStorage.setItem(V2_MENU_STORAGE_KEY, JSON.stringify([...existing, ...additions]));
            }
            if (!run.cancelled) setMenuCircles(readSavedCircleMenuRecords());
            return { foundCount: found.length };
          },
          async () => {
            if (!scanMainnet) return { foundCount: mainnetCache?.circles.length ?? 0 };
            const mainnetEntries = walletClient.listWalletAddresses("mainnet");
            if (mainnetEntries.length === 0) throw new Error("No Mainnet receive/change addresses are available from this wallet.");
            // Prioritize Selene's selected address, then active addresses from the
            // captured activity snapshot. Other receive/change addresses remain eligible.
            const selectedAddress = mainnetEntries.find((entry) =>
              entry.branch === "receive" && entry.index === prioritySnapshot.receiveIndex,
            )?.address;
            const knownActiveAddresses = prioritySnapshot.choices
              .filter((choice) => choice.hasHistory || choice.hasPendingHistory ||
                BigInt(choice.confirmedSatoshis) > 0n || BigInt(choice.unconfirmedSatoshis) > 0n)
              .sort((left, right) => {
                const leftTotal = BigInt(left.confirmedSatoshis) + BigInt(left.unconfirmedSatoshis);
                const rightTotal = BigInt(right.confirmedSatoshis) + BigInt(right.unconfirmedSatoshis);
                return leftTotal === rightTotal ? left.index - right.index : leftTotal > rightTotal ? -1 : 1;
              })
              .map((choice) => choice.address);
            const priorityAddresses = [
              ...(selectedAddress ? [selectedAddress] : []),
              ...knownActiveAddresses,
            ];
            // Mainnet discovery stays on the independently verified, read-only
            // quorum. No provider or transaction flow is changed here.
            const provider = await getClassicProvider("mainnet");
            const mainnetFound = await discoverV2FeeCircles(
              provider,
              mainnetEntries.map((entry) => entry.address),
              undefined,
              "mainnet",
              {
                priorityAddresses,
                requestTimeoutMs: 10_000,
                overallTimeoutMs: 45_000,
                onTimeout: () => { mainnetTimedOut = true; },
              },
            );
            if (run.cancelled) return { foundCount: 0 };

            writeWalletDiscoveryCache(window.localStorage, firstReceiveAddress, "mainnet",
              mainnetFound.map(encodeV2FeeCircleParams));
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
            // My circles is rendered from this exact Mainnet storage collection.
            if (!run.cancelled) setMenuCircles(readSavedCircleMenuRecords());
            return { foundCount: mainnetFound.length };
          },
          (result) => {
            if (run.cancelled) return;
            chipnetStatus = getDiscoveryNetworkStatus("Chipnet", result, chipnetTimedOut);
            publishStatus();
          },
          (result) => {
            if (run.cancelled) return;
            mainnetStatus = getDiscoveryNetworkStatus("Mainnet", result, mainnetTimedOut);
            publishStatus();
          },
        );
      } catch {
        if (!run.cancelled) {
          chipnetStatus = "Chipnet: unavailable, tap Retry to check again.";
          mainnetStatus = "Mainnet: unavailable, tap Retry to check again.";
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
        setGatherResult({ status: "error", message: "The connected Selene receive address is not available for this network." });
        return;
      }
      if (gatherNetwork === "mainnet" && !walletClient.isReceiveAddressConfirmed("mainnet")) {
        setGatherResult({ status: "error", message: "Choose a Mainnet receive address in Wallet Details before gathering real BCH." });
        return;
      }
      const gatherWalletIdentity = gatherNetwork === "mainnet" ? walletClient.getSessionIdentity() : null;
      if (gatherNetwork === "mainnet" && !gatherWalletIdentity) {
        setGatherResult({ status: "error", message: "WizardConnect has not supplied a verifiable Selene wallet identity. Reconnect Selene before gathering Mainnet BCH." });
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
        // Wallet balance remains the total across every receive and change address.
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
    value ? value.slice(0, 10) + "…" + value.slice(-6) : "Address unavailable…";
  const currentBchBalanceScan = bchBalanceScan && walletAddress &&
    bchBalanceScan.network === network &&
    bchBalanceScan.address.toLowerCase() === walletAddress.toLowerCase()
    ? bchBalanceScan
    : null;
  const walletBchBalanceSummary = getWalletBchBalanceSummary({
    network,
    connected,
    receiveAddressChoices,
    currentBchBalanceScan,
    receiveAddressScanLoading,
  });
  const selectedReceiveAddressChoice = receiveAddressChoices.find((choice) => choice.index === walletView.receiveIndex) ?? null;
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
            {connected && walletAddress ? shortAddress(walletAddress) : walletStateLabel}
          </button>
          {connected && walletAddress && (
            <button className="header-wallet-copy" type="button" aria-label="Copy wallet address"
              onClick={() => { void navigator.clipboard.writeText(walletAddress).catch(() => undefined); }}>
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
                <span><b>{connected ? walletView.walletName ?? "Wallet connected" : "Connect wallet"}</b><small>{connected ? shortAddress(walletAddress) : walletView.state === "reconnecting" ? "Restoring Selene session…" : "Connect Selene"}</small></span>
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
            <section className="welcome-hero">
              <div className="welcome-kicker"><span /> AJO · ESUSU · ON BITCOIN CASH</div>
              <h1>Your Ajo savings circle, on Bitcoin Cash.</h1>
              <p>Save together. Every member gets their turn.</p>
              <div className="hero-actions">
                <button className="primary-button hero-cta" type="button" onClick={() => navigate("create-circle")}>
                  Create a circle <ArrowRight size={16} />
                </button>
                <button className="secondary-button hero-secondary-cta" type="button" onClick={() => navigate("my-circles")}>My circles</button>
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
              <span className="section-kicker">YOUR WALLET</span>
              <h1>Wallet</h1>
              <p>Balances held in the wallet connected to Selene.</p>
            </div>
            <article className="asset-detail-card wallet-balance-card">
              <div className="wallet-balance-heading">
                <div>
                  <span className="section-kicker">CONNECTED WALLET</span>
                  <h2>{connected ? walletView.walletName ?? "Selene wallet" : "No wallet connected"}</h2>
                  <small>{connected ? shortAddress(walletAddress) : "Connect Selene to view your balances."}</small>
                </div>
              </div>
              <div className="wallet-balance-list">
                <div className="wallet-balance-row">
                  <span className="asset-symbol">B</span>
                  <div><b>Bitcoin Cash</b><small>{walletBchBalanceSummary.detailLabel}</small></div>
                  <strong>{walletBchBalanceSummary.balanceLabel}</strong>
                </div>
                <div className="wallet-balance-row">
                  <span className="asset-symbol pusd-symbol">P</span>
                  <div><b>ParyonUSD</b><small>Dollar balance on Mainnet</small></div>
                  <strong>{!connected ? "Connect wallet" : network !== "mainnet" ? "Switch to Mainnet" : pusdView.amount > 0n ? formatAssetAmount("PUSD", pusdView.amount) + " PUSD" : pusdView.status === "ready" ? "0.00 PUSD" : "Not checked yet"}</strong>
                </div>
              </div>
              <div className="wallet-live-refresh"><small>Updated {formatUpdatedAgo(lastWalletBalanceUpdatedAt, walletNow)}</small>
                <button type="button" className="secondary-button" onClick={() => setWalletBalanceRefreshRun((value) => value + 1)} disabled={walletBalancesRefreshing}>
                  <RefreshCw size={15} className={walletBalancesRefreshing ? "activity-spin" : ""} />
                  {walletBalancesRefreshing ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              <div className="wallet-balance-actions">
                <button type="button" className="secondary-button" onClick={openWallet}>
                  {connected ? "Open wallet details" : "Connect wallet"}
                </button>
                <button type="button" className="secondary-button" onClick={() => {
                  if (!connected) { openWallet(); return; }
                  if (network !== "mainnet") { changeNetwork("mainnet"); return; }
                  setWalletBalanceRefreshRun((value) => value + 1);
                }} disabled={walletBalancesRefreshing}>
                  {walletBalancesRefreshing ? "Refreshing…" : network !== "mainnet" ? "Switch to Mainnet for PUSD" : "Refresh balances"}
                </button>
              </div>
            </article>
            <section className="asset-detail-card wallet-assets-block" aria-labelledby="wallet-assets-title">
              <div>
                <span className="section-kicker">SAVE YOUR WAY</span>
                <h2 id="wallet-assets-title">Bitcoin Cash or digital dollars</h2>
                <p>Your circle, your currency. Fees are always shown before you sign.</p>
              </div>
              <div className="asset-preview-rows">
                <div><span className="asset-symbol">B</span><span><b>Bitcoin Cash</b><small>Fast, low-fee savings. Practise free on Chipnet, then save for real on Mainnet.</small></span><span className="asset-state">Live</span></div>
                <div><span className="asset-symbol pusd-symbol">P</span><span><b>ParyonUSD (PUSD)</b><small>Save in steady dollars, no bank needed. Balances checked straight on the blockchain.</small></span><span className="asset-state neutral">Mainnet</span></div>
              </div>
            </section>
            <p className="wallet-balance-explainer">Your wallet balances include receive and change addresses.</p>
            <details className="technical-details wallet-technical-details">
              <summary>Technical details</summary>
              <div className="asset-detail-row"><span>Selected network</span><b>{NETWORKS[network].label}</b></div>
              <div className="asset-detail-row"><span>Wallet address</span><b>{selectedWalletAddressChoice?.branch === "change" ? "Change" : "Receive"}</b></div>
              <div className="asset-detail-row"><span>BCH balance</span><b>{walletBchBalanceSummary.sourceLabel}</b></div>
              <div className="asset-detail-row"><span>PUSD balance</span><b>{pusdView.status === "ready" ? "Updated" : pusdView.status === "error" ? "Last balance shown" : "Not checked"}</b></div>
              <div className="asset-detail-row"><span>PUSD transfer</span><b>{PUSD_MAINNET_SPENDING_ENABLED ? "Available after wallet checks" : "Locked pending release approval"}</b></div>
              <div className="asset-detail-row"><span>PUSD asset identifier</span><code>{PUSD_ASSET.categoryId}</code></div>
              <div className="asset-detail-row"><span>PUSD display precision</span><b>{PUSD_ASSET.decimals} decimals</b></div>
            </details>
            <details className="wallet-tools-disclosure wallet-advanced-tools">
              <summary>Advanced · PUSD transfer</summary>
              <div className="pusd-transfer-box">
                <div><span className="section-kicker">TRANSFER PREVIEW</span><h3>Prepare a PUSD transfer</h3>
                  <p>Review a transfer using the PUSD coins in your wallet and the latest network fee estimate. Nothing is sent from this preview.</p></div>
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
                  {pusdSignatureBusy ? "Test signing…" : "Test sign · no money sent"}
                </button>
                {pusdSignatureMessage && <p className="classic-notice" role="status">{pusdSignatureMessage}</p>}
                <button type="button" className="primary-button" disabled={!PUSD_MAINNET_SPENDING_ENABLED || !pusdTransferPlan}
                  title="PUSD Mainnet spending is not yet approved by the security release gate">
                  Send PUSD · Mainnet locked
                </button>
                <small className="field-hint">PUSD sending stays locked until raw transaction inspection, independent wallet testing, fee/carrier validation, and security review are completed. This preview is not a payment.</small>
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

      {walletView.error && !walletErrorDismissed && <div className="global-wallet-error" role="alert"><ShieldCheck size={17} /><span>{walletView.error}</span><button type="button" aria-label="Dismiss error" onClick={() => setWalletErrorDismissed(true)}><X size={16} /></button><div className="global-wallet-error-actions">
        <button onClick={() => {
          if (!walletClient) return;
          if (walletClient.retrySavedSession()) return;
          if (walletClient.state === "disconnected") walletClient.startFreshPairing();
          else if (walletClient.state === "idle") walletClient.connect();
        }}>Reconnect</button>
        <button onClick={() => walletClient?.startFreshPairing()}>Fresh pairing</button>
      </div></div>}

      {showWallet && (
        <div className="modal-backdrop wallet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowWallet(false); }}>
          <section className="create-modal wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-title">
            <div className="modal-heading">
              <div><h2 id="wallet-title">Wallet</h2>{!connected && <p>Connect Selene. Your keys never leave your phone.</p>}</div>
              <button className="modal-close" onClick={() => setShowWallet(false)} aria-label="Close"><X size={19} /></button>
            </div>
            {connected ? (
              <div className="wallet-detail-body">
                <section className="wallet-live-balances" aria-label="Wallet balances">
                  <div className="wallet-live-bch"><span className="section-kicker">BITCOIN CASH</span><strong>{walletBchBalanceSummary.balanceLabel}</strong><small>{walletBchBalanceSummary.detailLabel}</small></div>
                  <div className="wallet-live-pusd"><span className="section-kicker">PARYONUSD</span><strong>{network !== "mainnet" ? "Mainnet only" : pusdView.amount > 0n ? formatAssetAmount("PUSD", pusdView.amount) + " PUSD" : pusdView.status === "ready" ? "0.00 PUSD" : "Not checked yet"}</strong><small>{network !== "mainnet" ? "Switch to Mainnet to check PUSD." : pusdView.status === "error" ? pusdView.detail : "Across all wallet addresses"}</small></div>
                  <div className="wallet-live-refresh"><small>Updated {formatUpdatedAgo(lastWalletBalanceUpdatedAt, walletNow)}</small><button type="button" className="secondary-button" onClick={() => setWalletBalanceRefreshRun((value) => value + 1)} disabled={walletBalancesRefreshing}><RefreshCw size={15} className={walletBalancesRefreshing ? "activity-spin" : ""} />{walletBalancesRefreshing ? "Refreshing…" : "Refresh"}</button></div>
                </section>
                <div className="wallet-address-card">
                  <span>{selectedWalletAddressChoice?.branch === "change" ? "Change address" : "Receive address"} · {NETWORKS[network].label}</span>
                  <code>{walletDisplayAddress ? shortAddress(walletDisplayAddress) : "Address unavailable"}</code>
                  <div className="wallet-address-actions">
                    {walletDisplayAddress && <button type="button" className="secondary-button wallet-copy-address" onClick={() => { void navigator.clipboard.writeText(walletDisplayAddress).catch(() => undefined); }}><Copy size={14} /> Copy address</button>}
                    {walletDisplayAddress && <button type="button" className="secondary-button" onClick={() => setWalletAddressQrOpen((value) => !value)}>{walletAddressQrOpen ? "Hide QR" : "Show QR"}</button>}
                    <button type="button" className="secondary-button" onClick={() => setWalletFullAddressOpen((value) => !value)}>{walletFullAddressOpen ? "Hide full address" : "Show full address"}</button>
                  </div>
                  {walletFullAddressOpen && walletDisplayAddress && <code className="wallet-full-address">{walletDisplayAddress}</code>}
                  {walletAddressQrOpen && addressQrDataUrl && <img className="wallet-qr wallet-address-qr" src={addressQrDataUrl} alt="Wallet address QR code" />}
                  <small>{selectedWalletAddressChoice?.branch === "change"
                    ? "Change addresses receive wallet change. Circle actions use your selected receive address."
                    : "Use the address shown in Selene."}</small>
                  <button type="button" className="receive-address-change" onClick={() => setReceiveAddressPickerExpanded((value) => !value)}>{receiveAddressPickerExpanded ? "Close address list" : "Change address"}</button>
                </div>
                {receiveAddressPickerExpanded && <section className="receive-address-picker" aria-labelledby="receive-address-picker-title">
                  <div className="receive-address-picker-heading"><div><b id="receive-address-picker-title">Wallet addresses</b><small>Addresses with BCH appear first.</small></div>{receiveAddressScanLoading && <span className="receive-address-scan-state">Checking…</span>}</div>
                  {receiveAddressScanError && <p className="classic-error" role="alert">{receiveAddressScanError}</p>}
                  {!receiveAddressScanLoading && receiveAddressChoices.length === 0 && <p className="field-hint">Couldn't load your addresses. Reconnect and try again.</p>}
                  <div className="receive-address-choice-list">
                    {visibleWalletAddressChoices.map((choice) => {
                      const total = BigInt(choice.confirmedSatoshis) + BigInt(choice.unconfirmedSatoshis);
                      const key = getWalletAddressChoiceKey(choice);
                      const selected = key === walletDisplayAddressKey;
                      return <button type="button" key={key} className={selected ? "receive-address-choice selected" : "receive-address-choice"} aria-pressed={selected}
                        onClick={() => {
                          setWalletDisplayAddressKey(key);
                          setWalletFullAddressOpen(false);
                          setWalletAddressQrOpen(false);
                          const firstReceive = receiveAddressChoices.find((entry) => entry.branch === "receive" && entry.index === 0)?.address;
                          if (firstReceive) window.localStorage.setItem("ajochain:wallet-address-display:v1:" + network + ":" + firstReceive.toLowerCase(), key);
                          if (choice.branch === "receive" && network === "mainnet") {
                            walletClient?.selectReceiveAddressIndex(choice.index, network);
                            if (firstReceive) window.localStorage.setItem("ajochain:wallet-receive-selection:v1:" + network + ":" + firstReceive.toLowerCase(), String(choice.index));
                            setGatherPlan(null);
                            setGatherResult(null);
                            setAddressMatchMessage("Address confirmed ✓");
                          } else if (choice.branch === "receive" && network === "chipnet") {
                            setSeleneAddress(choice.address);
                            setAddressMatchMessage("Pick the address shown in Selene, then confirm it below.");
                          } else {
                            setAddressMatchMessage("Change address selected for display.");
                          }
                          setReceiveAddressPickerExpanded(false);
                        }}>
                        <span className="receive-address-choice-copy"><b>{shortAddress(choice.address)}</b><small>{formatBchSatoshis(total > 0n ? total : 0n)} · {choice.branch === "receive" ? "Receive" : "Change"}</small></span>
                        <span className="receive-address-choice-tags"><small className={choice.branch === "receive" ? "receive-address-selected" : "receive-address-newest"}>{choice.branch === "receive" ? "Receive" : "Change"}</small>{selected && <small className="receive-address-selected">Selected</small>}</span>
                      </button>;
                    })}
                  </div>
                  {!walletShowAllAddresses && sortedWalletAddressChoices.some((choice) => BigInt(choice.confirmedSatoshis) + BigInt(choice.unconfirmedSatoshis) === 0n) && <button type="button" className="text-action" onClick={() => setWalletShowAllAddresses(true)}>Show all addresses</button>}
                  {walletShowAllAddresses && <button type="button" className="text-action" onClick={() => setWalletShowAllAddresses(false)}>Hide empty addresses</button>}
                </section>}
                {(network === "chipnet" || network === "mainnet") && walletAddress && <details className="wallet-tools-disclosure wallet-advanced-tools"><summary>Advanced</summary><div>
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
                          ? "Pick an address first."
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
                    {network === "mainnet" && }
                  </section>
                </>}
                <button className="secondary-button" disabled={discoveryBusy} onClick={() => setDiscoveryRun((run) => run + 1)}>{discoveryBusy ? "Checking…" : "Check again"}</button>
                {discoveryMessage && <p className="wallet-match-message" role="status">{discoveryMessage}</p>}
                <button className="secondary-button" onClick={() => void walletClient?.disconnect()}>Disconnect wallet</button>
              </div>
            ) : (
              <div className="wallet-detail-body">
                {qrDataUrl && <img className="wallet-qr" src={qrDataUrl} alt="WizardConnect pairing QR code" />}
                {walletView.uri && <a className="primary-button wallet-open-link" href={walletView.uri}>Open in Selene <ArrowRight size={15} /></a>}
                {walletView.state === "connecting" && <p className="wallet-match-message">Approve in Selene, then come back.</p>}
                {walletView.state === "reconnecting" && <p className="wallet-match-message" role="status">Reconnecting…</p>}
                {walletView.state === "disconnected" && <p className="wallet-match-message" role="status">Disconnected.</p>}
                {walletView.error && <p className="wallet-match-message" role="alert">{walletView.error}</p>}
                <div className="wallet-modal-actions">
                  <button className="primary-button" onClick={() => {
                    if (!walletClient) { openWallet(); return; }
                    if (!walletClient.retrySavedSession()) {
                      if (walletClient.state === "idle") walletClient.connect();
                      else if (walletClient.state === "disconnected") walletClient.startFreshPairing();
                    }
                  }}>Reconnect</button>
                  <button className="secondary-button" onClick={() => walletClient?.startFreshPairing()}>Start fresh pairing</button>
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
