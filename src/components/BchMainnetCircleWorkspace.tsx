import { useMemo, useState, type FormEvent } from "react";
import { ArrowRight, LockKeyhole, ShieldCheck } from "lucide-react";
import { formatAssetAmount, parseAssetAmount } from "../core/assets";
import { createBchMainnetCircleDraft, prepareBchMainnetCircleGenesisPreview } from "../core/bch-mainnet-circle";
import { classicAddressToPkh } from "../core/classic-bch";
import {
  planV2FeeDeposit,
  planV2FeePayout,
  planV2FeeCancel,
  readV2FeeCircle,
  validateV2FeeCircleDraft,
  type V2FeeCircleParams,
} from "../core/v2-fee-bch";
import { MAINNET_PROJECT_TREASURY_ADDRESS } from "../core/project-treasury";
import { wallet } from "../core/wizard-wallet";
import type { NetworkId } from "../core/network-config";

type Props = { network: NetworkId; walletConnected: boolean };

type Draft = { name: string; contribution: string; members: string[]; maxFee: string; savedAt: number };
const STORAGE_KEY = "ajochain-blaze:bch-mainnet-circle-drafts:v1";
const ACTIVE_CIRCLE_KEY = "ajochain-blaze:bch-mainnet-circle-active:v1";
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

export default function BchMainnetCircleWorkspace({ network, walletConnected }: Props) {
  const [name, setName] = useState("My BCH Ajo Circle");
  const [contribution, setContribution] = useState("0.002");
  const [membersText, setMembersText] = useState("");
  const [maxFee, setMaxFee] = useState("10000");
  const [drafts, setDrafts] = useState<Draft[]>(readDrafts);
  const [activeCircle, setActiveCircle] = useState<V2FeeCircleParams | null>(readActiveCircle);
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

  const members = useMemo(
    () => membersText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    [membersText],
  );
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
      if (!name.trim() || name.trim().length > 60) throw new Error("Enter a circle name between 1 and 60 characters.");
      if (members.length < 2 || members.length > 5) throw new Error("Enter 2–5 unique BCH Mainnet member addresses.");
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
        initiator: members[0],
      });
      const draft: Draft = {
        name: name.trim(),
        contribution: formatAssetAmount("BCH", units),
        members,
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
    setMembersText(draft.members.join("\n"));
    setMaxFee(draft.maxFee);
    setPreview(null);
    setError("");
    setNotice("Local draft loaded. Confirm the member addresses and prepare a fresh Mainnet preview.");
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
      setNotice("BCH Mainnet circle state verified from the read quorum. This is a read-only status check.");
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

  const verifyMainnetSignature = async (target: "genesis" | "action") => {
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
    setLifecycleBusy(true);
    setError("");
    setNotice("");
    try {
      const verified = await wallet.signAndVerify(
        signingPlan.wc,
        signingPlan.walletInputs,
        signingPlan.prompt + " (local verification only; never broadcast)",
      );
      const walletAddress = wallet.address("mainnet");
      if (!walletAddress) throw new Error("The connected Selene wallet no longer exposes its Mainnet address.");
      const verificationResponse = await fetch("/api/bch/verify", {
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
      if (!verification || verification.verified !== true || verification.broadcast !== false) {
        throw new Error("The Mainnet server did not return a valid verification-only result. No transaction was broadcast.");
      }
      const inputCount = verification.inputCount ?? verified.decoded.inputs.length;
      const outputCount = verification.outputCount ?? verified.decoded.outputs.length;
      if (target === "genesis") setGenesisSigningPlan(null);
      else setActionSigningPlan(null);
      setNotice(
        "Independent BCH Mainnet verification passed (" + inputCount + " inputs, " + outputCount +
        " outputs, txid " + (verification.txid || "verified") +
        "). Selene intent, exact V3 covenant, confirmed provider-quorum UTXOs and BCH 2026 VM checks passed. The signed bytes were discarded. Nothing was broadcast and no circle state changed.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLifecycleBusy(false);
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
      setError("Connect Selene through WizardConnect before preparing the Mainnet genesis preview.");
      return;
    }
    const initiator = wallet.address("mainnet");
    if (!initiator) {
      setError("No verified Mainnet receive address is available from the connected wallet.");
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
        members,
        contribution: amount,
        maxFee: BigInt(maxFee.trim()),
        initiator,
      }, initiator);
      setGenesisSigningPlan({
        wc: plan.wc, walletInputs: plan.walletInputs,
        prompt: "Verify BCH Mainnet circle genesis for " + name.trim(),
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
      setNotice("BCH Mainnet genesis preview prepared. The transaction is unsigned and cannot be broadcast from this workspace.");
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
          <span className="section-kicker">BITCOIN CASH · V3 AUTO-RESERVE</span>
          <h2 id="bch-mainnet-title">Create a BCH Mainnet circle</h2>
          <p>Member-specific contribution records, a next-round reserve for each non-final recipient, and a fixed 1% project fee.</p>
        </div>
        <span className="classic-network mainnet">Bitcoin Cash Mainnet</span>
      </div>

      <div className="pusd-mainnet-safety">
        <div><ShieldCheck size={17} /><span><b>Mainnet covenant selected</b><small>Separate V3 circle version · not the older Chipnet circle</small></span></div>
        <span className="asset-state neutral">Signing and broadcast locked</span>
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
        <label>Member Mainnet addresses · one per line
          <textarea value={membersText} onChange={(event) => setMembersText(event.target.value)} rows={4} placeholder={"bitcoincash:…\nbitcoincash:…"} required />
          <small>Enter 2–5 unique Bitcoin Cash Mainnet P2PKH or token-aware P2PKH addresses.</small>
        </label>
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
          <button className="secondary-button" type="button" onClick={saveDraft} disabled={network !== "mainnet"}>Save local draft</button>
        <button className="primary-button" type="submit" disabled={busy || network !== "mainnet" || !walletConnected}>
          {busy ? "Preparing Mainnet preview…" : "Prepare on-chain creation preview"} <ArrowRight size={15} />
        </button>
        </div>
      </form>

      {preview && (
        <div className="pusd-mainnet-breakdown" role="status">
          <b>Unsigned BCH Mainnet genesis preview</b>
          <div><span>Circle contract address</span><strong><code>{preview.contractAddress}</code></strong></div>
          <div><span>State CashToken category</span><strong><code>{preview.stateCategory}</code></strong></div>
          <div><span>Conservative miner-fee estimate</span><strong>{preview.feeEstimate} sats</strong></div>
          <div><span>Estimated wallet change</span><strong>{preview.estimatedChange} sats</strong></div>
          <div><span>Transaction shape</span><strong>{preview.inputCount} inputs · {preview.outputCount} outputs</strong></div>
          <small>No contract has been deployed. This preview is not a payment or deployment.</small>
          {genesisSigningPlan && <button type="button" className="secondary-button" disabled={lifecycleBusy || !walletConnected} onClick={() => void verifyMainnetSignature("genesis")}>Verify Selene signature · no broadcast</button>}
        </div>
      )}
      {activeCircle && (
        <div className="pusd-mainnet-saved">
          <div className="section-heading">
            <div><span className="section-kicker">CIRCLE LIFECYCLE · MAINNET READ-ONLY</span><h3>{activeCircle.name}</h3></div>
            <button type="button" className="secondary-button" disabled={lifecycleBusy} onClick={() => void readActiveOnChainState()}>
              {lifecycleBusy ? "Reading…" : "Read on-chain status"}
            </button>
          </div>
          <p className="classic-empty">Local circle identity saved for tracking. A saved genesis preview is not proof that the on-chain circle has been created.</p>
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
              <small>No transaction is broadcast by this workspace. Re-read state before each new review.</small>
              {actionSigningPlan && <button type="button" className="secondary-button" disabled={lifecycleBusy || !walletConnected} onClick={() => void verifyMainnetSignature("action")}>Verify Selene signature · no broadcast</button>}
            </div>
          )}
        </div>
      )}

      {error && <p className="classic-error" role="alert">{error}</p>}
      {notice && <p className="classic-notice" role="status">{notice}</p>}

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
        <span><b>Mainnet transaction execution remains disabled</b><small>Selene signing can now be exercised in a local verification-only step: exact transaction intent, 0x61 sighashes and BCH 2026 VM are checked, then signed bytes are discarded. Broadcasting, durable idempotency and reorg reconciliation remain locked.</small></span>
      </div>
    </section>
  );
}
