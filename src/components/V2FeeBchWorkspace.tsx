import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Copy, RefreshCw, ShieldCheck } from "lucide-react";
import { parseAssetAmount } from "../core/assets";
import { classicAddressToPkh, getClassicProvider } from "../core/classic-bch";
import { formatBch, type NetworkId } from "../core/network";
import { wallet } from "../core/wizard-wallet";
import {
  buildV2FeeMemberOrder,
  planV2FeeCancel,
  planV2FeeDeposit,
  planV2FeeGenesis,
  planV2FeePayout,
  readV2FeeCircle,
  type V2FeeCircleDraft,
  type V2FeeCircleParams,
} from "../core/v2-fee-bch";

const STORAGE_KEY = "ajochain-blaze:v2-fee-circles:v1";
const DEFAULT_TREASURY = "bchtest:zpn8rsua556gewluc0gf5mq4v343w8vc9vfcnq22v6";

type SavedCircle = { encoded: string; savedAt: number };
type Snapshot = Awaited<ReturnType<typeof readV2FeeCircle>>;

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function bchInputAmount(satoshis: bigint) {
  const whole = satoshis / 100_000_000n;
  const fraction = (satoshis % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? whole.toString() + "." + fraction : whole.toString();
}
function encodeCircle(params: V2FeeCircleParams) {
  const json = JSON.stringify({
    ...params,
    contribution: params.contribution.toString(),
    maxFee: params.maxFee.toString(),
  });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decodeCircle(encoded: string): V2FeeCircleParams {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  if (value.version !== 2 || typeof value.covenant !== "string" || !["fee-v1", "fee-v2-escrow", "fee-v3-auto-reserve", "fee-v1-guarded", "fee-v2-escrow-guarded", "fee-v3-auto-reserve-guarded"].includes(value.covenant) || value.network !== "chipnet" ||
      typeof value.name !== "string" || !Array.isArray(value.members) ||
      !value.members.every((member) => typeof member === "string") ||
      typeof value.contribution !== "string" || typeof value.maxFee !== "string" ||
      typeof value.stateCategory !== "string" || typeof value.initiator !== "string" ||
      typeof value.treasury !== "string") {
    throw new Error("This is not a valid AjoChain V2 fee-circle invite.");
  }
  return {
    version: 2,
    covenant: value.covenant as V2FeeCircleParams["covenant"],
    name: value.name,
    network: "chipnet",
    members: value.members as string[],
    contribution: BigInt(value.contribution),
    maxFee: BigInt(value.maxFee),
    stateCategory: value.stateCategory,
    initiator: value.initiator,
    treasury: value.treasury,
  };
}
function readSaved(): SavedCircle[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is SavedCircle => {
      if (!item || typeof item !== "object" || typeof item.encoded !== "string" ||
          !Number.isSafeInteger(item.savedAt)) return false;
      try { decodeCircle(item.encoded); return true; } catch { return false; }
    }).slice(0, 100);
  } catch { return []; }
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type Props = { network: NetworkId; walletConnected: boolean };

export default function V2FeeBchWorkspace({ network, walletConnected }: Props) {
  const [saved, setSaved] = useState<SavedCircle[]>(readSaved);
  const [selected, setSelected] = useState<string | null>(() => readSaved()[0]?.encoded ?? null);
  const [name, setName] = useState("My Ajo Circle");
  const [amount, setAmount] = useState("0.002");
  const [maxFee, setMaxFee] = useState("10000");
  const [treasury, setTreasury] = useState(DEFAULT_TREASURY);
  const [membersText, setMembersText] = useState("");
  const [depositAmount, setDepositAmount] = useState("0.002");
  const [restoreInput, setRestoreInput] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const active = useMemo(() => {
    if (!selected) return null;
    try { return decodeCircle(selected); } catch { return null; }
  }, [selected]);

  const persist = (params: V2FeeCircleParams) => {
    const encoded = encodeCircle(params);
    const next = [{ encoded, savedAt: Date.now() }, ...saved.filter((item) => item.encoded !== encoded)].slice(0, 100);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSaved(next);
    setSelected(encoded);
  };

  const refresh = async (params = active) => {
    if (!params) return;
    setBusy(true);
    setError("");
    try {
      const result = await readV2FeeCircle(params);
      setSnapshot(result);
      setNotice("V2 fee-circle state and every member receipt were read from Chipnet.");
    } catch (cause) {
      setSnapshot(null);
      setError(errorText(cause));
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!active) { setSnapshot(null); return; }
    let current = true;
    setSnapshot(null);
    void readV2FeeCircle(active).then((result) => {
      if (current) setSnapshot(result);
    }).catch((cause: unknown) => {
      if (current) setError(errorText(cause));
    });
    return () => { current = false; };
  }, [selected]);

  const memberIndex = useMemo(() => {
    if (!active || !walletConnected || wallet.state !== "connected") return -1;
    const address = wallet.address("chipnet");
    if (!address) return -1;
    try {
      const key = bytesToHex(classicAddressToPkh(address, "chipnet"));
      return active.members.findIndex((member) =>
        bytesToHex(classicAddressToPkh(member, "chipnet")) === key,
      );
    } catch { return -1; }
  }, [active, walletConnected, wallet.state, wallet.receiveIndex]);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setNotice("");
    if (network !== "chipnet") {
      setError("Switch the app network to Chipnet. This fee covenant is an experimental Chipnet release only.");
      return;
    }
    if (!walletConnected || wallet.state !== "connected") {
      if (wallet.state === "disconnected") { if (!wallet.tryResume()) wallet.connect(); }
      else if (wallet.state === "idle") wallet.connect();
      setError("Connect the initiator wallet before creating a fee circle.");
      return;
    }
    const initiator = wallet.address("chipnet");
    if (!initiator) { setError("No verified Chipnet receive address is available for this wallet."); return; }
    setBusy(true);
    try {
      const additionalMembers = membersText.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
      const members = buildV2FeeMemberOrder(initiator, additionalMembers, "chipnet");
      const draft: V2FeeCircleDraft = {
        version: 2,
        covenant: "fee-v3-auto-reserve-guarded",
        name: name.trim(),
        network: "chipnet",
        members,
        contribution: parseAssetAmount("BCH", amount),
        maxFee: BigInt(maxFee.trim()),
        initiator,
        treasury: treasury.trim(),
      };
      if (!/^\d+$/.test(maxFee.trim())) throw new Error("Maximum miner fee must be a whole number of satoshis.");
      const plan = await planV2FeeGenesis(draft, initiator);
      const grossPot = BigInt(members.length) * draft.contribution;
      const projectFee = grossPot / 100n;
      if (!window.confirm(
        "Create new automatic-reserve circle on Chipnet?\\n\\n" +
        plan.contract.address + "\\n" +
        members.length + " member receipts will be created.\\n" +
        "Contribution: " + formatBch(draft.contribution) + " per member, per scheduled payout.\\n" +
        "Each member funds one current-round contribution: " + formatBch(draft.contribution) + ".\\n" +
        "When a member receives a payout, exactly one next contribution is withheld and credited to their own on-chain receipt.\\n" +
        "Gross round pot: " + formatBch(grossPot) + ".\\n" +
        "Project fee: " + formatBch(projectFee) + " (1%), paid to " + draft.treasury + ".\\n" +
        "Miner fee is separate and capped at " + draft.maxFee.toString() + " sats.\\n\\n" +
        "No one must pre-fund the entire cycle. Each recipient carries one next contribution forward from their payout to cover the following round.\\n" +
        "Experimental Chipnet software only; no real funds.",
      )) return;
      const signed = await wallet.signAndVerify(plan.wc, plan.walletInputs, "Create AjoChain V2 fee circle: " + draft.name);
      const provider = await getClassicProvider("chipnet");
      const txid = await provider.sendRawTransaction(signed.signedTransaction);
      persist(plan.params);
      setNotice("V2 fee circle genesis broadcast on Chipnet. Transaction: " + txid);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };

  const deposit = async () => {
    if (!active) return;
    setError(""); setNotice("");
    if (network !== "chipnet") { setError("V2 fee-circle deposits are Chipnet-only."); return; }
    if (!walletConnected || wallet.state !== "connected" || memberIndex < 0) {
      setError("Connect the wallet registered for this member slot before depositing.");
      return;
    }
    const address = wallet.address("chipnet");
    if (!address) { setError("No verified Chipnet receive address is available."); return; }
    setBusy(true);
    try {
      const units = parseAssetAmount("BCH", depositAmount);
      const plan = await planV2FeeDeposit(active, memberIndex, units, address);
      if (!window.confirm(
        "Add " + formatBch(units) + " to Member " + (memberIndex + 1) + "'s own receipt?\n" +
        "Additional escrow needed to unlock every remaining payout: " + formatBch(plan.shortfall) + "\\n" +
        "Only this member's registered wallet can fund this slot.",
      )) return;
      const signed = await wallet.signAndVerify(plan.wc, plan.walletInputs, "Add my V2 AjoChain member credit");
      const provider = await getClassicProvider("chipnet");
      const txid = await provider.sendRawTransaction(signed.signedTransaction);
      setNotice("Member credit deposit broadcast. Transaction: " + txid);
      await refresh(active);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };

  const payout = async () => {
    if (!active) return;
    setError(""); setNotice("");
    if (network !== "chipnet") { setError("V2 fee-circle payouts are Chipnet-only."); return; }
    const feePayerAddress = wallet.address("chipnet");
    if (!walletConnected || wallet.state !== "connected" || !feePayerAddress) {
      setError("Connect a Chipnet wallet to sponsor the miner fee separately from the member pot.");
      return;
    }
    setBusy(true);
    try {
      const plan = await planV2FeePayout(active, feePayerAddress);
      if (!window.confirm(
        "Pay round " + (plan.round + 1) + " to Member " + (plan.round + 1) + "?\\n\\n" +
        "Gross pot: " + formatBch(plan.gross) + "\\n" +
        "Fixed 1% project fee: " + formatBch(plan.projectFee) + "\\n" +
        (plan.hasAutomaticFutureReserve
          ? "Automatic reserve for one next contribution: " + formatBch(plan.autoReserve) + " (" + plan.autoReservePercent + "% of the recipient’s pre-reserve payout)\\n"
          : "Automatic future-contribution reserve: not used by this older circle version.\\n") +
        "Member receives: " + formatBch(plan.payout) + "\\n" +
        "Separate miner fee paid by your wallet: up to " + plan.minerFee.toString() + " sats\\n\\n" +
        (plan.hasAutomaticFutureReserve
          ? "Every receipt is debited by one current-round contribution. Exactly one next contribution is then reserved in the recipient’s own receipt for the following round. After that reserve is consumed, the member must fund later installments again."
          : "This circle follows its original versioned member-credit rules. Its funding and payout terms have not been changed."),
      )) return;
      const signed = await wallet.signAndVerify(
        plan.wc, plan.walletInputs,
        "Sponsor the BCH miner fee and trigger AjoChain round " + (plan.round + 1),
      );
      const provider = await getClassicProvider("chipnet");
      const txid = await provider.sendRawTransaction(signed.signedTransaction);
      setNotice("V2 fee payout broadcast. The 1% project fee and member payout were paid from the circle pot; miner fee came from the connected wallet. Transaction: " + txid);
      await refresh(active);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!active) return;
    setError(""); setNotice("");
    const address = wallet.address("chipnet");
    if (!walletConnected || wallet.state !== "connected" || !address) {
      setError("Connect the circle initiator wallet to cancel this circle.");
      return;
    }
    setBusy(true);
    try {
      const plan = await planV2FeeCancel(active, address);
      if (!window.confirm("Cancel before the first payout and refund each member's exact recorded credit?\nThis cannot be reversed.")) return;
      const signed = await wallet.signAndVerify(plan.wc, plan.walletInputs, "Cancel AjoChain V2 fee circle and refund members");
      const provider = await getClassicProvider("chipnet");
      const txid = await provider.sendRawTransaction(signed.signedTransaction);
      setNotice("Pre-payout cancellation broadcast. Transaction: " + txid);
      await refresh(active);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };

  const restore = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    try {
      const candidate = restoreInput.trim();
      const match = candidate.match(/#\/v2-fee\/([A-Za-z0-9_-]+)/) ?? candidate.match(/^\/?v2-fee\/([A-Za-z0-9_-]+)$/);
      if (!match) throw new Error("Paste a recognised AjoChain V2 fee-circle invite.");
      const params = decodeCircle(match[1]);
      persist(params);
      setRestoreInput("");
      setNotice("V2 fee-circle invite restored locally. Chain state still has to be independently read.");
    } catch (cause) { setError(errorText(cause)); }
  };

  const copyInvite = async () => {
    if (!active) return;
    const route = "#/v2-fee/" + encodeCircle(active);
    try {
      await navigator.clipboard.writeText(window.location.origin + window.location.pathname + route);
      setNotice("V2 fee-circle invite copied.");
    } catch { setNotice("Clipboard is unavailable. Invite route: " + route); }
  };

  const initiator = Boolean(active && walletConnected && wallet.state === "connected" &&
    wallet.address("chipnet") && (() => {
      try {
        return bytesToHex(classicAddressToPkh(wallet.address("chipnet")!, "chipnet")) ===
          bytesToHex(classicAddressToPkh(active.initiator, "chipnet"));
      } catch { return false; }
    })());

  return (
    <section className="circle-workspace section-card" aria-labelledby="v2-fee-title">
      <div className="section-heading workspace-heading">
        <div>
          <span className="section-kicker">MEMBER CREDIT · FEE COVENANT</span>
          <h2 id="v2-fee-title">Fair-round BCH circle</h2>
          <p>Members fund the current round. When a member receives a payout, exactly one next contribution is withheld and carried forward in that member’s own on-chain receipt.</p>
        </div>
        <span className="classic-network">Chipnet · automatic future reserve</span>
      </div>
      <div className="safety-note-inline">
        <ShieldCheck size={17} />
        <span>Experimental and unaudited. Chipnet only. Every payout except the final payout reserves exactly one next contribution for the recipient. It covers the following round; after it is consumed, that member must fund later installments again. No Mainnet signing or broadcasting is enabled.</span>
      </div>

      <div className="circle-workspace-grid">
        <div className="circle-panel">
          <h3>Create a new fee circle</h3>
          <form onSubmit={create}>
            <label>Circle name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required /></label>
            <label>Contribution per member (BCH)<input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" required /></label>
            <label>Maximum miner fee (satoshis)<input value={maxFee} onChange={(event) => setMaxFee(event.target.value)} inputMode="numeric" required /></label>
            <label>Fixed Chipnet treasury address<input value={treasury} onChange={(event) => setTreasury(event.target.value)} required /></label>
            <p className="field-hint"><b>Member 1 · Circle creator</b><br />{walletConnected && wallet.state === "connected" && wallet.address("chipnet")
              ? <code>{wallet.address("chipnet")}</code>
              : "Connect your Selene wallet and its address will be registered automatically."}<br />Your connected wallet is always added first. Do not enter your own address below.</p>
            <label>Other members' Chipnet BCH addresses · one per line<textarea value={membersText} onChange={(event) => setMembersText(event.target.value)} rows={4} placeholder="bchtest:…\nbchtest:…" required /></label>
            <button className="primary-button" type="submit" disabled={busy || network !== "chipnet" || !walletConnected}>
              {network !== "chipnet" ? "Switch to Chipnet" : !walletConnected ? "Connect wallet first" : "Create fee circle"}
            </button>
          </form>
          <small className="field-hint">New circles automatically register the connected creator as Member 1. Add 1–4 other unique Chipnet addresses in payout order (2–5 members total). Each member funds the current round; each non-final recipient carries one next contribution forward. No full-cycle pre-funding is required. The treasury is immutable after creation.</small>
        </div>
        <div className="circle-panel">
          <h3>Saved fee circles</h3>
          {saved.length ? <div className="classic-saved-list">
            {saved.map((entry) => {
              let params: V2FeeCircleParams | null = null;
              try { params = decodeCircle(entry.encoded); } catch { /* ignore damaged item */ }
              if (!params) return null;
              return <button key={entry.encoded} type="button" className={selected === entry.encoded ? "classic-saved-item selected" : "classic-saved-item"} onClick={() => setSelected(entry.encoded)}>
                <b>{params.name}</b>
                <span>Chipnet · {params.members.length} members · {formatBch(params.contribution)} each</span>
                <small>Saved {new Date(entry.savedAt).toLocaleDateString()}</small>
              </button>;
            })}
          </div> : <p className="classic-empty">No fee circles saved in this browser yet.</p>}
          <form className="classic-restore-form" onSubmit={restore}>
            <label>Restore a V2 fee-circle invite<input value={restoreInput} onChange={(event) => setRestoreInput(event.target.value)} placeholder="Paste invite URL" /></label>
            <button type="submit" className="secondary-button">Restore invite</button>
          </form>
        </div>
      </div>

      {active && <div className="classic-active-circle">
        <div className="section-heading">
          <div><span className="section-kicker">SELECTED CIRCLE · CHIPNET</span><h3>{active.name}</h3></div>
          <button type="button" className="secondary-button" onClick={() => void copyInvite()}><Copy size={14} /> Copy invite</button>
        </div>
        <p className="classic-contract-address">State category: <code>{active.stateCategory}</code></p>
        <p className="classic-contract-address">Treasury: <code>{active.treasury}</code> · 1% of each gross payout</p>
        {snapshot ? <>
          <div className="classic-account-summary classic-chain-stats">
            <div><b>{snapshot.completed ? "Complete" : (snapshot.round + 1) + " / " + active.members.length}</b><span>{snapshot.completed ? "All scheduled payouts" : "Next payout round"}</span></div>
            <div><b>{formatBch(snapshot.stateSatoshis)}</b><span>State + escrow backing</span></div>
            <div><b>{snapshot.completed ? "Complete" : snapshot.ready ? "Payout unlocked" : "Contribution shortfall"}</b><span>Current-round funding and recipient reserves</span></div>
          </div>
          <div className="fee-accounting-heading">
            <div><b>Member accountability ledger</b><span>On-chain receipt credits, remaining commitment and payout record</span></div>
            <span className={snapshot.ready || snapshot.completed ? "fee-accounting-status safe" : "fee-accounting-status blocked"}>{snapshot.completed ? "Circle closed" : snapshot.ready ? "Payout unlocked" : "Payout locked"}</span>
          </div>
          {(active.covenant === "fee-v1" || active.covenant === "fee-v1-guarded") && <p className="classic-error">Legacy rolling-credit circle: it only checks one contribution at a time. A member who stops after receiving a payout can block later rounds. New circles use V3 automatic future-contribution reserves.</p>}
          {(active.covenant === "fee-v2-escrow" || active.covenant === "fee-v2-escrow-guarded") && <p className="field-hint">This existing V2 circle uses its original full-cycle pre-funding covenant. New circles use V3 automatic future-contribution reserves; this existing circle is not silently migrated.</p>}
          <div className="fee-accounting-table">
            <div className="fee-accounting-row fee-accounting-header"><span>Member</span><span>Paid directly</span><span>Locked now / required</span><span>Payout received</span><span>Still due</span><span>Status</span></div>
            {snapshot.memberAccounting.map((account) => (
              <div className="fee-accounting-row" key={account.address}>
                <span><b>Member {account.index + 1}{memberIndex === account.index ? " · You" : ""}</b><small>{account.address}</small></span>
                <span>{account.totalPaidIn === null ? "Legacy history" : formatBch(account.totalPaidIn)}</span>
                <span>{formatBch(account.currentCredit)}<small>of {formatBch(account.requiredForNextPayout)}</small></span>
                <span>{account.payoutReceived === null ? "Not tracked" : account.payoutReceived ? formatBch(account.payoutAmountReceived) : "Not yet"}</span>
                <span>{formatBch(account.shortfallForNextPayout)}</span>
                <span><b className={account.fullySecured ? "fee-accounting-member-safe" : "fee-accounting-member-blocked"}>{account.status}</b></span>
              </div>
            ))}
          </div>
          {snapshot.completed
            ? <p className="classic-recipient"><b>Circle completed.</b> Every registered member received their scheduled payout. No further deposits or payouts are accepted.</p>
            : <p className="classic-recipient">Next payout recipient: <b>Member {snapshot.round + 1}</b> · {snapshot.recipient}</p>}
          <p className="field-hint">{snapshot.hasPaid ? "The first payout has happened. Cancellation is permanently locked; remaining escrow cannot be withdrawn." : "No payout has happened yet. Only the initiator may cancel and refund recorded member credit."}</p>
        </> : <p className="classic-empty">Reading the state NFT and all member receipts from Chipnet. Refresh if the transaction is still confirming.</p>}
        <p className="field-hint">{memberIndex >= 0
          ? "Your connected Selene wallet is registered as Member " + (memberIndex + 1) + ". You can add credit to your own receipt below."
          : walletConnected
            ? "This connected wallet is not registered in this circle. Connect Selene using one of the member addresses listed above, or restore the correct invite."
            : "Connect Selene using the BCH address registered for your member slot to unlock your personal contribution option."}</p>
        <label className="classic-deposit-field">Your BCH contribution deposit<input value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} inputMode="decimal" /></label>
        {memberIndex >= 0 && snapshot?.memberAccounting[memberIndex] && <p className="field-hint">Your receipt holds {formatBch(snapshot.memberAccounting[memberIndex].currentCredit)}. Amount needed for your next contribution reserve or current round: <b>{formatBch(snapshot.memberAccounting[memberIndex].shortfallForNextPayout)}</b>. <button type="button" className="fee-exact-amount-button" onClick={() => setDepositAmount(bchInputAmount(snapshot.memberAccounting[memberIndex].shortfallForNextPayout))}>Use exact amount due</button></p>}
        <div className="classic-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</button>
          <button type="button" className="secondary-button" disabled={busy || memberIndex < 0 || network !== "chipnet" || Boolean(snapshot?.completed)} onClick={() => void deposit()}>
            {memberIndex < 0 ? "Connect a circle member wallet" : "Add my credit"}
          </button>
          <button type="button" className="primary-button" disabled={busy || !snapshot?.ready || snapshot?.completed || network !== "chipnet"} onClick={() => void payout()}>Pay out next round</button>
          <button type="button" className="secondary-button" disabled={busy || !initiator || Boolean(snapshot?.hasPaid)} onClick={() => void cancel()}>Cancel before first payout</button>
        </div>
      </div>}
      {busy && <p className="classic-feedback" role="status">Preparing or verifying a Chipnet transaction…</p>}
      {notice && <p className="classic-feedback" role="status">{notice}</p>}
      {error && <p className="classic-error" role="alert">{error}</p>}
    </section>
  );
}
