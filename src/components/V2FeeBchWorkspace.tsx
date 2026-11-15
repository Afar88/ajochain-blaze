import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowRight, Copy, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { parseAssetAmount } from "../core/assets";
import { classicAddressToPkh, getClassicProvider } from "../core/classic-bch";
import { formatBch, type NetworkId } from "../core/network";
import { wallet } from "../core/wizard-wallet";
import {
  planV2FeeCancel,
  planV2FeeDeposit,
  planV2FeeGenesis,
  planV2FeePayout,
  readV2FeeCircle,
  type V2FeeCircleDraft,
  type V2FeeCircleParams,
} from "../core/v2-fee-bch";

const STORAGE_KEY = "ajochain-blaze:v2-fee-circles:v1";
const DEFAULT_TREASURY = "bchtest:zpn8rsua556gewluc0gf5mq4v343w8vc9";

type SavedCircle = { encoded: string; savedAt: number };
type Snapshot = Awaited<ReturnType<typeof readV2FeeCircle>>;

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  if (value.version !== 2 || value.covenant !== "fee-v1" || value.network !== "chipnet" ||
      typeof value.name !== "string" || !Array.isArray(value.members) ||
      !value.members.every((member) => typeof member === "string") ||
      typeof value.contribution !== "string" || typeof value.maxFee !== "string" ||
      typeof value.stateCategory !== "string" || typeof value.initiator !== "string" ||
      typeof value.treasury !== "string") {
    throw new Error("This is not a valid AjoChain V2 fee-circle invite.");
  }
  return {
    version: 2,
    covenant: "fee-v1",
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
      const members = membersText.split(/\\r?\\n/).map((entry) => entry.trim()).filter(Boolean);
      const draft: V2FeeCircleDraft = {
        version: 2,
        covenant: "fee-v1",
        name: name.trim(),
        network: "chipnet",
        members,
        contribution: parseAssetAmount("BCH", amount),
        maxFee: BigInt(maxFee.trim()),
        initiator,
        treasury: treasury.trim(),
      };
      if (!/^\\d+$/.test(maxFee.trim())) throw new Error("Maximum miner fee must be a whole number of satoshis.");
      const plan = await planV2FeeGenesis(draft, initiator);
      const gross = BigInt(members.length) * draft.contribution;
      const projectFee = gross / 100n;
      if (!window.confirm(
        "Create new V2 fee circle on Chipnet?\\n\\n" +
        plan.contract.address + "\\n" +
        members.length + " member receipts will be created.\\n" +
        "Contribution: " + formatBch(draft.contribution) + " per member.\\n" +
        "Project fee: 1% of each gross round payout, paid to " + draft.treasury + ".\\n" +
        "Miner fee is separate and capped at " + draft.maxFee.toString() + " sats.\\n\\n" +
        "This is experimental Chipnet software, not for real funds.",
      )) return;
      const signed = await wallet.signAndVerify(plan.wc, plan.walletInputs, "Create AjoChain V2 fee circle: " + draft.name);
      const txid = await plan.provider.sendRawTransaction(signed.signedTransaction);
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
        "Add " + formatBch(units) + " to Member " + (memberIndex + 1) + "'s own receipt?\\n" +
        "Only this member's wallet can fund this slot.",
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
    setBusy(true);
    try {
      const plan = await planV2FeePayout(active);
      if (!window.confirm(
        "Pay round " + (plan.round + 1) + " to Member " + (plan.round + 1) + "?\\n\\n" +
        "Gross pot: " + formatBch(plan.gross) + "\\n" +
        "1% project fee: " + formatBch(plan.projectFee) + "\\n" +
        "Estimated miner fee: up to " + plan.minerFee.toString() + " sats\\n" +
        "Recipient receives approximately: " + formatBch(plan.payout) + "\\n\\n" +
        "Every member's receipt will be debited by one full contribution, including the recipient.",
      )) return;
      const provider = await getClassicProvider("chipnet");
      const txid = await provider.sendRawTransaction(plan.builder.build());
      setNotice("V2 fee payout broadcast. Transaction: " + txid);
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
          <p>Every member keeps their own credit. Every round debits every member, even the payout recipient.</p>
        </div>
        <span className="classic-network">Chipnet prototype</span>
      </div>
      <div className="safety-note-inline">
        <ShieldCheck size={17} />
        <span>Experimental and unaudited. Chipnet only. The 1% project fee is fixed to the treasury address at creation. No Mainnet signing or broadcasting is enabled.</span>
      </div>

      <div className="circle-workspace-grid">
        <div className="circle-panel">
          <h3>Create a new fee circle</h3>
          <form onSubmit={create}>
            <label>Circle name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required /></label>
            <label>Contribution per member (BCH)<input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" required /></label>
            <label>Maximum miner fee (satoshis)<input value={maxFee} onChange={(event) => setMaxFee(event.target.value)} inputMode="numeric" required /></label>
            <label>Fixed Chipnet treasury address<input value={treasury} onChange={(event) => setTreasury(event.target.value)} required /></label>
            <label>Member Chipnet BCH addresses · one per line<textarea value={membersText} onChange={(event) => setMembersText(event.target.value)} rows={4} placeholder="bchtest:…\\nbchtest:…" required /></label>
            <button className="primary-button" type="submit" disabled={busy || network !== "chipnet" || !walletConnected}>
              {network !== "chipnet" ? "Switch to Chipnet" : !walletConnected ? "Connect wallet first" : "Create fee circle"}
            </button>
          </form>
          <small className="field-hint">New circles require at least 0.002 BCH per member per round. The treasury is immutable after creation. Review it before sharing the invite.</small>
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
            <div><b>{snapshot.round + 1} / {active.members.length}</b><span>Next payout round</span></div>
            <div><b>{formatBch(snapshot.stateSatoshis)}</b><span>State + member credit backing</span></div>
            <div><b>{snapshot.ready ? "Ready" : "Waiting"}</b><span>All member receipts</span></div>
          </div>
          <div className="classic-members">
            {snapshot.credits.map((credit, index) => <div key={active.members[index]}>
              <b>Member {index + 1}{memberIndex === index ? " · Your wallet" : ""}</b>
              <code>{active.members[index]}</code>
              <span>{formatBch(credit)} recorded credit · {formatBch(credit >= active.contribution ? active.contribution : credit)} toward this round</span>
            </div>)}
          </div>
          <p className="classic-recipient">Next payout recipient: <b>Member {snapshot.round + 1}</b> · {snapshot.recipient}</p>
          <p className="field-hint">{snapshot.hasPaid ? "The first payout has happened. Cancellation is permanently locked." : "No payout has happened yet. Only the initiator may cancel and refund recorded member credit."}</p>
        </> : <p className="classic-empty">Reading the state NFT and all member receipts from Chipnet. Refresh if the transaction is still confirming.</p>}
        <label className="classic-deposit-field">Your BCH credit deposit<input value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} inputMode="decimal" /></label>
        <div className="classic-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</button>
          <button type="button" className="secondary-button" disabled={busy || memberIndex < 0 || network !== "chipnet" || Boolean(snapshot && snapshot.hasPaid && snapshot.round >= active.members.length)} onClick={() => void deposit()}>
            {memberIndex < 0 ? "Connect a circle member wallet" : "Add my credit"}
          </button>
          <button type="button" className="primary-button" disabled={busy || !snapshot?.ready || network !== "chipnet"} onClick={() => void payout()}>Pay out next round</button>
          <button type="button" className="secondary-button" disabled={busy || !initiator || Boolean(snapshot?.hasPaid)} onClick={() => void cancel()}>Cancel before first payout</button>
        </div>
      </div>}
      {busy && <p className="classic-feedback" role="status">Preparing or verifying a Chipnet transaction…</p>}
      {notice && <p className="classic-feedback" role="status">{notice}</p>}
      {error && <p className="classic-error" role="alert">{error}</p>}
    </section>
  );
}
