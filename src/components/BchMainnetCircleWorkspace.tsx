import { TestSignControl } from "./TestSignControl";
import { plainErrorSummary } from "./error-copy";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Copy, LockKeyhole } from "lucide-react";
import { encodeV2FeeCircleParams } from "../core/v2-fee-discovery";
import { formatAssetAmount, parseAssetAmount } from "../core/assets";
import { createBchMainnetCircleDraft, prepareBchMainnetCircleGenesisPreview } from "../core/bch-mainnet-circle";
import { classicAddressToPkh } from "../core/classic-bch";
import { BCH_MAINNET_CIRCLE_SEND_ENABLED } from "../core/bch-mainnet-guard";
import {
  buildV2FeeMemberOrder,
  decodeV2FeeCircle,
  planV2FeeDeposit,
  planV2FeePayout,
  planV2FeeCancel,
  readV2FeeCircle,
  validateV2FeeCircleDraft,
  type V2FeeCircleParams,
} from "../core/v2-fee-bch";
import { MAINNET_PROJECT_TREASURY_ADDRESS } from "../core/project-treasury";
import { getV2FeeCircleRecordIdentity } from "../core/v2-fee-circle-records";
import { updateSavedCircleChainStatus } from "../circles/saved-circle-status";
import { wallet } from "../core/wizard-wallet";
import type { NetworkId } from "../core/network-config";
import {
  getCancellationDisabledReason,
  getDepositDisabledReason,
  getPayoutDisabledReason,
  shouldRenderCircleCreation,
} from "./mainnet-circle-lifecycle-ui";
import { useNoticeFade } from "./notice-display";
import { WorkspaceNotice } from "./WorkspaceNotice";
import { recallSnapshot, rememberSnapshot } from "./remembered-snapshots";

type Props = {
  network: NetworkId;
  walletConnected: boolean;
  selectedAddressPendingOnly?: boolean;
  onOpenWalletDetails: () => void;
  selectedCircle?: string | null;
  onBusyChange?: (busy: boolean) => void;
};

type Draft = { name: string; contribution: string; members: string[]; initiator?: string; maxFee: string; savedAt: number };
const STORAGE_KEY = "ajochain-blaze:bch-mainnet-circle-drafts:v1";
const ACTIVE_CIRCLE_KEY = "ajochain-blaze:bch-mainnet-circle-active:v1";
const DEPLOYED_KEY = "ajochain-blaze:bch-mainnet-circles-deployed:v1";
const INVITE_ROUTE = "#/bch-mainnet/";
export const BCH_MAINNET_CIRCLES_CHANGED_EVENT = "ajochain:bch-mainnet-circles-changed";

function readDeployedCircles(): V2FeeCircleParams[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(DEPLOYED_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
      try {
        const circle = decodeV2FeeCircle(String(entry));
        return circle.network === "mainnet" && circle.covenant === "fee-v3-auto-reserve-mainnet" ? [circle] : [];
      } catch { return []; }
    });
  } catch {
    return [];
  }
}

function addDeployedCircle(circle: V2FeeCircleParams): V2FeeCircleParams[] {
  const next = [circle, ...readDeployedCircles().filter((entry) => entry.stateCategory !== circle.stateCategory)].slice(0, 50);
  window.localStorage.setItem(DEPLOYED_KEY, JSON.stringify(next.map(encodeV2FeeCircleParams)));
  return next;
}
type StoredCircle = Omit<V2FeeCircleParams, "contribution" | "maxFee"> & {
  contribution: string;
  maxFee: string;
};
type MainnetSigningPlan = {
  wc: unknown;
  walletInputs: number[];
  prompt: string;
  createdAt: number;
  operation: "genesis" | "deposit" | "payout" | "cancel";
  circle: V2FeeCircleParams;
  memberIndex?: number;
};

function readActiveCircle(): V2FeeCircleParams | null {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(ACTIVE_CIRCLE_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.contribution !== "string" || typeof item.maxFee !== "string") return null;
    const circle = {
      ...item,
      contribution: BigInt(item.contribution),
      maxFee: BigInt(item.maxFee),
    } as unknown as V2FeeCircleParams;
    validateV2FeeCircleDraft(circle);
    return circle;
  } catch {
    return null;
  }
}

function persistActiveCircle(circle: V2FeeCircleParams) {
  const stored: StoredCircle = {
    ...circle,
    contribution: circle.contribution.toString(),
    maxFee: circle.maxFee.toString(),
  };
  window.localStorage.setItem(ACTIVE_CIRCLE_KEY, JSON.stringify(stored));
}

function sameMainnetAddress(left: string, right: string) {
  return Array.from(classicAddressToPkh(left, "mainnet")).join(",") ===
    Array.from(classicAddressToPkh(right, "mainnet")).join(",");
}


function readDrafts(): Draft[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item: unknown): item is Draft => {
      if (!item || typeof item !== "object") return false;
      const value = item as Record<string, unknown>;
      return typeof value.name === "string" &&
        typeof value.contribution === "string" &&
        Array.isArray(value.members) &&
        value.members.every((member: unknown) => typeof member === "string") &&
        typeof value.maxFee === "string" &&
        Number.isSafeInteger(value.savedAt);
    }).slice(0, 20);
  } catch {
    return [];
  }
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

export default function BchMainnetCircleWorkspace({ network, walletConnected, selectedAddressPendingOnly = false, onOpenWalletDetails, selectedCircle = null, onBusyChange }: Props) {
  const [name, setName] = useState(() => "BCH Ajo circle – " + new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" }));
  const [contribution, setContribution] = useState("0.002");
  const [membersText, setMembersText] = useState("");
  const [memberOrderErrorDismissed, setMemberOrderErrorDismissed] = useState(false);
  const [maxFee, setMaxFee] = useState("10000");
  const [drafts, setDrafts] = useState<Draft[]>(readDrafts);
  const [activeCircle, setActiveCircle] = useState<V2FeeCircleParams | null>(readActiveCircle);
  const activeCircleRef = useRef<V2FeeCircleParams | null>(activeCircle);
  activeCircleRef.current = activeCircle;
  const [, setDeployedCircles] = useState<V2FeeCircleParams[]>(readDeployedCircles);
  useEffect(() => {
    const refresh = () => setDeployedCircles(readDeployedCircles());
    window.addEventListener(BCH_MAINNET_CIRCLES_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(BCH_MAINNET_CIRCLES_CHANGED_EVENT, refresh);
  }, []);
  const [circleSnapshot, setCircleSnapshot] = useState<Awaited<ReturnType<typeof readV2FeeCircle>> | null>(null);
  // True when the last status check failed; any details shown are from an earlier check.
  const [snapshotStale, setSnapshotStale] = useState(false);
  const [depositAmount, setDepositAmount] = useState("0.002");
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [actionPreview, setActionPreview] = useState<{
    title: string; summary: string; feeEstimate: string; size: string; walletInputCount: number;
  } | null>(null);
  const [genesisSigningPlan, setGenesisSigningPlan] = useState<MainnetSigningPlan | null>(null);
  const [actionSigningPlan, setActionSigningPlan] = useState<MainnetSigningPlan | null>(null);
  const [creationResult, setCreationResult] = useState<{ txid: string; explorerUrl: string; inviteUrl: string } | null>(null);
  const [openCircleKey, setOpenCircleKey] = useState<string | null>(null);
  const autoStatusReadKeyRef = useRef<string | null>(null);
  const creationSummaryRef = useRef<HTMLDivElement>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useNoticeFade(notice, () => setNotice(""));
  const [testSignChecked, setTestSignChecked] = useState<"genesis" | "action" | null>(null);
  const [preview, setPreview] = useState<{
    contractAddress: string;
    stateCategory: string;
    feeEstimate: string;
    estimatedChange: string;
    inputCount: number;
    outputCount: number;
  } | null>(null);
  const isCircleOpen = Boolean(activeCircle && openCircleKey);
  const payoutDisabledReason = getPayoutDisabledReason({
    hasStatus: Boolean(circleSnapshot),
    walletConnected,
    payoutReady: Boolean(circleSnapshot?.ready),
  });
  const cancellationDisabledReason = getCancellationDisabledReason({
    hasStatus: Boolean(circleSnapshot),
    walletConnected,
    cancellationAllowed: Boolean(circleSnapshot && !circleSnapshot.hasPaid && circleSnapshot.round === 0),
  });
  const depositDisabledReason = getDepositDisabledReason(walletConnected);

  useEffect(() => {
    onBusyChange?.(busy || lifecycleBusy);
    return () => onBusyChange?.(false);
  }, [busy, lifecycleBusy, onBusyChange]);

  useEffect(() => {
    if (preview) creationSummaryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [preview]);

  useEffect(() => {
    if (!activeCircle || !walletConnected || wallet.state !== "connected") return;
    // Do not override an address the user explicitly synced from Selene's current Receive screen.
    if (wallet.isReceiveAddressConfirmed("mainnet")) return;
    const currentAddress = wallet.address("mainnet");
    if (currentAddress && activeCircle.members.some((member) => sameMainnetAddress(member, currentAddress))) return;
    // If the displayed address is not registered, match the circle's member
    // addresses against this wallet's receive xpub, initiator first.
    try {
      for (const memberAddress of activeCircle.members) {
        const matchedIndex = wallet.matchReceiveAddress(memberAddress, "mainnet", 250);
        if (matchedIndex !== null) {
          setNotice(
            "Your wallet matches Member " +
            (activeCircle.members.findIndex((member) => sameMainnetAddress(member, memberAddress)) + 1) +
            ".",
          );
          return;
        }
      }
    } catch {
      // An unrelated connected wallet remains an unregistered viewer.
    }
  }, [activeCircle?.stateCategory, walletConnected, wallet.state, wallet.receiveIndex]);

  const additionalMembers = useMemo(
    () => membersText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    [membersText],
  );
  const initiatorAddress = walletConnected && wallet.state === "connected" ? wallet.address("mainnet") : null;
  const initiatorAddressConfirmed = walletConnected && wallet.state === "connected" &&
    wallet.isReceiveAddressConfirmed("mainnet");
  const memberOrder = useMemo(() => {
    if (!initiatorAddress) return { members: [] as string[], error: "Connect Selene to register your address as Member 1." };
    if (!initiatorAddressConfirmed) return {
      members: [initiatorAddress, ...additionalMembers],
      error: "Pick the address shown in Selene first.",
    };
    try {
      return { members: buildV2FeeMemberOrder(initiatorAddress, additionalMembers, "mainnet"), error: "" };
    } catch (cause) {
      return { members: [initiatorAddress, ...additionalMembers], error: errorMessage(cause) };
    }
  }, [initiatorAddress, initiatorAddressConfirmed, additionalMembers]);
  const members = memberOrder.members;
  const economics = useMemo(() => {
    try {
      if (members.length < 2 || members.length > 5) return null;
      const amount = parseAssetAmount("BCH", contribution);
      const gross = BigInt(members.length) * amount;
      const fee = gross / 100n;
      const reserve = amount;
      return {
        gross,
        fee,
        reserve,
        firstPayout: gross - fee - reserve,
        finalPayout: gross - fee,
      };
    } catch {
      return null;
    }
  }, [members.length, contribution]);

  const saveDraft = () => {
    setError("");
    setNotice("");
    setPreview(null);
    try {
      if (network !== "mainnet") throw new Error("BCH Mainnet drafts can only be saved while the app is set to Mainnet.");
      if (!initiatorAddress) throw new Error("Connect Selene to register your address as Member 1.");
      if (!initiatorAddressConfirmed) throw new Error("Pick the address shown in Selene first.");
      if (memberOrder.error) throw new Error(memberOrder.error);
      if (!name.trim() || name.trim().length > 60) throw new Error("Enter a circle name between 1 and 60 characters.");
      if (members.length < 2 || members.length > 5) throw new Error("Add 1–4 other BCH Mainnet addresses. Your connected wallet is Member 1.");
      const units = parseAssetAmount("BCH", contribution);
      if (!/^\d+$/.test(maxFee.trim())) {
        throw new Error("Maximum miner fee must be a whole number of satoshis.");
      }
      createBchMainnetCircleDraft({
        version: 2,
        name: name.trim(),
        members,
        contribution: units,
        maxFee: BigInt(maxFee.trim()),
        initiator: initiatorAddress,
      });
      const draft: Draft = {
        name: name.trim(),
        contribution: formatAssetAmount("BCH", units),
        members,
        initiator: initiatorAddress,
        maxFee: maxFee.trim(),
        savedAt: Date.now(),
      };
      const next = [draft, ...drafts.filter((entry) =>
        entry.name !== draft.name || entry.contribution !== draft.contribution ||
        entry.members.join("|") !== draft.members.join("|"),
      )].slice(0, 20);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setDrafts(next);
      setNotice("Saved on this phone. Not a live circle yet.");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const restoreDraft = (draft: Draft) => {
    setName(draft.name);
    setContribution(draft.contribution);
    const savedInitiator = draft.initiator ?? draft.members[0];
    let creatorAddressBelongsToConnectedWallet = false;
    if (savedInitiator && walletConnected && wallet.state === "connected") {
      try {
        creatorAddressBelongsToConnectedWallet = wallet.matchReceiveAddress(savedInitiator, "mainnet", 250) !== null;
      } catch { /* leave the saved member list for manual review */ }
    }
    setMembersText((creatorAddressBelongsToConnectedWallet
      ? draft.members.filter((member) => !sameMainnetAddress(member, savedInitiator!))
      : draft.members).join("\n"));
    setMaxFee(draft.maxFee);
    setPreview(null);
    setError("");
    setNotice("Local draft loaded. Confirm the member addresses and prepare a fresh Mainnet preview.");
  };

  const persistChainProgress = (circle: V2FeeCircleParams, encoded: string, snapshot: Awaited<ReturnType<typeof readV2FeeCircle>>) => {
    const identity = getV2FeeCircleRecordIdentity(encoded);
    if (!identity) return;
    updateSavedCircleChainStatus(window.localStorage, {
      id: "v2:" + identity.key,
      encoded,
      network: "mainnet",
      kind: "bch-mainnet",
      name: circle.name,
      asset: "BCH",
      contribution: circle.contribution.toString(),
      memberCount: circle.members.length,
    }, snapshot.closedAs === "cancelled" ? "cancelled" : snapshot.completed ? "completed" : "active",
    snapshot.round, snapshot.completedAt ?? null);
  };

  const refreshCircleStatusQuietly = async (circle: V2FeeCircleParams) => {
    try {
      const snapshot = await readV2FeeCircle(circle);
      persistChainProgress(circle, encodeV2FeeCircleParams(circle), snapshot);
      rememberSnapshot(encodeV2FeeCircleParams(circle), snapshot);
      if (activeCircleRef.current === circle) {
        setCircleSnapshot((current) => current ? snapshot : current);
        setSnapshotStale(false);
      }
    } catch {
      // Best effort only; the manual Refresh button still works. Keep the
      // details on screen but say they may be out of date.
      if (activeCircleRef.current === circle) setSnapshotStale(true);
    }
  };

  const readActiveOnChainState = async () => {
    if (!activeCircle) return;
    setLifecycleBusy(true);
    setError("");
    setNotice("");
    setActionPreview(null);
    setActionSigningPlan(null);
    try {
      const snapshot = await readV2FeeCircle(activeCircle);
      setCircleSnapshot(snapshot);
      setSnapshotStale(false);
      rememberSnapshot(encodeV2FeeCircleParams(activeCircle), snapshot);
      persistChainProgress(activeCircle, encodeV2FeeCircleParams(activeCircle), snapshot);
      setNotice("Circle status updated.");
    } catch (cause) {
      // Keep the last good details (if any) and mark them as maybe out of date.
      setSnapshotStale(true);
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
      const memberIndex = activeCircle.members.findIndex((member) => sameMainnetAddress(member, address));
      if (memberIndex < 0) throw new Error("The connected wallet is not a registered member of this BCH circle.");
      const amount = parseAssetAmount("BCH", depositAmount);
      const plan = await planV2FeeDeposit(activeCircle, memberIndex, amount, address);
      setActionSigningPlan({
        wc: plan.wc, walletInputs: plan.walletInputs,
        prompt: "Verify BCH Mainnet member deposit for " + activeCircle.name,
        createdAt: Date.now(),
        operation: "deposit", circle: activeCircle, memberIndex,
      });
      setActionPreview({
        title: "Unsigned BCH member-deposit preview",
        summary: plan.wc ? "Member contribution plan prepared. It remains unsigned and will not be broadcast." : "No transaction plan was returned.",
        feeEstimate: (plan.feeEstimate ?? 0n).toString(),
        size: "Pending wallet serialization",
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
      setError("Connect a Mainnet fee-paying wallet in Selene first.");
      return;
    }
    setLifecycleBusy(true);
    setError("");
    setNotice("");
    setActionPreview(null);
    setActionSigningPlan(null);
    try {
      const plan = await planV2FeePayout(activeCircle, address);
      setActionSigningPlan({
        wc: plan.wc, walletInputs: plan.walletInputs,
        prompt: "Verify BCH Mainnet payout for " + activeCircle.name,
        createdAt: Date.now(),
        operation: "payout", circle: activeCircle,
      });
      setActionPreview({
        title: "Unsigned BCH payout preview",
        summary: "Payout plan prepared with the immutable 1% fee and member reserve rules. It remains unsigned and is not broadcast.",
        feeEstimate: plan.minerFee.toString(),
        size: "Pending wallet serialization",
        walletInputCount: plan.walletInputs.length,
      });
      setNotice("Payout plan prepared. No signature or broadcast was requested.");
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
      setError("Connect the registered Mainnet circle initiator in Selene first.");
      return;
    }
    setLifecycleBusy(true);
    setError("");
    setNotice("");
    setActionPreview(null);
    setActionSigningPlan(null);
    try {
      const plan = await planV2FeeCancel(activeCircle, address);
      setActionSigningPlan({
        wc: plan.wc, walletInputs: plan.walletInputs,
        prompt: "Verify BCH Mainnet pre-payout cancellation for " + activeCircle.name,
        createdAt: Date.now(),
        operation: "cancel", circle: activeCircle,
      });
      setActionPreview({
        title: "Unsigned pre-payout cancellation preview",
        summary: "Initiator cancellation/refund plan prepared. It remains unsigned and is not broadcast.",
        feeEstimate: plan.minerFee.toString(),
        size: "Pending wallet serialization",
        walletInputCount: plan.walletInputs.length,
      });
      setNotice("Cancellation plan prepared. No signature or broadcast was requested.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLifecycleBusy(false);
    }
  };

  const verifyMainnetSignature = async (target: "genesis" | "action", send = false, signingPlanOverride?: MainnetSigningPlan | null) => {
    const signingPlan = signingPlanOverride ?? (target === "genesis" ? genesisSigningPlan : actionSigningPlan);
    if (!signingPlan) return;
    if (network !== "mainnet" || !walletConnected || wallet.state !== "connected") {
      setError("Reconnect Selene on Mainnet first.");
      return;
    }
    if (Date.now() - signingPlan.createdAt > 60_000) {
      if (target === "genesis") setGenesisSigningPlan(null);
      else setActionSigningPlan(null);
      setError("This preview expired. Refresh it before signing.");
      return;
    }
    if (signingPlan.operation === "genesis") {
      if (selectedAddressPendingOnly) {
        setGenesisSigningPlan(null);
        setPreview(null);
        setError("Wait 1 confirmation, then create.");
        return;
      }
      const currentAddress = wallet.address("mainnet");
      if (!wallet.isReceiveAddressConfirmed("mainnet") || !currentAddress ||
          !sameMainnetAddress(currentAddress, signingPlan.circle.initiator)) {
        setGenesisSigningPlan(null);
        setPreview(null);
        setError("Selene's confirmed Mainnet receive address or connection changed after the preview. Sync the current address again and prepare a fresh circle preview.");
        return;
      }
    }
    setLifecycleBusy(true);
    setError("");
    setNotice("");
    setTestSignChecked(null);
    try {
      if (send && !BCH_MAINNET_CIRCLE_SEND_ENABLED) throw new Error("BCH Mainnet circle sending is locked.");
      const verified = await wallet.signAndVerify(
        signingPlan.wc,
        signingPlan.walletInputs,
        send ? signingPlan.prompt : signingPlan.prompt + " (local verification only; never broadcast)",
      );
      if (signingPlan.operation === "genesis") {
        const currentAddress = wallet.address("mainnet");
        if (!wallet.isReceiveAddressConfirmed("mainnet") || !currentAddress ||
            !sameMainnetAddress(currentAddress, signingPlan.circle.initiator)) {
          throw new Error("Selene's confirmed Mainnet address or connection changed after signing. The signed bytes were discarded and were not submitted. Sync the address and prepare a fresh preview.");
        }
      }
      const walletAddress = wallet.address("mainnet");
      if (!walletAddress) throw new Error("The connected Selene wallet no longer exposes its Mainnet address.");
      const verificationResponse = await fetch(send ? "/api/bch/broadcast" : "/api/bch/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: signingPlan.operation,
          circle: {
            version: signingPlan.circle.version,
            covenant: signingPlan.circle.covenant,
            network: signingPlan.circle.network,
            name: signingPlan.circle.name,
            members: signingPlan.circle.members,
            contribution: signingPlan.circle.contribution.toString(),
            maxFee: signingPlan.circle.maxFee.toString(),
            stateCategory: signingPlan.circle.stateCategory,
            initiator: signingPlan.circle.initiator,
            treasury: signingPlan.circle.treasury,
          },
          memberIndex: signingPlan.memberIndex,
          walletAddresses: [walletAddress],
          signedTransactionHex: verified.signedTransaction,
        }),
      });
      const verification = await verificationResponse.json().catch(() => null) as
        | { error?: string; verified?: boolean; broadcast?: boolean; txid?: string; inputCount?: number; outputCount?: number; message?: string }
        | null;
      if (!verificationResponse.ok) {
        throw new Error(verification?.error || "Independent BCH Mainnet server verification failed.");
      }
      if (!verification || verification.verified !== true || verification.broadcast !== send) {
        throw new Error(send
          ? "The network hasn't confirmed this payment yet. Check its status before trying again."
          : "The Mainnet server did not return a valid verification-only result. No transaction was broadcast.");
      }
      if (send) {
        if (signingPlan.operation === "deposit" || signingPlan.operation === "payout" || signingPlan.operation === "cancel") {
          window.dispatchEvent(new Event("ajochain:wallet-balances-changed"));
        }
        if (signingPlan.operation !== "genesis") {
          // Re-read the circle quietly so My circles moves it to Completed
          // (or Cancelled) without waiting for the next manual refresh.
          const sentCircle = signingPlan.circle;
          window.setTimeout(() => { void refreshCircleStatusQuietly(sentCircle); }, 3_000);
        }
        if (target === "genesis") setGenesisSigningPlan(null);
        else setActionSigningPlan(null);
        const sent = (verification.message || "Transaction sent.") + " Transaction: " + (verification.txid || "unknown");
        setNotice(sent);
        if (target === "genesis") {
          if (typeof verification.txid !== "string" || !/^[0-9a-f]{64}$/i.test(verification.txid)) {
            throw new Error("The Mainnet broadcast response did not include a valid transaction ID. The circle was not added to My circles.");
          }
          const inviteUrl = window.location.origin + window.location.pathname + INVITE_ROUTE + encodeV2FeeCircleParams(signingPlan.circle);
          setCreationResult({
            txid: verification.txid,
            explorerUrl: "https://blockexplorer.cash/mainnet/tx/" + verification.txid,
            inviteUrl,
          });
          setActiveCircle(signingPlan.circle);
          setOpenCircleKey("created:" + verification.txid);
          try {
            persistActiveCircle(signingPlan.circle);
            setDeployedCircles(addDeployedCircle(signingPlan.circle));
          } catch {
            setNotice(sent + ". The transaction was sent, but this browser could not save the circle locally. Its invite is shown below.");
          }
        }
        return;
      }
      if (target === "genesis") setGenesisSigningPlan(null);
      else setActionSigningPlan(null);
      setNotice(
        "Your Selene approval passed an independent check. Nothing was sent and no circle details changed.",
      );
      setTestSignChecked(target);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLifecycleBusy(false);
    }
  };

  const createCircleInSelene = async () => {
    let signingPlan = genesisSigningPlan;
    if (!signingPlan || Date.now() - signingPlan.createdAt > 60_000) {
      signingPlan = await prepareGenesisPlan();
    }
    if (!signingPlan) return;
    await verifyMainnetSignature("genesis", true, signingPlan);
  };

  const selectCircle = (circle: V2FeeCircleParams) => {
    setActiveCircle(circle);
    persistActiveCircle(circle);
    // Show what we read last time right away; the automatic check replaces it.
    setCircleSnapshot(recallSnapshot<Awaited<ReturnType<typeof readV2FeeCircle>>>(encodeV2FeeCircleParams(circle)));
    setSnapshotStale(false);
    setActionPreview(null);
    setActionSigningPlan(null);
    setGenesisSigningPlan(null);
    setPreview(null);
    setCreationResult(null);
    setOpenCircleKey(null);
    setError("");
  };

  useEffect(() => {
    if (!selectedCircle) return;
    try {
      const circle = decodeV2FeeCircle(selectedCircle);
      if (circle.network !== "mainnet" || circle.covenant !== "fee-v3-auto-reserve-mainnet") {
        throw new Error("This saved circle is not a BCH Mainnet circle.");
      }
      selectCircle(circle);
      setOpenCircleKey("selected:" + selectedCircle);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  // The selected-circle key changes when a different menu record is opened.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCircle]);

  const closeCircleAndCreateNew = () => {
    setOpenCircleKey(null);
    setActiveCircle(null);
    setCircleSnapshot(null);
    setSnapshotStale(false);
    setActionPreview(null);
    setActionSigningPlan(null);
    setGenesisSigningPlan(null);
    setPreview(null);
    setCreationResult(null);
    setError("");
    setNotice("");
  };

  const copyInvite = async () => {
    if (!activeCircle) return;
    const link = window.location.origin + window.location.pathname + INVITE_ROUTE + encodeV2FeeCircleParams(activeCircle);
    try {
      await navigator.clipboard.writeText(link);
      setNotice("Invite link copied. Share it with your circle members.");
    } catch {
      setNotice("Clipboard is unavailable. Invite link: " + link);
    }
  };

  const prepareGenesisPlan = async (): Promise<MainnetSigningPlan | null> => {
    setError("");
    setNotice("");
    setPreview(null);
    setGenesisSigningPlan(null);
    setActionSigningPlan(null);
    setCreationResult(null);

    if (network !== "mainnet") {
      setError("Switch to Mainnet to prepare this circle.");
      return null;
    }
    if (!walletConnected || wallet.state !== "connected") {
      setError("Connect Selene to continue.");
      return null;
    }
    const initiator = wallet.address("mainnet");
    if (!initiator) {
      setError("Pick the address shown in Selene first.");
      return null;
    }
    if (!initiatorAddressConfirmed) {
      setError("Pick the address shown in Selene in Wallet details first.");
      return null;
    }
    if (selectedAddressPendingOnly) {
      setError("Wait 1 confirmation, then create.");
      return null;
    }
    if (memberOrder.error) {
      setError(memberOrder.error);
      return null;
    }
    if (!/^\d+$/.test(maxFee.trim())) {
      setError("Maximum miner fee must be a whole number of satoshis.");
      return null;
    }
    setBusy(true);
    try {
      const amount = parseAssetAmount("BCH", contribution);
      const plan = await prepareBchMainnetCircleGenesisPreview({
        version: 2,
        name: name.trim(),
        members: buildV2FeeMemberOrder(initiator, additionalMembers, "mainnet"),
        contribution: amount,
        maxFee: BigInt(maxFee.trim()),
        initiator,
      }, initiator);
      if (!wallet.isReceiveAddressConfirmed("mainnet") ||
          wallet.address("mainnet") !== initiator) {
        throw new Error("Selene's Mainnet connection or receive address changed during preview preparation. Sync the address and prepare again.");
      }
      const signingPlan: MainnetSigningPlan = {
        wc: plan.wc, walletInputs: plan.walletInputs,
        prompt: "Verify BCH Mainnet circle setup for " + name.trim(),
        createdAt: Date.now(),
        operation: "genesis", circle: plan.params,
      };
      setGenesisSigningPlan(signingPlan);
      setCircleSnapshot(null);
    setSnapshotStale(false);
      setPreview({
        contractAddress: plan.contractAddress,
        stateCategory: plan.stateCategory,
        feeEstimate: plan.feeEstimate.toString(),
        estimatedChange: plan.estimatedChange.toString(),
        inputCount: plan.transactionInputCount,
        outputCount: plan.transactionOutputCount,
      });
      setNotice("BCH Mainnet circle setup preview prepared. Nothing has been signed or sent.");
      return signingPlan;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const prepare = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await prepareGenesisPlan();
  };

  return (
    <section className="pusd-mainnet-workspace section-card" aria-labelledby="bch-mainnet-title">
      {shouldRenderCircleCreation(isCircleOpen) && <>
      <div className="section-heading">
        <div>
          <span className="section-kicker">BITCOIN CASH · MAINNET SAVINGS</span>
          <h2 id="bch-mainnet-title">Create a BCH Mainnet circle</h2>
          <p>Tracks member payments, next-round reserves and a 1% fee.</p>
        </div>
        <span className="classic-network mainnet">Bitcoin Cash Mainnet</span>
      </div>



      {network !== "mainnet" && (
        <p className="classic-error" role="status">Switch to Mainnet to prepare this circle.</p>
      )}

      <form className="pusd-mainnet-form" onSubmit={(event) => void prepare(event)}>
        <label>Circle name
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required />
        </label>
        <label>Contribution per member (BCH)
          <input value={contribution} onChange={(event) => setContribution(event.target.value)} inputMode="decimal" placeholder="0.002" required />
          <small>Minimum 0.002 BCH. Up to 8 decimal places.</small>
        </label>
        <div className="creator-member-preview">
          <b>Member 1 · You, the initiator</b>
          {initiatorAddress
            ? <>
                <code>{initiatorAddress}</code>
                <button className="secondary-button wallet-copy-address" type="button" onClick={() => {
                  const pendingCopy = navigator.clipboard?.writeText(initiatorAddress);
                  if (!pendingCopy) { setNotice("Copy is unavailable. Select the address and copy it manually."); return; }
                  void pendingCopy.then(() => setNotice("Member 1 address copied."))
                    .catch(() => setNotice("Could not copy the address. Select it and copy manually."));
                }}><Copy size={15} /> Copy address</button>
                <small>{initiatorAddressConfirmed ? "Address confirmed ✓" : "Pick the address shown in Selene before using it."}</small>
              </>
            : "Connect Selene and sync the address currently shown on its Mainnet Receive screen. Your address will be added first automatically."}
          {initiatorAddress && !initiatorAddressConfirmed && (
            <button className="secondary-button" type="button" onClick={onOpenWalletDetails}>
              Open Wallet Details to sync Selene address
            </button>
          )}
        </div>
        <label>Other members' Mainnet addresses · one per line
          <textarea value={membersText} onChange={(event) => { setMembersText(event.target.value); setMemberOrderErrorDismissed(false); }} rows={4} placeholder={"bitcoincash:…\nbitcoincash:…"} required />
          <small>Add 1–4 Mainnet addresses. Your wallet is Member 1.</small>
        </label>
        {memberOrder.error && !memberOrderErrorDismissed && <div className="classic-error" role="alert">
          <span>{plainErrorSummary(memberOrder.error)}</span>
          <details className="technical-details"><summary>Details</summary><p>{memberOrder.error}</p></details>
          <button type="button" className="inline-dismiss" aria-label="Close error" onClick={() => setMemberOrderErrorDismissed(true)}>×</button>
        </div>}
        <label>Maximum BCH miner fee per action (satoshis)
          <input value={maxFee} onChange={(event) => setMaxFee(event.target.value)} inputMode="numeric" required />
          <small>Miner fees are separate from the pot.</small>
        </label>

        <div className="pusd-mainnet-treasury">
          <span>Immutable 1% project-fee destination shared with PUSD Mainnet</span>
          <code>{MAINNET_PROJECT_TREASURY_ADDRESS}</code>
        </div>

        {economics && (
          <div className="pusd-mainnet-breakdown">
            <b>Round payout rules preview</b>
            <div><span>Gross BCH pot</span><strong>{formatAssetAmount("BCH", economics.gross)} BCH</strong></div>
            <div><span>Project fee · 1%</span><strong>{formatAssetAmount("BCH", economics.fee)} BCH</strong></div>
            <div><span>Reserve for non-final recipient</span><strong>{formatAssetAmount("BCH", economics.reserve)} BCH</strong></div>
            <div><span>First recipient receives</span><strong>{formatAssetAmount("BCH", economics.firstPayout)} BCH</strong></div>
            <div><span>Final recipient receives · no reserve</span><strong>{formatAssetAmount("BCH", economics.finalPayout)} BCH</strong></div>
          </div>
        )}

        <div className="pusd-mainnet-actions">
          <button className="secondary-button" type="button" onClick={saveDraft} disabled={network !== "mainnet" || !walletConnected || !initiatorAddressConfirmed}>Save local draft</button>
        <button className="primary-button" type="submit" disabled={busy || network !== "mainnet" || !walletConnected || !initiatorAddressConfirmed || Boolean(memberOrder.error)}>
          {busy ? "Preparing circle setup…" : "Continue"} <ArrowRight size={15} />
        </button>
        </div>
        <small className="field-hint">Your address is Member 1. Others follow your chosen order.</small>
      </form>

      {preview && genesisSigningPlan && (
        <div ref={creationSummaryRef} className="pusd-mainnet-breakdown mainnet-create-summary" role="status">
          <b>Review your circle</b>
          <button type="button" className="primary-button mainnet-create-primary"
            disabled={lifecycleBusy || busy || !walletConnected || !BCH_MAINNET_CIRCLE_SEND_ENABLED || selectedAddressPendingOnly}
            onClick={() => void createCircleInSelene()}>
            {lifecycleBusy ? "Approve in Selene…" : "Create circle in Selene"}
          </button>
          <p className="receive-address-payout-note">Your payout goes to {genesisSigningPlan.circle.initiator.slice(0, 10)}…{genesisSigningPlan.circle.initiator.slice(-6)}.</p>
          {selectedAddressPendingOnly && <p className="receive-address-pending-warning" role="alert">Wait 1 confirmation, then create.</p>}
          <div><span>Members</span><strong>{genesisSigningPlan.circle.members.length}</strong></div>
          <div><span>Member 1 · payout address</span><strong><code>{genesisSigningPlan.circle.initiator}</code></strong></div>
          <div><span>Contribution per member</span><strong>{formatAssetAmount("BCH", genesisSigningPlan.circle.contribution)} BCH</strong></div>
          <div><span>Estimated network fee</span><strong>{preview.feeEstimate} sats</strong></div>
          <details className="technical-details">
            <summary>Technical details</summary>
            <div><span>Circle contract address</span><strong><code>{preview.contractAddress}</code></strong></div>
            <div><span>State CashToken category</span><strong><code>{preview.stateCategory}</code></strong></div>
            <div><span>Transaction shape</span><strong>{preview.inputCount} inputs · {preview.outputCount} outputs</strong></div>
            <div><span>Estimated change back to your wallet</span><strong>{preview.estimatedChange} sats</strong></div>
          </details>
          <TestSignControl planCreatedAt={genesisSigningPlan?.createdAt ?? null} disabled={lifecycleBusy || !walletConnected}
            checked={testSignChecked === "genesis"} onTest={() => void verifyMainnetSignature("genesis")} />
          <small>Saved after Mainnet returns a transaction ID.</small>
        </div>
      )}
      </>}
      {creationResult && (
        <div className="pusd-mainnet-breakdown mainnet-create-success" role="status">
          <b>Circle created</b>
          <p>Selene approved. Mainnet returned a transaction ID.</p>
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
            <div><span className="section-kicker">CIRCLE · BITCOIN CASH MAINNET</span><h3>{activeCircle.name}</h3></div>
            <div className="circle-lifecycle-toolbar">
              <button type="button" className="secondary-button circle-lifecycle-refresh" disabled={lifecycleBusy} onClick={() => void readActiveOnChainState()}>
                {lifecycleBusy ? "Checking…" : "Refresh status"}
              </button>
              <button type="button" className="secondary-button circle-lifecycle-new" onClick={closeCircleAndCreateNew}>Create a new circle</button>
            </div>
          </div>
          {!circleSnapshot && (snapshotStale && !lifecycleBusy
            ? <p className="classic-empty">Couldn't check this circle's status. Tap Refresh status to try again.</p>
            : <p className="classic-empty">Checking circle status…</p>)}
          {circleSnapshot && (snapshotStale
            ? <p className="field-hint refresh-stale-note" role="status">These details may be out of date. The latest check didn't finish, so this is the last result we have.</p>
            : lifecycleBusy
              ? <p className="field-hint refresh-stale-note checking" role="status">Showing the last details we read. Checking for updates…</p>
              : <p className="classic-empty">Circle details are up to date.</p>)}
          <button type="button" className="secondary-button" onClick={() => void copyInvite()}><Copy size={14} /> Copy invite</button>
          {circleSnapshot && (
            <div className="pusd-mainnet-breakdown">
              <b>Circle status</b>
              <div><span>Round</span><strong>{circleSnapshot.completed ? "Completed" : (circleSnapshot.round + 1) + " of " + activeCircle.members.length}</strong></div>
              <div><span>Next recipient</span><strong>{circleSnapshot.recipient ?? "None"}</strong></div>
              <div><span>Payout readiness</span><strong>{circleSnapshot.ready ? "Ready" : "Waiting for member credits"}</strong></div>
              {circleSnapshot.credits.map((credit, index) => (
                <div key={activeCircle.members[index]}><span>Member {index + 1} credit</span><strong>{formatAssetAmount("BCH", credit)} BCH</strong></div>
              ))}
            </div>
          )}
          <label>Deposit amount (BCH)
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
              <button type="button" className="secondary-button" disabled={lifecycleBusy || !walletConnected || !circleSnapshot || circleSnapshot.hasPaid || circleSnapshot.round !== 0} onClick={() => void prepareCancelPreview()}>Preview cancellation</button>
              {cancellationDisabledReason && <small className="lifecycle-action-reason">{cancellationDisabledReason}</small>}
            </div>
          </div>
          {actionPreview && (
            <div className="pusd-mainnet-breakdown" role="status">
              <b>{actionPreview.title}</b>
              <p>{actionPreview.summary}</p>
              <div><span>Estimated miner fee</span><strong>{actionPreview.feeEstimate} sats</strong></div>
              <div><span>Transaction size</span><strong>{actionPreview.size}</strong></div>
              <div><span>Wallet-owned inputs requiring signatures</span><strong>{actionPreview.walletInputCount}</strong></div>
              <small>Uses real BCH. Confirm inputs before signing.</small>
              <TestSignControl planCreatedAt={actionSigningPlan?.createdAt ?? null} disabled={lifecycleBusy || !walletConnected}
                checked={testSignChecked === "action"} onTest={() => void verifyMainnetSignature("action")} />
          {actionSigningPlan && BCH_MAINNET_CIRCLE_SEND_ENABLED && <button type="button" className="primary-button" disabled={lifecycleBusy || !walletConnected} onClick={() => void verifyMainnetSignature("action", true)}>Sign and send on Mainnet</button>}
            </div>
          )}
        </div>
      )}

      {error && <div className="classic-error" role="alert">
        <span>{plainErrorSummary(error)}</span>
        <details className="technical-details"><summary>Details</summary><p>{error}</p></details>
        <button type="button" className="inline-dismiss" aria-label="Close error" onClick={() => setError("")}>×</button>
      </div>}
      <WorkspaceNotice notice={notice} className="classic-notice" onClose={() => setNotice("")} />

      <div className="pusd-mainnet-saved">
        <div className="section-heading"><div><span className="section-kicker">NOT LIVE YET</span><h3>Saved for later</h3></div><small>{drafts.length} saved</small></div>
        {drafts.length === 0 ? <p className="classic-empty">Nothing saved for later on this phone.</p> : (
          <div className="classic-saved-list">
            {drafts.map((draft, index) => (
              <button type="button" className="classic-saved-item" key={draft.savedAt + ":" + index} onClick={() => restoreDraft(draft)}>
                <b>{draft.name}</b>
                <span>{draft.contribution} BCH · {draft.members.length} members</span>
                <small>Saved {new Date(draft.savedAt).toLocaleString()}</small>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="pusd-mainnet-build-status">
        <LockKeyhole size={16} />
        <span><b>Real BCH on Mainnet</b><small>Confirm each amount and fee in Selene.</small></span>
      </div>
    </section>
  );
}
