import { TestSignControl } from "./TestSignControl";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Copy, LockKeyhole, ShieldCheck } from "lucide-react";
import { PUSD_ASSET, formatAssetAmount, parseAssetAmount } from "../core/assets";
import { classicAddressToPkh } from "../core/classic-bch";
import { pkhToTokenAwareAddress } from "../core/bch-address";
import { calculatePusdCircleEconomics } from "../core/pusd-circle-economics";
import { MAINNET_PROJECT_TREASURY_ADDRESS } from "../core/project-treasury";
import { MAX_CIRCLE_MEMBERS, MIN_CIRCLE_MEMBERS } from "../core/member-ledger";
import {
  planPusdMainnetCircleGenesis,
  planPusdMainnetDeposit,
  planPusdMainnetPayout,
  planPusdMainnetCancel,
  readPusdMainnetCircle,
  validatePusdMainnetCircleParams,
  type PusdMainnetCircleParams,
  type PusdMainnetCircleSnapshot,
} from "../core/pusd-mainnet-circle";
import { broadcastPusdMainnetCircleSignedTransaction, verifyPusdMainnetCircleSignedTransaction } from "../core/pusd-api";
import { wallet } from "../core/wizard-wallet";
import type { NetworkId } from "../core/network-config";
import {
  getCancellationDisabledReason,
  getDepositDisabledReason,
  getPayoutDisabledReason,
  shouldRenderCircleCreation,
} from "./mainnet-circle-lifecycle-ui";
import { updateSavedCircleChainStatus } from "../circles/saved-circle-status";

type Props = { network: NetworkId; walletConnected: boolean; selectedAddressPendingOnly?: boolean; selectedCircle?: string | null; onBusyChange?: (busy: boolean) => void };
type Draft = {
  name: string;
  contribution: string;
  members: string[];
  maxFeeSatoshis: string;
  savedAt: number;
};

const STORAGE_KEY = "ajochain-blaze:pusd-mainnet-circle-drafts:v1";
const ACTIVE_CIRCLE_KEY = "ajochain-blaze:pusd-mainnet-circle-active:v1";
const DEPLOYED_KEY = "ajochain-blaze:pusd-mainnet-circles-deployed:v1";
const INVITE_ROUTE = "#/pusd-mainnet/";
type StoredCircle = Omit<PusdMainnetCircleParams, "contribution" | "maxFee"> & {
  contribution: string;
  maxFee: string;
};
type MainnetSigningPlan = {
  wc: unknown;
  walletInputs: number[];
  prompt: string;
  createdAt: number;
  operation: "genesis" | "deposit" | "payout" | "cancel";
  circle: PusdMainnetCircleParams;
  memberIndex?: number;
  amount?: string;
};

function readActiveCircle(): PusdMainnetCircleParams | null {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(ACTIVE_CIRCLE_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.contribution !== "string" || typeof item.maxFee !== "string") return null;
    const circle = {
      ...item,
      contribution: BigInt(item.contribution),
      maxFee: BigInt(item.maxFee),
    } as unknown as PusdMainnetCircleParams;
    validatePusdMainnetCircleParams(circle);
    return circle;
  } catch {
    return null;
  }
}

function serializeCircle(circle: PusdMainnetCircleParams): string {
  return JSON.stringify({ ...circle, contribution: circle.contribution.toString(), maxFee: circle.maxFee.toString() });
}

function deserializeCircle(json: string): PusdMainnetCircleParams | null {
  try {
    const item: unknown = JSON.parse(json);
    if (!item || typeof item !== "object") return null;
    const raw = item as Record<string, unknown>;
    if (typeof raw.contribution !== "string" || typeof raw.maxFee !== "string") return null;
    const circle = { ...raw, contribution: BigInt(raw.contribution), maxFee: BigInt(raw.maxFee) } as unknown as PusdMainnetCircleParams;
    validatePusdMainnetCircleParams(circle);
    return circle;
  } catch {
    return null;
  }
}

/** Deployed circles are kept in a list keyed by state category so a new preview never erases a funded circle. */
function readDeployedCircles(): PusdMainnetCircleParams[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(DEPLOYED_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const circles: PusdMainnetCircleParams[] = [];
    for (const entry of raw) {
      if (typeof entry !== "string") continue;
      const circle = deserializeCircle(entry);
      if (circle && !seen.has(circle.stateCategory.toLowerCase())) {
        seen.add(circle.stateCategory.toLowerCase());
        circles.push(circle);
      }
    }
    return circles;
  } catch {
    return [];
  }
}

function addDeployedCircle(circle: PusdMainnetCircleParams): PusdMainnetCircleParams[] {
  const existing = readDeployedCircles();
  const next = existing.some((entry) => entry.stateCategory.toLowerCase() === circle.stateCategory.toLowerCase())
    ? existing
    : [...existing, circle];
  window.localStorage.setItem(DEPLOYED_KEY, JSON.stringify(next.map(serializeCircle)));
  return next;
}

function encodeCircleInvite(circle: PusdMainnetCircleParams): string {
  const bytes = new TextEncoder().encode(serializeCircle(circle));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function persistActiveCircle(circle: PusdMainnetCircleParams) {
  const stored: StoredCircle = {
    ...circle,
    contribution: circle.contribution.toString(),
    maxFee: circle.maxFee.toString(),
  };
  window.localStorage.setItem(ACTIVE_CIRCLE_KEY, JSON.stringify(stored));
}

function persistPusdChainProgress(
  circle: PusdMainnetCircleParams,
  encoded: string,
  snapshot: PusdMainnetCircleSnapshot,
) {
  updateSavedCircleChainStatus(window.localStorage, {
    id: "pusd:" + circle.stateCategory.toLowerCase(),
    encoded,
    network: "mainnet",
    kind: "pusd-mainnet",
    name: circle.name,
    asset: "PUSD",
    contribution: circle.contribution.toString(),
    memberCount: circle.members.length,
  }, snapshot.completed ? "completed" : "active", snapshot.round, null);
}


function readDrafts(): Draft[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item: unknown): item is Draft => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Record<string, unknown>;
      return typeof candidate.name === "string" &&
        typeof candidate.contribution === "string" &&
        Array.isArray(candidate.members) &&
        candidate.members.every((member: unknown) => typeof member === "string") &&
        typeof candidate.maxFeeSatoshis === "string" &&
        Number.isSafeInteger(candidate.savedAt);
    }).slice(0, 20);
  } catch {
    return [];
  }
}

function addressKey(address: string) {
  return Array.from(classicAddressToPkh(address, "mainnet"), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

export default function PusdMainnetCircleWorkspace({ network, walletConnected, selectedAddressPendingOnly = false, selectedCircle = null, onBusyChange }: Props) {
  const [name, setName] = useState(() => "PUSD Ajo circle – " + new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" }));
  const [contribution, setContribution] = useState("10.00");
  const [membersText, setMembersText] = useState("");
  const [maxFee, setMaxFee] = useState("20000");
  const [drafts, setDrafts] = useState<Draft[]>(readDrafts);
  const [notice, setNotice] = useState("");
  const [testSignChecked, setTestSignChecked] = useState<"genesis" | "action" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [activeCircle, setActiveCircle] = useState<PusdMainnetCircleParams | null>(readActiveCircle);
  const [circleSnapshot, setCircleSnapshot] = useState<PusdMainnetCircleSnapshot | null>(null);
  const [depositAmount, setDepositAmount] = useState("10.00");
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [actionPreview, setActionPreview] = useState<{
    title: string;
    summary: string;
    feeEstimate: string;
    size: string;
    walletInputCount: number;
  } | null>(null);

  const [preparedPlan, setPreparedPlan] = useState<{
    contractAddress: string;
    escrowAddresses: string[];
    feeEstimate: string;
    transactionSizeBytes: number;
  } | null>(null);
  const [genesisSigningPlan, setGenesisSigningPlan] = useState<MainnetSigningPlan | null>(null);
  const [actionSigningPlan, setActionSigningPlan] = useState<MainnetSigningPlan | null>(null);
  const [creationResult, setCreationResult] = useState<{ txid: string; explorerUrl: string; inviteUrl: string } | null>(null);
  const [openCircleKey, setOpenCircleKey] = useState<string | null>(null);
  const autoStatusReadKeyRef = useRef<string | null>(null);
  const creationSummaryRef = useRef<HTMLDivElement>(null);
  const [, setDeployedCircles] = useState<PusdMainnetCircleParams[]>(readDeployedCircles);
  const isCircleOpen = Boolean(activeCircle && openCircleKey);
  const payoutDisabledReason = getPayoutDisabledReason({
    hasStatus: Boolean(circleSnapshot),
    walletConnected,
    payoutReady: Boolean(circleSnapshot?.ready),
  });
  const cancellationDisabledReason = getCancellationDisabledReason({
    hasStatus: Boolean(circleSnapshot),
    walletConnected,
    cancellationAllowed: Boolean(circleSnapshot && circleSnapshot.round === 0 && !circleSnapshot.completed),
  });
  const depositDisabledReason = getDepositDisabledReason(walletConnected);

  useEffect(() => {
    onBusyChange?.(busy || lifecycleBusy);
    return () => onBusyChange?.(false);
  }, [busy, lifecycleBusy, onBusyChange]);

  useEffect(() => {
    if (preparedPlan) creationSummaryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [preparedPlan]);

  useEffect(() => {
    if (!selectedCircle) return;
    const circle = deserializeCircle(selectedCircle);
    if (!circle) {
      setError("This saved PUSD circle could not be opened.");
      return;
    }
    setActiveCircle(circle);
    setOpenCircleKey("selected:" + selectedCircle);
    setCreationResult(null);
    persistActiveCircle(circle);
    setCircleSnapshot(null);
    setGenesisSigningPlan(null);
    setActionSigningPlan(null);
    setNotice("Opened " + circle.name + ". Checking its latest blockchain status.");
  }, [selectedCircle]);
  const memberAddresses = useMemo(() =>
    membersText.split(/\r?\n/).map((address) => address.trim()).filter(Boolean),
  [membersText]);
  const initiatorAddress = walletConnected && wallet.state === "connected" ? wallet.address("mainnet") : null;
  const initiatorMemberAddress = initiatorAddress
    ? pkhToTokenAwareAddress(classicAddressToPkh(initiatorAddress, "mainnet"), "mainnet")
    : null;
  const circleMembers = useMemo(() => initiatorMemberAddress ? [initiatorMemberAddress, ...memberAddresses] : memberAddresses,
    [initiatorMemberAddress, memberAddresses]);

  const economics = useMemo(() => {
    try {
      if (circleMembers.length < MIN_CIRCLE_MEMBERS || circleMembers.length > MAX_CIRCLE_MEMBERS) return null;
      return calculatePusdCircleEconomics(circleMembers.length, parseAssetAmount("PUSD", contribution));
    } catch {
      return null;
    }
  }, [circleMembers, contribution]);

  const saveDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice("");
    setError("");
    try {
      if (network !== "mainnet") {
        throw new Error("PUSD circles use the real ParyonUSD Mainnet category only. Switch the app to Mainnet.");
      }
      if (!name.trim() || name.trim().length > 60) {
        throw new Error("Enter a circle name between 1 and 60 characters.");
      }
      if (!initiatorAddress || !initiatorMemberAddress || !walletConnected || wallet.state !== "connected" || !wallet.isReceiveAddressConfirmed("mainnet")) {
        throw new Error("Pick the address shown in Selene in Wallet details first.");
      }
      if (selectedAddressPendingOnly) throw new Error("Wait 1 confirmation, then create.");
      if (memberAddresses.length < 1 || memberAddresses.length > 4) {
        throw new Error("Add 1–4 other token-aware Bitcoin Cash Mainnet addresses. Your selected Selene address is Member 1.");
      }
      const circleMembers = [initiatorMemberAddress, ...memberAddresses];
      const keys = circleMembers.map(addressKey);
      if (new Set(keys).size !== keys.length) {
        throw new Error("Every member must have a unique Mainnet address, including your selected Selene address.");
      }
      const units = parseAssetAmount("PUSD", contribution);
      calculatePusdCircleEconomics(circleMembers.length, units);
      if (!/^\d+$/.test(maxFee.trim()) || BigInt(maxFee.trim()) < 1000n) {
        throw new Error("Maximum BCH miner fee must be at least 1,000 whole satoshis.");
      }

      const draft: Draft = {
        name: name.trim(),
        contribution: units.toString(),
        members: circleMembers,
        maxFeeSatoshis: maxFee.trim(),
        savedAt: Date.now(),
      };
      const next = [draft, ...drafts.filter((entry) =>
        entry.name !== draft.name || entry.contribution !== draft.contribution ||
        entry.members.join("|") !== draft.members.join("|"),
      )].slice(0, 20);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setDrafts(next);
      setNotice(
        "Mainnet PUSD circle draft saved locally. No contract was deployed and no wallet signature or transaction was requested.",
      );
      setContribution(formatAssetAmount("PUSD", units));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const prepareCreationPlan = async (): Promise<MainnetSigningPlan | null> => {
    setNotice("");
    setError("");
    setPreparedPlan(null);
    setGenesisSigningPlan(null);
    setActionSigningPlan(null);
    setCreationResult(null);
    if (network !== "mainnet") {
      setError("PUSD circle creation plans are Mainnet-only.");
      return null;
    }
    if (!walletConnected || wallet.state !== "connected") {
      setError("Connect Selene in Selene before preparing a Mainnet creation plan.");
      return null;
    }
    const initiatorAddress = wallet.address("mainnet");
    if (!initiatorAddress || !wallet.isReceiveAddressConfirmed("mainnet")) {
      setError("Pick the address shown in Selene in Wallet details first.");
      return null;
    }
    if (selectedAddressPendingOnly) {
      setError("Wait 1 confirmation, then create.");
      return null;
    }
    if (memberAddresses.length < 1 || memberAddresses.length > 4) {
      setError("Add 1–4 other Mainnet member addresses. Your selected Selene address is Member 1.");
      return null;
    }
    const selectedTokenAddress = pkhToTokenAwareAddress(classicAddressToPkh(initiatorAddress, "mainnet"), "mainnet");
    const circleMembers = [selectedTokenAddress, ...memberAddresses];
    setBusy(true);
    try {
      const units = parseAssetAmount("PUSD", contribution);
      const plan = await planPusdMainnetCircleGenesis({
        name: name.trim(),
        members: circleMembers,
        contribution: units,
        maxFee: BigInt(maxFee.trim()),
      }, initiatorAddress);
      if (!wallet.isReceiveAddressConfirmed("mainnet") || wallet.address("mainnet") !== initiatorAddress ||
          plan.params.initiator !== initiatorAddress || addressKey(plan.params.members[0]) !== addressKey(initiatorAddress)) {
        throw new Error("The selected Selene address changed while preparing this PUSD circle. Choose it again and prepare a fresh preview.");
      }
      const signingPlan: MainnetSigningPlan = {
        wc: plan.wc, walletInputs: plan.walletInputs,
        prompt: "Check PUSD Mainnet circle setup for " + name.trim(),
        createdAt: Date.now(),
        operation: "genesis",
        circle: plan.params,
      };
      setGenesisSigningPlan(signingPlan);
      setPreparedPlan({
        contractAddress: plan.contractAddress!,
        escrowAddresses: plan.escrowAddresses ?? [],
        feeEstimate: plan.feeEstimate.toString(),
        transactionSizeBytes: plan.transactionSizeBytes,
      });
      setNotice("PUSD circle setup preview ready. Nothing has been signed or sent.");
      return signingPlan;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const verifyMainnetSignature = async (target: "genesis" | "action", send = false, signingPlanOverride?: MainnetSigningPlan | null) => {
    const signingPlan = signingPlanOverride ?? (target === "genesis" ? genesisSigningPlan : actionSigningPlan);
    if (!signingPlan) return;
    if (network !== "mainnet" || !walletConnected || wallet.state !== "connected") {
      setError("Reconnect Selene on BCH Mainnet before starting PUSD signature verification.");
      return;
    }
    if (Date.now() - signingPlan.createdAt > 60_000) {
      if (target === "genesis") setGenesisSigningPlan(null);
      else setActionSigningPlan(null);
      setError("This signed-transaction review plan is older than 60 seconds. Refresh the circle state and prepare a new plan before asking Selene to sign.");
      return;
    }
    if (signingPlan.operation === "genesis") {
      const selectedAddress = wallet.address("mainnet");
      if (selectedAddressPendingOnly) {
        setError("Wait 1 confirmation, then create.");
        return;
      }
      if (!selectedAddress || !wallet.isReceiveAddressConfirmed("mainnet") ||
          selectedAddress !== signingPlan.circle.initiator || addressKey(signingPlan.circle.members[0]) !== addressKey(selectedAddress)) {
        setGenesisSigningPlan(null);
        setPreparedPlan(null);
        setError("The selected Selene receive address changed after the PUSD preview. Choose it again and prepare a fresh circle.");
        return;
      }
    }
    setLifecycleBusy(true);
    setError("");
    setNotice("");
    setTestSignChecked(null);
    try {
      const walletAddress = wallet.address("mainnet");
      if (!walletAddress) throw new Error("The connected wallet address isn't available on Mainnet. Reconnect Selene.");
      if (signingPlan.operation === "genesis" &&
          (!wallet.isReceiveAddressConfirmed("mainnet") || walletAddress !== signingPlan.circle.initiator ||
           addressKey(signingPlan.circle.members[0]) !== addressKey(walletAddress))) {
        throw new Error("The selected Selene receive address changed before approval. The PUSD circle was not signed or broadcast.");
      }
      const locallyVerified = await wallet.signAndVerify(
        signingPlan.wc,
        signingPlan.walletInputs,
        signingPlan.prompt + (send ? " (check and send on BCH Mainnet)" : " (independent server verification only; never broadcast)"),
      );
      if (signingPlan.operation === "genesis" &&
          (!wallet.isReceiveAddressConfirmed("mainnet") || wallet.address("mainnet") !== signingPlan.circle.initiator)) {
        throw new Error("The selected Selene receive address changed after signing. The signed PUSD transaction was discarded and was not sent.");
      }
      const circleRequest = {
        operation: signingPlan.operation,
        circle: {
          ...signingPlan.circle,
          contribution: signingPlan.circle.contribution.toString(),
          maxFee: signingPlan.circle.maxFee.toString(),
        },
        walletAddresses: [walletAddress],
        signedTransactionHex: locallyVerified.signedTransaction,
        ...(signingPlan.operation === "deposit"
          ? { memberIndex: signingPlan.memberIndex, amount: signingPlan.amount }
          : {}),
      };
      if (send) {
        const relayed = await broadcastPusdMainnetCircleSignedTransaction(circleRequest);
        if (signingPlan.operation === "deposit" || signingPlan.operation === "payout") {
          window.dispatchEvent(new Event("ajochain:wallet-balances-changed"));
        }
        if (target === "genesis") setGenesisSigningPlan(null);
        else setActionSigningPlan(null);
        const sent =
          "PUSD Mainnet " + signingPlan.operation + " transaction sent. Transaction: " +
          relayed.txid + " It is waiting for confirmation. Check the circle again after it confirms.";
        setNotice(sent);
        if (target === "genesis") {
          if (!/^[0-9a-f]{64}$/i.test(relayed.txid)) {
            throw new Error("Selene approved the transaction, but the broadcast response did not include a valid transaction ID. The circle was not added to My circles.");
          }
          const inviteUrl = window.location.origin + window.location.pathname + INVITE_ROUTE + encodeCircleInvite(signingPlan.circle);
          setCreationResult({
            txid: relayed.txid,
            explorerUrl: "https://blockexplorer.cash/mainnet/tx/" + relayed.txid,
            inviteUrl,
          });
          setActiveCircle(signingPlan.circle);
          setOpenCircleKey("created:" + relayed.txid);
          try {
            persistActiveCircle(signingPlan.circle);
            setDeployedCircles(addDeployedCircle(signingPlan.circle));
          } catch {
            setNotice(sent + " The transaction was sent, but this browser could not save the circle locally. Its invite is shown below.");
          }
        }
        return;
      }
      await verifyPusdMainnetCircleSignedTransaction(circleRequest);
      if (target === "genesis") setGenesisSigningPlan(null);
      else setActionSigningPlan(null);
      setNotice(
        "Selene approval passed the independent check. Nothing was sent and no circle details changed.",
      );
      setTestSignChecked(target);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLifecycleBusy(false);
    }
  };

  const createCircleInSelene = async () => {
    if (selectedAddressPendingOnly) {
      setError("Wait 1 confirmation, then create.");
      return;
    }
    let signingPlan = genesisSigningPlan;
    if (!signingPlan || Date.now() - signingPlan.createdAt > 60_000) {
      signingPlan = await prepareCreationPlan();
    }
    if (!signingPlan) return;
    await verifyMainnetSignature("genesis", true, signingPlan);
  };

  const readActiveOnChainState = async () => {
    if (!activeCircle) return;
    setLifecycleBusy(true);
    setError("");
    setNotice("");
    setActionPreview(null);
    setActionSigningPlan(null);
    setGenesisSigningPlan(null);
    try {
      const snapshot = await readPusdMainnetCircle(activeCircle);
      setCircleSnapshot(snapshot);
      persistPusdChainProgress(activeCircle, serializeCircle(activeCircle), snapshot);
      setNotice("PUSD Mainnet circle status refreshed from the blockchain.");
    } catch (cause) {
      setCircleSnapshot(null);
      setError(errorMessage(cause));
    } finally {
      setLifecycleBusy(false);
    }
  };

  useEffect(() => {
    if (!activeCircle || !openCircleKey) {
      autoStatusReadKeyRef.current = null;
      return;
    }
    const readKey = openCircleKey + ":" + activeCircle.stateCategory;
    if (autoStatusReadKeyRef.current === readKey) return;
    autoStatusReadKeyRef.current = readKey;
    void readActiveOnChainState();
  }, [activeCircle?.stateCategory, openCircleKey]);

  const prepareDepositPreview = async () => {
    if (!activeCircle) return;
    const address = wallet.address("mainnet");
    if (!walletConnected || wallet.state !== "connected" || !address) {
      setError("Connect the Mainnet member wallet in Selene first.");
      return;
    }
    setLifecycleBusy(true);
    setError("");
    setNotice("");
    setActionPreview(null);
    setActionSigningPlan(null);
    try {
      const key = addressKey(address);
      const memberIndex = activeCircle.members.findIndex((member) => addressKey(member) === key);
      if (memberIndex < 0) throw new Error("The connected wallet is not a registered member of this PUSD circle.");
      const amount = parseAssetAmount("PUSD", depositAmount);
      const plan = await planPusdMainnetDeposit(activeCircle, memberIndex, amount, address);
      setActionSigningPlan({
        wc: plan.wc, walletInputs: plan.walletInputs,
        prompt: "Server-verify PUSD Mainnet member deposit for " + activeCircle.name,
        createdAt: Date.now(),
        operation: "deposit",
        circle: activeCircle,
        memberIndex,
        amount: amount.toString(),
      });
      setActionPreview({
        title: "Unsigned PUSD member-deposit preview",
        summary: plan.summary,
        feeEstimate: plan.feeEstimate.toString(),
        size: plan.transactionSizeBytes.toString(),
        walletInputCount: plan.walletInputs.length,
      });
      setNotice("Deposit transaction plan prepared for member " + (memberIndex + 1) + ". No signature or broadcast was requested.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLifecycleBusy(false);
    }
  };

  const preparePayoutPreview = async () => {
    if (!activeCircle) return;
    const address = wallet.address("mainnet");
    if (!walletConnected || wallet.state !== "connected" || !address) {
      setError("Connect a wallet to sponsor the payout miner fee in Selene first.");
      return;
    }
    setLifecycleBusy(true);
    setError("");
    setNotice("");
    setActionPreview(null);
    setActionSigningPlan(null);
    try {
      const plan = await planPusdMainnetPayout(activeCircle, address);
      setActionSigningPlan({
        wc: plan.wc, walletInputs: plan.walletInputs,
        prompt: "Server-verify PUSD Mainnet payout for " + activeCircle.name,
        createdAt: Date.now(),
        operation: "payout",
        circle: activeCircle,
      });
      setActionPreview({
        title: "Unsigned PUSD payout preview",
        summary: plan.summary,
        feeEstimate: plan.feeEstimate.toString(),
        size: plan.transactionSizeBytes.toString(),
        walletInputCount: plan.walletInputs.length,
      });
      setNotice("Payout plan prepared. It remains unsigned and cannot be broadcast from this workspace.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLifecycleBusy(false);
    }
  };

  const prepareCancelPreview = async () => {
    if (!activeCircle) return;
    const address = wallet.address("mainnet");
    if (!walletConnected || wallet.state !== "connected" || !address) {
      setError("Connect the registered circle initiator wallet in Selene first.");
      return;
    }
    setLifecycleBusy(true);
    setError("");
    setNotice("");
    setActionPreview(null);
    setActionSigningPlan(null);
    try {
      const plan = await planPusdMainnetCancel(activeCircle, address);
      setActionSigningPlan({
        wc: plan.wc, walletInputs: plan.walletInputs,
        prompt: "Server-verify PUSD Mainnet pre-payout cancellation for " + activeCircle.name,
        createdAt: Date.now(),
        operation: "cancel",
        circle: activeCircle,
      });
      setActionPreview({
        title: "Unsigned pre-payout cancellation preview",
        summary: plan.summary,
        feeEstimate: plan.feeEstimate.toString(),
        size: plan.transactionSizeBytes.toString(),
        walletInputCount: plan.walletInputs.length,
      });
      setNotice("Cancellation/refund plan prepared. It remains unsigned and cannot be broadcast from this workspace.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLifecycleBusy(false);
    }
  };

  const closeCircleAndCreateNew = () => {
    setOpenCircleKey(null);
    setActiveCircle(null);
    setCircleSnapshot(null);
    setActionPreview(null);
    setActionSigningPlan(null);
    setGenesisSigningPlan(null);
    setPreparedPlan(null);
    setCreationResult(null);
    setError("");
    setNotice("");
  };

  const restore = (draft: Draft) => {
    setName(draft.name);
    setContribution(formatAssetAmount("PUSD", BigInt(draft.contribution)));
    setMembersText(draft.members.slice(1).join("\n"));
    setMaxFee(draft.maxFeeSatoshis);
    setNotice("Draft loaded. Review member addresses and amounts before preparing the Mainnet transaction plan.");
    setError("");
  };

  return (
    <section className="pusd-mainnet-workspace section-card" aria-labelledby="pusd-mainnet-title">
      {shouldRenderCircleCreation(isCircleOpen) && <>
      <div className="section-heading">
        <div>
          <span className="section-kicker">PARYONUSD · DOLLAR TOKEN</span>
          <h2 id="pusd-mainnet-title">Create a PUSD Mainnet circle</h2>
          <p>PUSD stays in each member’s control, with clear payout rules, a 1% treasury fee and cancellation before payout.</p>
        </div>
        <span className="classic-network mainnet">Bitcoin Cash Mainnet</span>
      </div>

      <div className="pusd-mainnet-safety">
        <div><ShieldCheck size={17} /><span><b>Mainnet asset selected</b><small>Official ParyonUSD asset · Mainnet only</small></span></div>
        <span className="asset-state neutral">Transactions locked during build</span>
      </div>

      {network !== "mainnet" && (
        <p className="classic-error" role="status">Switch the app network to Bitcoin Cash Mainnet to prepare a PUSD circle. PUSD is not enabled on Chipnet.</p>
      )}

      <form className="pusd-mainnet-form" onSubmit={saveDraft}>
        <label>Circle name
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required />
        </label>
        <label>Contribution per member (PUSD)
          <input value={contribution} onChange={(event) => setContribution(event.target.value)} inputMode="decimal" placeholder="10.00" required />
          <small>Enter a PUSD amount using two decimal places.</small>
        </label>
        <div className="creator-member-preview">
          <b>Member 1 · You, the initiator</b>
          {initiatorAddress ? <>
            <code>{initiatorAddress}</code>
            <button className="secondary-button wallet-copy-address" type="button" onClick={() => {
              const pendingCopy = navigator.clipboard?.writeText(initiatorAddress);
              if (!pendingCopy) { setNotice("Copy is unavailable. Select the address and copy it manually."); return; }
              void pendingCopy.then(() => setNotice("Member 1 address copied."))
                .catch(() => setNotice("Could not copy the address. Select it and copy manually."));
            }}><Copy size={15} /> Copy address</button>
            <small>{wallet.isReceiveAddressConfirmed("mainnet") ? "Address confirmed ✓" : "Pick the address shown in Selene first."}</small>
          </> : "Connect Selene and choose your receive address. It will be Member 1 automatically."}
        </div>
        <label>Other members' Mainnet BCH addresses · one per line
          <textarea value={membersText} onChange={(event) => setMembersText(event.target.value)} rows={4} placeholder={"bitcoincash:…\nbitcoincash:…"} required />
          <small>Add 1–4 other unique token-aware Bitcoin Cash Mainnet addresses. Your selected Selene address is Member 1 and receives your circle payout when it is your turn.</small>
        </label>
        {selectedAddressPendingOnly && <p className="receive-address-pending-warning" role="alert">Wait 1 confirmation, then create.</p>}
        <label>Maximum BCH miner fee per action (satoshis)
          <input value={maxFee} onChange={(event) => setMaxFee(event.target.value)} inputMode="numeric" required />
          <small>Network fees and the small BCH amount needed to deliver PUSD are separate from PUSD contributions.</small>
        </label>

        <div className="pusd-mainnet-treasury">
          <span>1% project fee goes to this published address</span>
          <code>{MAINNET_PROJECT_TREASURY_ADDRESS}</code>
        </div>

        {economics && (
          <div className="pusd-mainnet-breakdown">
            <b>First-round savings preview</b>
            <div><span>Gross PUSD pot</span><strong>{formatAssetAmount("PUSD", economics.grossPot)} PUSD</strong></div>
            <div><span>Project fee · 1%</span><strong>{formatAssetAmount("PUSD", economics.projectFee)} PUSD</strong></div>
            <div><span>Next contribution reserved to first recipient</span><strong>{formatAssetAmount("PUSD", economics.firstPayoutReserve)} PUSD</strong></div>
            <div><span>First recipient receives</span><strong>{formatAssetAmount("PUSD", economics.firstRecipientPayout)} PUSD</strong></div>
            <div><span>Final recipient receives · no reserve</span><strong>{formatAssetAmount("PUSD", economics.finalRecipientPayout)} PUSD</strong></div>
          </div>
        )}

        <div className="pusd-mainnet-actions">
          <button className="secondary-button" type="submit" disabled={network !== "mainnet"}>Save Mainnet circle draft</button>
          <button className="primary-button" type="button" onClick={() => void prepareCreationPlan()} disabled={network !== "mainnet" || !walletConnected || busy}>
            {busy ? "Preparing preview…" : "Continue"} <ArrowRight size={15} />
          </button>
        </div>
      </form>

      {preparedPlan && genesisSigningPlan && (
        <div ref={creationSummaryRef} className="pusd-mainnet-breakdown mainnet-create-summary" role="status">
          <b>Review your circle</b>
          <p className="receive-address-payout-note">Payouts for this circle will go to {genesisSigningPlan.circle.initiator.slice(0, 10)}…{genesisSigningPlan.circle.initiator.slice(-6)}. It stays in your Selene wallet.</p>
          {selectedAddressPendingOnly && <p className="receive-address-pending-warning" role="alert">Wait 1 confirmation, then create.</p>}
          <div><span>Member 1 · payout address</span><strong><code>{genesisSigningPlan.circle.members[0]}</code></strong></div>
          <button type="button" className="primary-button mainnet-create-primary" disabled={lifecycleBusy || busy || !walletConnected || selectedAddressPendingOnly}
            onClick={() => void createCircleInSelene()}>
            {lifecycleBusy ? "Approve in Selene…" : "Create circle in Selene"}
          </button>
          <div><span>Members</span><strong>{genesisSigningPlan.circle.members.length}</strong></div>
          <div><span>Contribution per member</span><strong>{formatAssetAmount("PUSD", genesisSigningPlan.circle.contribution)} PUSD</strong></div>
          <div><span>Estimated network fee</span><strong>{preparedPlan.feeEstimate} sats</strong></div>
          <details className="technical-details">
            <summary>Details</summary>
            <div><span>PUSD circle contract address</span><strong><code>{preparedPlan.contractAddress}</code></strong></div>
            {preparedPlan.escrowAddresses.map((address, index) => (
              <div key={address}><span>Member {index + 1} escrow address</span><strong><code>{address}</code></strong></div>
            ))}
            <p>Estimated transaction size: {preparedPlan.transactionSizeBytes} bytes.</p>
          </details>
          <TestSignControl planCreatedAt={genesisSigningPlan?.createdAt ?? null} disabled={lifecycleBusy || !walletConnected}
            checked={testSignChecked === "genesis"} onTest={() => void verifyMainnetSignature("genesis")} />
          <small>Nothing has been created yet. The circle is saved only after the Mainnet broadcast returns a transaction ID.</small>
        </div>
      )}
      </>}
      {creationResult && (
        <div className="pusd-mainnet-breakdown mainnet-create-success" role="status">
          <b>Circle created</b>
          <p>Selene approved the transaction and the Mainnet returned a transaction ID.</p>
          <div><span>Transaction ID</span><strong><a href={creationResult.explorerUrl} target="_blank" rel="noreferrer">{creationResult.txid}</a></strong></div>
          <div className="mainnet-create-invite">
            <span>Invite link to share</span>
            <a href={creationResult.inviteUrl}>{creationResult.inviteUrl}</a>
            <button type="button" className="secondary-button" onClick={() => {
              void navigator.clipboard.writeText(creationResult.inviteUrl).then(
                () => setNotice("Invite link copied. Share it with your circle members."),
                () => setNotice("Invite link: " + creationResult.inviteUrl),
              );
            }}>Copy invite link</button>
          </div>
        </div>
      )}
      {isCircleOpen && activeCircle && (
        <div className="pusd-mainnet-saved">
          <div className="section-heading circle-lifecycle-heading">
            <div><span className="section-kicker">CIRCLE · PUSD MAINNET</span><h3>{activeCircle.name}</h3></div>
            <div className="circle-lifecycle-toolbar">
              <button type="button" className="secondary-button circle-lifecycle-refresh" disabled={lifecycleBusy} onClick={() => void readActiveOnChainState()}>
                {lifecycleBusy ? "Checking…" : "Refresh status"}
              </button>
              <button type="button" className="secondary-button circle-lifecycle-new" onClick={closeCircleAndCreateNew}>Create a new circle</button>
            </div>
          </div>
          {!circleSnapshot && <p className="classic-empty">Checking circle status…</p>}
          {circleSnapshot && <p className="classic-empty">Latest PUSD Mainnet circle details are up to date.</p>}
          {circleSnapshot && (
            <div className="pusd-mainnet-breakdown">
              <b>Circle status</b>
              <div><span>Round</span><strong>{circleSnapshot.completed ? "Completed" : (circleSnapshot.round + 1) + " of " + activeCircle.members.length}</strong></div>
              <div><span>Next recipient</span><strong>{circleSnapshot.recipient ?? "None"}</strong></div>
              <div><span>Payout readiness</span><strong>{circleSnapshot.ready ? "Ready" : "Waiting for member credits"}</strong></div>
              {circleSnapshot.credits.map((credit, index) => (
                <div key={activeCircle.members[index]}><span>Member {index + 1} credit</span><strong>{formatAssetAmount("PUSD", credit)} PUSD</strong></div>
              ))}
            </div>
          )}
          <label>Deposit amount (PUSD)
            <input value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} inputMode="decimal" />
          </label>
          <div className="pusd-mainnet-actions">
            <div className="lifecycle-action-control">
              <button type="button" className="secondary-button" disabled={lifecycleBusy || !walletConnected} onClick={() => void prepareDepositPreview()}>Preview member deposit</button>
              {depositDisabledReason && <small className="lifecycle-action-reason">{depositDisabledReason}</small>}
            </div>
            <div className="lifecycle-action-control">
              <button type="button" className="secondary-button" disabled={lifecycleBusy || !walletConnected || !circleSnapshot?.ready} onClick={() => void preparePayoutPreview()}>Preview payout</button>
              {payoutDisabledReason && <small className="lifecycle-action-reason">{payoutDisabledReason}</small>}
            </div>
            <div className="lifecycle-action-control">
              <button type="button" className="secondary-button" disabled={lifecycleBusy || !walletConnected || !circleSnapshot || circleSnapshot.round !== 0 || circleSnapshot.completed} onClick={() => void prepareCancelPreview()}>Preview cancellation</button>
              {cancellationDisabledReason && <small className="lifecycle-action-reason">{cancellationDisabledReason}</small>}
            </div>
          </div>
          {actionPreview && (
            <div className="pusd-mainnet-breakdown" role="status">
              <b>{actionPreview.title}</b>
              <p>{actionPreview.summary}</p>
              <div><span>Estimated BCH network fee</span><strong>{actionPreview.feeEstimate} sats</strong></div>
              <details className="technical-details">
                <summary>Details</summary>
                <p>Estimated transaction size: {actionPreview.size} bytes. Wallet items to approve: {actionPreview.walletInputCount}.</p>
                <p>Payments are checked before they are sent. Check circle status again before each new action.</p>
              </details>
              <TestSignControl planCreatedAt={actionSigningPlan?.createdAt ?? null} disabled={lifecycleBusy || !walletConnected}
                checked={testSignChecked === "action"} onTest={() => void verifyMainnetSignature("action")} />
              {actionSigningPlan && <button type="button" className="primary-button" disabled={lifecycleBusy || !walletConnected} onClick={() => void verifyMainnetSignature("action", true)}>Sign and send on Mainnet</button>}
            </div>
          )}       </div>
      )}

      {error && <p className="classic-error" role="alert">{error}
        <button type="button" className="inline-dismiss" aria-label="Close error" onClick={() => setError("")}>×</button>
      </p>}
      {notice && <p className="classic-notice" role="status">{notice}</p>}

      {isCircleOpen && activeCircle && (
        <div className="pusd-mainnet-invite">
          <button type="button" className="secondary-button" onClick={() => {
            const link = window.location.origin + window.location.pathname + INVITE_ROUTE + encodeCircleInvite(activeCircle);
            void navigator.clipboard.writeText(link).then(
              () => setNotice("Invite link copied. Share it with members so their browser loads this circle."),
              () => setNotice("Invite link: " + link),
            );
          }}>Copy invite</button>
          <small>Members open this link to load the circle. It contains the circle parameters, not keys.</small>
        </div>
      )}

      <div className="pusd-mainnet-build-status">
        <LockKeyhole size={16} />
        <span><b>PUSD Mainnet circle rules</b><small>Members approve each payment in Selene. The app checks the circle details before sending. Plain PUSD wallet transfers remain locked.</small>
          <details className="technical-details">
            <summary>Details</summary>
            <details className="technical-details">
            <summary>Details</summary>
            <p>Before sending, the app checks the previous payments, circle rules and wallet approval. It prevents the same payment from being sent twice.</p>
          </details>
          </details></span>
      </div>

      <div className="pusd-mainnet-saved">
        <div className="section-heading"><div><span className="section-kicker">LOCAL DRAFTS</span><h3>Saved PUSD circles</h3></div><small>{walletConnected ? "Wallet connected" : "Wallet not connected"}</small></div>
        {drafts.length === 0 ? <p className="classic-empty">No PUSD Mainnet circle drafts saved on this browser.</p> : (
          <div className="classic-saved-list">
            {drafts.map((draft, index) => (
              <button type="button" className="classic-saved-item" key={draft.savedAt + ":" + index} onClick={() => restore(draft)}>
                <b>{draft.name}</b>
                <span>{formatAssetAmount("PUSD", BigInt(draft.contribution))} PUSD · {draft.members.length} members</span>
                <small>Saved {new Date(draft.savedAt).toLocaleString()}</small>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="pusd-mainnet-asset-meta">
        <span>Asset identifier</span><code>{PUSD_ASSET.categoryId}</code>
        <span>Asset precision</span><b>{PUSD_ASSET.decimals} decimals</b>
      </div>
    </section>
  );
}
