import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowRight, Copy, LockKeyhole, ShieldCheck } from "lucide-react";
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
import { updateSavedCircleProgress } from "../circles/saved-circle-status";
import { wallet } from "../core/wizard-wallet";
import type { NetworkId } from "../core/network-config";

type Props = {
  network: NetworkId;
  walletConnected: boolean;
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

export default function BchMainnetCircleWorkspace({ network, walletConnected, onOpenWalletDetails, selectedCircle = null, onBusyChange }: Props) {
  const [name, setName] = useState(() => "BCH Ajo circle – " + new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" }));
  const [contribution, setContribution] = useState("0.002");
  const [membersText, setMembersText] = useState("");
  const [maxFee, setMaxFee] = useState("10000");
  const [drafts, setDrafts] = useState<Draft[]>(readDrafts);
  const [activeCircle, setActiveCircle] = useState<V2FeeCircleParams | null>(readActiveCircle);
  const [deployedCircles, setDeployedCircles] = useState<V2FeeCircleParams[]>(readDeployedCircles);
  const [inviteInput, setInviteInput] = useState("");
  useEffect(() => {
    const refresh = () => setDeployedCircles(readDeployedCircles());
    window.addEventListener(BCH_MAINNET_CIRCLES_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(BCH_MAINNET_CIRCLES_CHANGED_EVENT, refresh);
  }, []);
  const [circleSnapshot, setCircleSnapshot] = useState<Awaited<ReturnType<typeof readV2FeeCircle>> | null>(null);
  const [depositAmount, setDepositAmount] = useState("0.002");
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [actionPreview, setActionPreview] = useState<{
    title: string; summary: string; feeEstimate: string; size: string; walletInputCount: number;
  } | null>(null);
  const [genesisSigningPlan, setGenesisSigningPlan] = useState<MainnetSigningPlan | null>(null);
  const [actionSigningPlan, setActionSigningPlan] = useState<MainnetSigningPlan | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<{
    contractAddress: string;
    stateCategory: string;
    feeEstimate: string;
    estimatedChange: string;
    inputCount: number;
    outputCount: number;
  } | null>(null);

  useEffect(() => {
    onBusyChange?.(busy || lifecycleBusy);
    return () => onBusyChange?.(false);
  }, [busy, lifecycleBusy, onBusyChange]);

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
            "Matched this Selene wallet to registered Member " +
            (activeCircle.members.findIndex((member) => sameMainnetAddress(member, memberAddress)) + 1) +
            " (receive index " + matchedIndex + ").",
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
      error: "Sync the Mainnet receive address currently shown in Selene under Wallet Details before creating a circle.",
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
      if (!initiatorAddressConfirmed) throw new Error("Sync the Mainnet receive address currently shown in Selene under Wallet Details before saving or creating this circle.");
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
      setNotice("BCH Mainnet draft saved on this browser only. It is not an on-chain circle.");
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
    updateSavedCircleProgress(window.localStorage, {
      id: "v2:" + identity.key,
      encoded,
      network: "mainnet",
      kind: "bch-mainnet",
      name: circle.name,
      asset: "BCH",
      contribution: circle.contribution.toString(),
      memberCount: circle.members.length,
    }, snapshot.round, snapshot.completed);
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
      persistChainProgress(activeCircle, encodeV2FeeCircleParams(activeCircle), snapshot);
      setNotice("BCH Mainnet circle details checked on the blockchain. This is a read-only status check.");
    } catch (cause) {
      setCircleSnapshot(null);
      setError(errorMessage(cause));
    } finally {
      setLifecycleBusy(false);
    }
  };

  const prepareDepositPreview = async () => {
    if (!activeCircle) return;
    const address = wallet.address("mainnet");
    if (!walletConnected || wallet.state !== "connected" || !address) {
      setError("Connect the Mainnet member wallet through WizardConnect first.");
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
      setError("Connect a Mainnet fee-paying wallet through WizardConnect first.");
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
      setError("Connect the registered Mainnet circle initiator through WizardConnect first.");
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

  const verifyMainnetSignature = async (target: "genesis" | "action", send = false) => {
    const signingPlan = target === "genesis" ? genesisSigningPlan : actionSigningPlan;
    if (!signingPlan) return;
    if (network !== "mainnet" || !walletConnected || wallet.state !== "connected") {
      setError("Reconnect Selene on BCH Mainnet before starting signature verification.");
      return;
    }
    if (Date.now() - signingPlan.createdAt > 60_000) {
      if (target === "genesis") setGenesisSigningPlan(null);
      else setActionSigningPlan(null);
      setError("This signed-transaction review plan is older than 60 seconds. Refresh the chain preview and prepare a new plan before asking Selene to sign.");
      return;
    }
    if (signingPlan.operation === "genesis") {
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
          ? "The Mainnet server did not confirm the relay. Check the transaction ID before retrying."
          : "The Mainnet server did not return a valid verification-only result. No transaction was broadcast.");
      }
      if (send) {
        if (target === "genesis") setGenesisSigningPlan(null);
        else setActionSigningPlan(null);
        const sent = (verification.message || "Transaction sent.") + " Transaction: " + (verification.txid || "unknown");
        setNotice(sent);
        if (target === "genesis") {
          try {
            setDeployedCircles(addDeployedCircle(signingPlan.circle));
          } catch {
            setNotice(sent + ". This browser could not add it to the saved circle list; copy the invite now to keep it.");
          }
        }
        return;
      }
      if (target === "genesis") setGenesisSigningPlan(null);
      else setActionSigningPlan(null);
      setNotice(
        "Your Selene approval passed an independent check. Nothing was sent and no circle details changed.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLifecycleBusy(false);
    }
  };

  const selectCircle = (circle: V2FeeCircleParams) => {
    setActiveCircle(circle);
    persistActiveCircle(circle);
    setCircleSnapshot(null);
    setActionPreview(null);
    setActionSigningPlan(null);
    setGenesisSigningPlan(null);
    setPreview(null);
    setError("");
  };

  useEffect(() => {
    if (!selectedCircle) return;
    let current = true;
    try {
      const circle = decodeV2FeeCircle(selectedCircle);
      if (circle.network !== "mainnet" || circle.covenant !== "fee-v3-auto-reserve-mainnet") {
        throw new Error("This saved circle is not a BCH Mainnet circle.");
      }
      selectCircle(circle);
      void readV2FeeCircle(circle).then((snapshot) => {
        if (!current) return;
        setCircleSnapshot(snapshot);
        persistChainProgress(circle, selectedCircle, snapshot);
      }).catch((cause: unknown) => {
        if (current) setError(errorMessage(cause));
      });
    } catch (cause) {
      setError(errorMessage(cause));
    }
    return () => { current = false; };
  // The selected-circle key changes when a different menu record is opened.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCircle]);

  const importInvite = (text: string) => {
    setError("");
    setNotice("");
    try {
      const candidate = text.trim();
      const match = candidate.match(/#\/bch-mainnet\/([A-Za-z0-9_-]+)/) ?? candidate.match(/^([A-Za-z0-9_-]{8,})$/);
      if (!match) throw new Error("Paste a BCH Mainnet circle invite link.");
      const circle = decodeV2FeeCircle(match[1]);
      if (circle.network !== "mainnet" || circle.covenant !== "fee-v3-auto-reserve-mainnet") {
        throw new Error("This invite is not for a BCH Mainnet V3 circle.");
      }
      setDeployedCircles(addDeployedCircle(circle));
      selectCircle(circle);
      setInviteInput("");
      setNotice("Circle added from the invite. Read its on-chain status before paying.");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const joinWithInvite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    importInvite(inviteInput);
  };

  useEffect(() => {
    const fromHash = () => {
      if (window.location.hash.startsWith(INVITE_ROUTE)) importInvite(window.location.hash);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  const copyInvite = async () => {
    if (!activeCircle) return;
    const link = window.location.origin + window.location.pathname + INVITE_ROUTE + encodeV2FeeCircleParams(activeCircle);
    try {
      await navigator.clipboard.writeText(link);
      setNotice("Invite link copied. Members paste it under Join a circle with an invite link.");
    } catch {
      setNotice("Clipboard is unavailable. Invite link: " + link);
    }
  };

  const prepare = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setNotice("");
    setPreview(null);
    setGenesisSigningPlan(null);
    setActionSigningPlan(null);

    if (network !== "mainnet") {
      setError("Switch the app to Bitcoin Cash Mainnet. This V3 BCH circle uses the shared Mainnet fee treasury.");
      return;
    }
    if (!walletConnected || wallet.state !== "connected") {
      setError("Connect Selene through WizardConnect before preparing the circle setup preview.");
      return;
    }
    const initiator = wallet.address("mainnet");
    if (!initiator) {
      setError("No verified Mainnet receive address is available from the connected wallet. Match Selene's current receive address in Wallet Details first.");
      return;
    }
    if (!initiatorAddressConfirmed) {
      setError("Sync the Mainnet receive address currently shown in Selene under Wallet Details before preparing the circle.");
      return;
    }
    if (memberOrder.error) {
      setError(memberOrder.error);
      return;
    }
    if (!/^\d+$/.test(maxFee.trim())) {
      setError("Maximum miner fee must be a whole number of satoshis.");
      return;
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
      setGenesisSigningPlan({
        wc: plan.wc, walletInputs: plan.walletInputs,
        prompt: "Verify BCH Mainnet circle setup for " + name.trim(),
        createdAt: Date.now(),
        operation: "genesis", circle: plan.params,
      });
      setActiveCircle(plan.params);
      persistActiveCircle(plan.params);
      setCircleSnapshot(null);
      setPreview({
        contractAddress: plan.contractAddress,
        stateCategory: plan.stateCategory,
        feeEstimate: plan.feeEstimate.toString(),
        estimatedChange: plan.estimatedChange.toString(),
        inputCount: plan.transactionInputCount,
        outputCount: plan.transactionOutputCount,
      });
      setNotice("BCH Mainnet circle setup preview prepared. Use Sign and send on Mainnet to create the circle with real BCH.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pusd-mainnet-workspace section-card" aria-labelledby="bch-mainnet-title">
      <div className="section-heading">
        <div>
          <span className="section-kicker">BITCOIN CASH · MAINNET SAVINGS</span>
          <h2 id="bch-mainnet-title">Create a BCH Mainnet circle</h2>
          <p>Member-specific contribution records, a next-round reserve for each non-final recipient, and a fixed 1% project fee.</p>
        </div>
        <span className="classic-network mainnet">Bitcoin Cash Mainnet</span>
      </div>

      <div className="pusd-mainnet-safety">
        <div><ShieldCheck size={17} /><span><b>Mainnet circle rules selected</b><small>Separate Mainnet circle · not the older Chipnet circle</small></span></div>
        <span className="asset-state neutral">Real BCH · circle rules not audited</span>
      </div>

      {network !== "mainnet" && (
        <p className="classic-error" role="status">Switch the app network to Bitcoin Cash Mainnet to prepare this circle. The Chipnet workspace remains separate below.</p>
      )}

      <form className="pusd-mainnet-form" onSubmit={(event) => void prepare(event)}>
        <label>Circle name
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required />
        </label>
        <label>Contribution per member (BCH)
          <input value={contribution} onChange={(event) => setContribution(event.target.value)} inputMode="decimal" placeholder="0.002" required />
          <small>Minimum 0.002 BCH per member, per scheduled round. Up to 8 decimal places.</small>
        </label>
        <div className="creator-member-preview">
          <b>Member 1 · You, the initiator</b>
          {initiatorAddress
            ? <><code>{initiatorAddress}</code><small>{initiatorAddressConfirmed ? "Confirmed from Selene's current Receive screen" : "Candidate address derived from this connected wallet · not yet matched to Selene's displayed Receive address"}</small></>
            : "Connect Selene and sync the address currently shown on its Mainnet Receive screen. Your address will be added first automatically."}
          {initiatorAddress && !initiatorAddressConfirmed && (
            <button className="secondary-button" type="button" onClick={onOpenWalletDetails}>
              Open Wallet Details to sync Selene address
            </button>
          )}
        </div>
        <label>Other members' Mainnet addresses · one per line
          <textarea value={membersText} onChange={(event) => setMembersText(event.target.value)} rows={4} placeholder={"bitcoincash:…\nbitcoincash:…"} required />
          <small>Add 1–4 other unique Bitcoin Cash Mainnet P2PKH or token-aware P2PKH addresses. Your connected Selene address is always Member 1.</small>
        </label>
        {memberOrder.error && <p className="classic-error" role="alert">{memberOrder.error}</p>}
        <label>Maximum BCH miner fee per action (satoshis)
          <input value={maxFee} onChange={(event) => setMaxFee(event.target.value)} inputMode="numeric" required />
          <small>Miner fees are funded separately from the member pot and the 1% project fee.</small>
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
          {busy ? "Preparing circle setup…" : "Preview circle setup"} <ArrowRight size={15} />
        </button>
        </div>
        <small className="field-hint">Member order is fixed at creation: your connected Mainnet address is Member 1, followed by the addresses above. Each address is a specific receive key from a wallet seed, so use the address currently shown by Selene before creating the circle.</small>
      </form>

      {preview && (
        <div className="pusd-mainnet-breakdown" role="status">
          <b>Circle setup preview</b>
          <p className="field-hint">Review the estimated network fee and change before you continue. Nothing has been signed or sent.</p>
          <div><span>Estimated network fee</span><strong>{preview.feeEstimate} sats</strong></div>
          <div><span>Estimated change back to your wallet</span><strong>{preview.estimatedChange} sats</strong></div>
          <details className="technical-details">
            <summary>Technical details</summary>
            <div><span>Circle contract address</span><strong><code>{preview.contractAddress}</code></strong></div>
            <div><span>State CashToken category</span><strong><code>{preview.stateCategory}</code></strong></div>
            <div><span>Transaction shape</span><strong>{preview.inputCount} inputs · {preview.outputCount} outputs</strong></div>
          </details>
          <small>Nothing has been sent or created yet.</small>
          {genesisSigningPlan && <button type="button" className="secondary-button" disabled={lifecycleBusy || !walletConnected} onClick={() => void verifyMainnetSignature("genesis")}>Check Selene approval · no payment</button>}
          {genesisSigningPlan && BCH_MAINNET_CIRCLE_SEND_ENABLED && <button type="button" className="primary-button" disabled={lifecycleBusy || !walletConnected} onClick={() => void verifyMainnetSignature("genesis", true)}>Sign and send on Mainnet</button>}
        </div>
      )}
      {activeCircle && (
        <div className="pusd-mainnet-saved">
          <div className="section-heading">
            <div><span className="section-kicker">CIRCLE LIFECYCLE · MAINNET READ-ONLY</span><h3>{activeCircle.name}</h3></div>
            <button type="button" className="secondary-button" disabled={lifecycleBusy} onClick={() => void readActiveOnChainState()}>
              {lifecycleBusy ? "Checking…" : "Check circle status"}
            </button>
          </div>
          <p className="classic-empty">Local circle identity saved for tracking. A saved setup preview does not mean the circle has been created on the blockchain.</p>
          <button type="button" className="secondary-button" onClick={() => void copyInvite()}><Copy size={14} /> Copy invite</button>
          {circleSnapshot && (
            <div className="pusd-mainnet-breakdown">
              <b>Verified circle state</b>
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
            <button type="button" className="secondary-button" disabled={lifecycleBusy || !walletConnected} onClick={() => void prepareDepositPreview()}>Preview member deposit</button>
            <button type="button" className="secondary-button" disabled={lifecycleBusy || !walletConnected || !circleSnapshot?.ready} onClick={() => void preparePayoutPreview()}>Preview payout</button>
            <button type="button" className="secondary-button" disabled={lifecycleBusy || !walletConnected || !circleSnapshot || circleSnapshot.hasPaid || circleSnapshot.round !== 0} onClick={() => void prepareCancelPreview()}>Preview cancellation</button>
          </div>
          {actionPreview && (
            <div className="pusd-mainnet-breakdown" role="status">
              <b>{actionPreview.title}</b>
              <p>{actionPreview.summary}</p>
              <div><span>Estimated miner fee</span><strong>{actionPreview.feeEstimate} sats</strong></div>
              <div><span>Transaction size</span><strong>{actionPreview.size}</strong></div>
              <div><span>Wallet-owned inputs requiring signatures</span><strong>{actionPreview.walletInputCount}</strong></div>
              <small>Sign and send uses real BCH. Re-read state before each new action; inputs must be confirmed.</small>
              {actionSigningPlan && <button type="button" className="secondary-button" disabled={lifecycleBusy || !walletConnected} onClick={() => void verifyMainnetSignature("action")}>Verify Selene signature · no broadcast</button>}
          {actionSigningPlan && BCH_MAINNET_CIRCLE_SEND_ENABLED && <button type="button" className="primary-button" disabled={lifecycleBusy || !walletConnected} onClick={() => void verifyMainnetSignature("action", true)}>Sign and send on Mainnet</button>}
            </div>
          )}
        </div>
      )}

      {error && <p className="classic-error" role="alert">{error}</p>}
      {notice && <p className="classic-notice" role="status">{notice}</p>}

      <div className="pusd-mainnet-saved">
        <div className="section-heading"><div><span className="section-kicker">INVITE</span><h3>Add an existing BCH Mainnet circle</h3></div></div>
        <form className="classic-form" onSubmit={joinWithInvite}>
          <label>Circle invite link<input value={inviteInput} onChange={(event) => setInviteInput(event.target.value)} placeholder="Paste circle invite link" /></label>
          <button type="submit" className="secondary-button" disabled={!inviteInput.trim()}>Add circle</button>
        </form>
        <p className="classic-empty">Saved circles appear in My circles, grouped by the selected network.</p>
      </div>

      <div className="pusd-mainnet-saved">
        <div className="section-heading"><div><span className="section-kicker">LOCAL DRAFTS</span><h3>Saved BCH Mainnet circles</h3></div><small>{drafts.length} saved</small></div>
        {drafts.length === 0 ? <p className="classic-empty">No BCH Mainnet drafts saved on this browser.</p> : (
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
        <span><b>Real BCH on Mainnet</b><small>Every transaction is checked by the server (exact transaction intent, 0x61 sighashes, confirmed inputs, BCH 2026 VM) before it is sent once. The contract has not had an independent human audit. Start with small amounts.</small></span>
      </div>
    </section>
  );
}
