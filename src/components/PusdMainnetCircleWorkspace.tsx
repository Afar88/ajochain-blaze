import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowRight, LockKeyhole, ShieldCheck } from "lucide-react";
import { PUSD_ASSET, formatAssetAmount, parseAssetAmount } from "../core/assets";
import { classicAddressToPkh } from "../core/classic-bch";
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

type Props = { network: NetworkId; walletConnected: boolean; selectedCircle?: string | null };
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

function decodeCircleInvite(value: string): PusdMainnetCircleParams {
  const trimmed = value.trim();
  const marker = trimmed.indexOf(INVITE_ROUTE);
  const encoded = marker >= 0 ? trimmed.slice(marker + INVITE_ROUTE.length) : trimmed;
  const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const circle = deserializeCircle(new TextDecoder().decode(bytes));
  if (!circle || circle.network !== "mainnet" || circle.version !== 3) {
    throw new Error("This invite is not for a PUSD Mainnet V3 circle.");
  }
  return circle;
}

function persistActiveCircle(circle: PusdMainnetCircleParams) {
  const stored: StoredCircle = {
    ...circle,
    contribution: circle.contribution.toString(),
    maxFee: circle.maxFee.toString(),
  };
  window.localStorage.setItem(ACTIVE_CIRCLE_KEY, JSON.stringify(stored));
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

export default function PusdMainnetCircleWorkspace({ network, walletConnected, selectedCircle = null }: Props) {
  const [name, setName] = useState(() => "PUSD Ajo circle – " + new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" }));
  const [contribution, setContribution] = useState("10.00");
  const [membersText, setMembersText] = useState("");
  const [maxFee, setMaxFee] = useState("20000");
  const [drafts, setDrafts] = useState<Draft[]>(readDrafts);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
  const [deployedCircles, setDeployedCircles] = useState<PusdMainnetCircleParams[]>(readDeployedCircles);
  const [inviteInput, setInviteInput] = useState("");

  useEffect(() => {
    if (!selectedCircle) return;
    const circle = deserializeCircle(selectedCircle);
    if (!circle) {
      setError("This saved PUSD circle could not be opened.");
      return;
    }
    setActiveCircle(circle);
    persistActiveCircle(circle);
    setCircleSnapshot(null);
    setGenesisSigningPlan(null);
    setActionSigningPlan(null);
    setNotice("Opened " + circle.name + ". Check the circle details before taking action.");
  }, [selectedCircle]);
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith(INVITE_ROUTE)) return;
    try {
      const circle = decodeCircleInvite(hash);
      setActiveCircle(circle);
      persistActiveCircle(circle);
      setDeployedCircles(addDeployedCircle(circle));
      setCircleSnapshot(null);
      setGenesisSigningPlan(null);
      setActionSigningPlan(null);
      setNotice("PUSD Mainnet circle invite loaded. Check the circle on the blockchain before acting.");
    } catch {
      setError("This link is not a valid PUSD Mainnet V3 circle invite.");
    }
  }, []);

  const memberAddresses = useMemo(() =>
    membersText.split(/\r?\n/).map((address) => address.trim()).filter(Boolean),
  [membersText]);

  const economics = useMemo(() => {
    try {
      if (memberAddresses.length < MIN_CIRCLE_MEMBERS || memberAddresses.length > MAX_CIRCLE_MEMBERS) return null;
      return calculatePusdCircleEconomics(memberAddresses.length, parseAssetAmount("PUSD", contribution));
    } catch {
      return null;
    }
  }, [memberAddresses, contribution]);

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
      if (memberAddresses.length < 2 || memberAddresses.length > 5) {
        throw new Error("Enter 2–5 member token-aware Bitcoin Cash Mainnet addresses, one per line.");
      }
      const keys = memberAddresses.map(addressKey);
      if (new Set(keys).size !== keys.length) {
        throw new Error("Every member must have a unique Mainnet address.");
      }
      const units = parseAssetAmount("PUSD", contribution);
      calculatePusdCircleEconomics(memberAddresses.length, units);
      if (!/^\d+$/.test(maxFee.trim()) || BigInt(maxFee.trim()) < 1000n) {
        throw new Error("Maximum BCH miner fee must be at least 1,000 whole satoshis.");
      }

      const draft: Draft = {
        name: name.trim(),
        contribution: units.toString(),
        members: memberAddresses,
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

  const prepareCreationPlan = async () => {
    setNotice("");
    setError("");
    setPreparedPlan(null);
    setGenesisSigningPlan(null);
    setActionSigningPlan(null);
    if (network !== "mainnet") {
      setError("PUSD circle creation plans are Mainnet-only.");
      return;
    }
    if (!walletConnected || wallet.state !== "connected") {
      setError("Connect Selene through WizardConnect before preparing a Mainnet creation plan.");
      return;
    }
    const initiatorAddress = wallet.address("mainnet");
    if (!initiatorAddress) {
      setError("The connected wallet does not expose a verified Mainnet receive address.");
      return;
    }
    setBusy(true);
    try {
      const units = parseAssetAmount("PUSD", contribution);
      const plan = await planPusdMainnetCircleGenesis({
        name: name.trim(),
        members: memberAddresses,
        contribution: units,
        maxFee: BigInt(maxFee.trim()),
      }, initiatorAddress);
      setGenesisSigningPlan({
        wc: plan.wc, walletInputs: plan.walletInputs,
        prompt: "Check PUSD Mainnet circle setup for " + name.trim(),
        createdAt: Date.now(),
        operation: "genesis",
        circle: plan.params,
      });
      setActiveCircle(plan.params);
      persistActiveCircle(plan.params);
      setCircleSnapshot(null);
      setPreparedPlan({
        contractAddress: plan.contractAddress!,
        escrowAddresses: plan.escrowAddresses ?? [],
        feeEstimate: plan.feeEstimate.toString(),
        transactionSizeBytes: plan.transactionSizeBytes,
      });
      setNotice("PUSD circle setup preview ready. Nothing has been signed or sent.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const verifyMainnetSignature = async (target: "genesis" | "action", send = false) => {
    const signingPlan = target === "genesis" ? genesisSigningPlan : actionSigningPlan;
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
    setLifecycleBusy(true);
    setError("");
    setNotice("");
    try {
      const walletAddress = wallet.address("mainnet");
      if (!walletAddress) throw new Error("The connected Selene session does not expose a Mainnet P2PKH signing address.");
      const locallyVerified = await wallet.signAndVerify(
        signingPlan.wc,
        signingPlan.walletInputs,
        signingPlan.prompt + (send ? " (verify and relay on BCH Mainnet)" : " (independent server verification only; never broadcast)"),
      );
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
        if (target === "genesis") setGenesisSigningPlan(null);
        else setActionSigningPlan(null);
        const sent =
          "PUSD Mainnet " + signingPlan.operation + " transaction sent. Transaction: " +
          relayed.txid + " (relay: " + relayed.relayStatus + "). It is not confirmed yet; refresh the circle state after it confirms.";
        setNotice(sent);
        if (target === "genesis") {
          try {
            setDeployedCircles(addDeployedCircle(signingPlan.circle));
          } catch {
            setNotice(sent + " This browser could not add it to the saved circle list; copy the invite now to keep it.");
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
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLifecycleBusy(false);
    }
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
      setNotice("Mainnet circle details checked on the blockchain. This is a read-only status check.");
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
      setError("Connect a wallet to sponsor the payout miner fee through WizardConnect first.");
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
      setError("Connect the registered circle initiator wallet through WizardConnect first.");
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

  const restore = (draft: Draft) => {
    setName(draft.name);
    setContribution(formatAssetAmount("PUSD", BigInt(draft.contribution)));
    setMembersText(draft.members.join("\n"));
    setMaxFee(draft.maxFeeSatoshis);
    setNotice("Draft loaded. Review member addresses and amounts before preparing the Mainnet transaction plan.");
    setError("");
  };

  return (
    <section className="pusd-mainnet-workspace section-card" aria-labelledby="pusd-mainnet-title">
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
        <label>Member Mainnet BCH addresses · one per line
          <textarea value={membersText} onChange={(event) => setMembersText(event.target.value)} rows={4} placeholder={"bitcoincash:…\nbitcoincash:…"} required />
          <small>Add 2–5 unique Bitcoin Cash Mainnet addresses that can receive PUSD, in payout order. Your connected Selene address is always first.</small>
        </label>
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
            {busy ? "Preparing preview…" : "Preview circle setup"} <ArrowRight size={15} />
          </button>
        </div>
      </form>

      {preparedPlan && (
        <div className="pusd-mainnet-breakdown" role="status">
          <b>Circle setup preview ready</b>
          <p className="field-hint">Review the estimated network fee. Nothing has been signed or sent yet.</p>
          <div><span>Estimated BCH network fee</span><strong>{preparedPlan.feeEstimate} sats</strong></div>
          <details className="technical-details">
            <summary>Technical details</summary>
            <div><span>PUSD circle contract address</span><strong><code>{preparedPlan.contractAddress}</code></strong></div>
            {preparedPlan.escrowAddresses.map((address, index) => (
              <div key={address}><span>Member {index + 1} escrow address</span><strong><code>{address}</code></strong></div>
            ))}
            <p>Estimated transaction size: {preparedPlan.transactionSizeBytes} bytes.</p>
          </details>
          <small>Nothing has been created or paid yet.</small>
          {genesisSigningPlan && <button type="button" className="secondary-button" disabled={lifecycleBusy || !walletConnected} onClick={() => void verifyMainnetSignature("genesis")}>Check Selene approval · no payment</button>}
          {genesisSigningPlan && <button type="button" className="primary-button" disabled={lifecycleBusy || !walletConnected} onClick={() => void verifyMainnetSignature("genesis", true)}>Sign and send on Mainnet</button>}
        </div>
      )}
      {activeCircle && (
        <div className="pusd-mainnet-saved">
          <div className="section-heading">
            <div><span className="section-kicker">YOUR PUSD CIRCLE</span><h3>{activeCircle.name}</h3></div>
            <button type="button" className="secondary-button" disabled={lifecycleBusy} onClick={() => void readActiveOnChainState()}>
              {lifecycleBusy ? "Checking…" : "Check circle status"}
            </button>
          </div>
          <p className="classic-empty">Local circle identity saved for tracking. A saved setup preview does not mean the circle has been created on the blockchain.</p>
          {circleSnapshot && (
            <div className="pusd-mainnet-breakdown">
              <b>Verified circle state</b>
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
            <button type="button" className="secondary-button" disabled={lifecycleBusy || !walletConnected} onClick={() => void prepareDepositPreview()}>Preview member deposit</button>
            <button type="button" className="secondary-button" disabled={lifecycleBusy || !walletConnected || !circleSnapshot?.ready} onClick={() => void preparePayoutPreview()}>Preview payout</button>
            <button type="button" className="secondary-button" disabled={lifecycleBusy || !walletConnected || !circleSnapshot || circleSnapshot.round !== 0 || circleSnapshot.completed} onClick={() => void prepareCancelPreview()}>Preview cancellation</button>
          </div>
          {actionPreview && (
            <div className="pusd-mainnet-breakdown" role="status">
              <b>{actionPreview.title}</b>
              <p>{actionPreview.summary}</p>
              <div><span>Estimated BCH network fee</span><strong>{actionPreview.feeEstimate} sats</strong></div>
              <details className="technical-details">
                <summary>Technical details</summary>
                <p>Estimated transaction size: {actionPreview.size} bytes. Wallet items to approve: {actionPreview.walletInputCount}.</p>
                <p>Payments are checked before they are sent. Check circle status again before each new action.</p>
              </details>
              {actionSigningPlan && <button type="button" className="secondary-button" disabled={lifecycleBusy || !walletConnected} onClick={() => void verifyMainnetSignature("action")}>Check Selene approval · no payment</button>}
              {actionSigningPlan && <button type="button" className="primary-button" disabled={lifecycleBusy || !walletConnected} onClick={() => void verifyMainnetSignature("action", true)}>Sign and send on Mainnet</button>}
            </div>
          )}       </div>
      )}

      {error && <p className="classic-error" role="alert">{error}</p>}
      {notice && <p className="classic-notice" role="status">{notice}</p>}

      {activeCircle && (
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

      <div className="pusd-mainnet-deployed">
        <div className="section-heading"><div><span className="section-kicker">SAVED CIRCLES</span><h3>PUSD circles on Mainnet</h3></div></div>
        <div className="pusd-mainnet-invite-import">
          <input value={inviteInput} onChange={(event) => setInviteInput(event.target.value)} placeholder="Paste a PUSD Mainnet circle invite" autoComplete="off" />
          <button type="button" className="secondary-button" onClick={() => {
            try {
              const circle = decodeCircleInvite(inviteInput);
              setActiveCircle(circle);
              persistActiveCircle(circle);
              setDeployedCircles(addDeployedCircle(circle));
              setCircleSnapshot(null);
              setGenesisSigningPlan(null);
              setActionSigningPlan(null);
              setInviteInput("");
              setNotice("PUSD Mainnet circle invite loaded. Check the circle on the blockchain before acting.");
            } catch (cause) {
              setError(errorMessage(cause));
            }
          }}>Import invite</button>
        </div>
        {deployedCircles.length === 0 ? <p className="classic-empty">No deployed PUSD circles saved on this browser.</p> : (
          <div className="classic-saved-list">
            {deployedCircles.map((circle) => (
              <button type="button" className="classic-saved-item" key={circle.stateCategory} onClick={() => {
                setActiveCircle(circle);
                persistActiveCircle(circle);
                setCircleSnapshot(null);
                setGenesisSigningPlan(null);
                setActionSigningPlan(null);
                setNotice("Opened " + circle.name + ". Check the circle on the blockchain before acting.");
              }}>
                <b>{circle.name}</b>
                <small>{circle.members.length} members · {formatAssetAmount("PUSD", circle.contribution)} PUSD each · {circle.stateCategory.slice(0, 10)}…</small>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="pusd-mainnet-build-status">
        <LockKeyhole size={16} />
        <span><b>PUSD Mainnet circle rules</b><small>Members approve each payment in Selene. The app checks the circle details before sending. Plain PUSD wallet transfers remain locked.</small>
          <details className="technical-details">
            <summary>Technical details</summary>
            <p>Circle actions are checked against provider-confirmed previous outputs, the exact circle and escrow artifacts, wallet signature hashes and BCH 2026 VM rules. The durable input ledger prevents a transaction from being relayed twice.</p>
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
