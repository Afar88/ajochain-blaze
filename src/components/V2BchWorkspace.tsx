import { useEffect, useMemo, useState, type FormEvent } from "react";
import { parseAssetAmount } from "../core/assets";
import { classicAddressToPkh } from "../core/classic-bch";
import { formatBch, type NetworkId } from "../core/network";
import { wallet } from "../core/wizard-wallet";
import {
  decodeV2Circle,
  encodeV2Circle,
  planV2Deposit,
  planV2Genesis,
  planV2Payout,
  readV2Circle,
  validateV2Circle,
  type V2CircleDraft,
  type V2CircleParams,
} from "../core/v2-bch";

const STORAGE_KEY = "ajochain-blaze:v2-circles:v1";
type SavedCircle = { encoded: string; savedAt: number };
type V2Snapshot = Awaited<ReturnType<typeof readV2Circle>>;

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function readSaved(): SavedCircle[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is SavedCircle => {
      if (!entry || typeof entry !== "object" ||
          typeof entry.encoded !== "string" || !Number.isSafeInteger(entry.savedAt)) return false;
      try { decodeV2Circle(entry.encoded); return true; } catch { return false; }
    }).slice(0, 100);
  } catch { return []; }
}

type Props = { network: NetworkId; walletConnected: boolean };

export default function V2BchWorkspace({ network, walletConnected }: Props) {
  const [saved, setSaved] = useState<SavedCircle[]>(readSaved);
  const [selected, setSelected] = useState<string | null>(() => readSaved()[0]?.encoded ?? null);
  const [name, setName] = useState("My Member Credit Ajo");
  const [amount, setAmount] = useState("0.001");
  const [maxFee, setMaxFee] = useState("10000");
  const [membersText, setMembersText] = useState("");
  const [depositAmount, setDepositAmount] = useState("0.001");
  const [restoreInput, setRestoreInput] = useState("");
  const [snapshot, setSnapshot] = useState<V2Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const active = useMemo(() => {
    if (!selected) return null;
    try { return decodeV2Circle(selected); } catch { return null; }
  }, [selected]);

  const persist = (params: V2CircleParams) => {
    const encoded = encodeV2Circle(params);
    const next = [{ encoded, savedAt: Date.now() }, ...saved.filter((entry) => entry.encoded !== encoded)].slice(0, 100);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSaved(next);
    setSelected(encoded);
  };

  const refresh = async (params = active) => {
    if (!params) return;
    setBusy(true);
    setError("");
    try {
      const result = await readV2Circle(params);
      setSnapshot(result);
      setNotice("V2 member receipt state refreshed from Chipnet.");
    } catch (cause) {
      setSnapshot(null);
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!active) {
      setSnapshot(null);
      return;
    }
    let current = true;
    setSnapshot(null);
    void readV2Circle(active).then((result) => {
      if (current) setSnapshot(result);
    }).catch((cause: unknown) => {
      if (current) setError(errorText(cause));
    });
    return () => { current = false; };
  }, [selected]);

  const connect = () => {
    if (wallet.state === "disconnected") {
      if (!wallet.tryResume()) wallet.connect();
    } else if (wallet.state === "idle") wallet.connect();
  };

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setNotice("");
    if (network !== "chipnet") {
      setError("Switch the app network to Chipnet before creating an experimental V2 circle.");
      return;
    }
    if (!walletConnected || wallet.state !== "connected") {
      connect();
      setError("Connect Selene through WizardConnect, then submit the V2 circle again.");
      return;
    }
    const address = wallet.address("chipnet");
    if (!address) {
      setError("The connected wallet has no verified Chipnet receive address.");
      return;
    }
    setBusy(true);
    try {
      const members = membersText.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
      const draft: V2CircleDraft = {
        version: 2,
        name: name.trim(),
        network: "chipnet",
        members,
        contribution: parseAssetAmount("BCH", amount),
        maxFee: BigInt(maxFee.trim()),
      };
      if (!/^\d+$/.test(maxFee.trim())) throw new Error("Maximum fee must be a whole number of satoshis.");
      validateV2Circle(draft);
      const plan = await planV2Genesis(draft, address);
      if (!window.confirm(
        "Create experimental V2 circle on Chipnet?\n\n" +
        plan.contract.address + "\n" +
        members.length + " member receipts will be minted.\n" +
        "Contribution: " + formatBch(draft.contribution) + " BCH per member.",
      )) return;
      const signed = await wallet.signAndVerify(
        plan.wc,
        plan.walletInputs,
        "Create V2 AjoChain circle: " + draft.name,
      );
      const txid = await plan.provider.sendRawTransaction(signed.signedTransaction);
      persist(plan.params);
      setNotice("V2 genesis broadcast to Chipnet. Transaction ID: " + txid + ". Refresh after confirmation to inspect the state and member receipts.");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const memberIndex = useMemo(() => {
    if (!active || !walletConnected || wallet.state !== "connected") return -1;
    const address = wallet.address("chipnet");
    if (!address) return -1;
    try {
      const key = hex(classicAddressToPkh(address, "chipnet"));
      return active.members.findIndex((member) => hex(classicAddressToPkh(member, "chipnet")) === key);
    } catch { return -1; }
  }, [active, walletConnected, wallet.state, wallet.receiveIndex]);

  const deposit = async () => {
    if (!active) return;
    setError("");
    setNotice("");
    if (network !== "chipnet") {
      setError("Switch the app network to Chipnet before adding V2 member credit.");
      return;
    }
    if (!walletConnected || wallet.state !== "connected" || memberIndex < 0) {
      connect();
      setError("Connect the wallet registered for a member slot before adding credit.");
      return;
    }
    const address = wallet.address("chipnet");
    if (!address) return;
    setBusy(true);
    try {
      const amountSats = parseAssetAmount("BCH", depositAmount);
      const plan = await planV2Deposit(active, memberIndex, amountSats, address);
      if (!window.confirm(
        "Add " + formatBch(amountSats) + " BCH to Member " + (memberIndex + 1) +
        "'s own V2 credit receipt?\n\nYour wallet will fund this deposit and its miner fee.",
      )) return;
      const signed = await wallet.signAndVerify(
        plan.wc,
        plan.walletInputs,
        "Add V2 member credit for " + active.name,
      );
      const txid = await plan.provider.sendRawTransaction(signed.signedTransaction);
      setNotice("Member credit deposit broadcast. Transaction ID: " + txid);
      await refresh(active);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const payout = async () => {
    if (!active) return;
    setError("");
    setNotice("");
    if (network !== "chipnet") {
      setError("V2 payouts are Chipnet-only.");
      return;
    }
    setBusy(true);
    try {
      const plan = await planV2Payout(active);
      if (!window.confirm(
        "Payout V2 round " + (plan.round + 1) + " to Member " + (plan.round + 1) + "?\n\n" +
        "Recipient: " + plan.recipient + "\n" +
        "Payout: " + formatBch(plan.payout) + "\n" +
        "All members' individual receipts must contain at least one full contribution.",
      )) return;
      const txid = await plan.provider.sendRawTransaction(plan.builder.build());
      setNotice("V2 covenant payout broadcast. Transaction ID: " + txid);
      await refresh(active);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const restore = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    try {
      let candidate = restoreInput.trim();
      try { candidate = new URL(candidate).hash || candidate; } catch { /* route accepted */ }
      const match = candidate.match(/#\/v2\/([A-Za-z0-9_-]+)(?:\?manual=1)?$/) ??
        candidate.match(/^\/?v2\/([A-Za-z0-9_-]+)$/);
      if (!match) throw new Error("Paste a recognised AjoChain V2 invite URL.");
      const params = decodeV2Circle(match[1]);
      persist(params);
      setRestoreInput("");
      setNotice("V2 invite restored to this browser. The chain state will be re-read; restoration does not prove funds.");
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const copyInvite = async () => {
    if (!active) return;
    const route = "#/v2/" + encodeV2Circle(active);
    try {
      await navigator.clipboard.writeText(window.location.origin + window.location.pathname + route);
      setNotice("V2 invite link copied.");
    } catch {
      setNotice("Copy is unavailable in this browser. Invite route: " + route);
    }
  };

  return (
    <section className="classic-workspace section-card" aria-labelledby="v2-workspace-title">
      <div className="section-heading classic-workspace-heading">
        <div><span className="section-kicker">MEMBER CREDIT · V2 EXPERIMENTAL</span><h2 id="v2-workspace-title">Individual member receipts</h2>
          <p>Each member funds their own on-chain credit. Excess credit carries forward for that member only.</p></div>
        <span className={network === "chipnet" ? "classic-network" : "classic-network mainnet"}>Chipnet only</span>
      </div>
      <p className="classic-disclaimer">Experimental, unaudited prototype. Do not use real BCH. V2 does not support PUSD or cancellation. Mainnet deployment and spending are not available.</p>
      <div className="classic-workspace-grid">
        <div className="classic-create-panel">
          <h3>Create a V2 circle</h3>
          <form onSubmit={create}>
            <label>Circle name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required /></label>
            <label>Contribution per member (BCH)<input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" required /></label>
            <label>Maximum miner fee (sats)<input value={maxFee} onChange={(event) => setMaxFee(event.target.value)} inputMode="numeric" required /></label>
            <label>Member Chipnet addresses · one per line
              <textarea value={membersText} onChange={(event) => setMembersText(event.target.value)} rows={4} placeholder="bchtest:…&#10;bchtest:…" required />
            </label>
            <button className="primary-button" type="submit" disabled={busy || network !== "chipnet"}>
              {network !== "chipnet" ? "Switch app network to Chipnet" : "Create V2 circle"}
            </button>
          </form>
        </div>
        <div className="classic-account-panel">
          <h3>Saved V2 circles</h3>
          {saved.length ? <div className="classic-saved-list">
            {saved.map((entry) => {
              let params: V2CircleParams | null = null;
              try { params = decodeV2Circle(entry.encoded); } catch { /* ignored */ }
              if (!params) return null;
              return <button type="button" key={entry.encoded} className={selected === entry.encoded ? "classic-saved-item selected" : "classic-saved-item"} onClick={() => setSelected(entry.encoded)}>
                <b>{params.name}</b><span>Chipnet · {params.members.length} members · {formatBch(params.contribution)} each</span>
                <small>Saved {new Date(entry.savedAt).toLocaleDateString()}</small>
              </button>;
            })}
          </div> : <p className="classic-empty">No V2 circles saved in this browser.</p>}
          <form className="classic-restore-form" onSubmit={restore}>
            <label>Restore V2 invite link<input value={restoreInput} onChange={(event) => setRestoreInput(event.target.value)} placeholder="Paste V2 invite URL" /></label>
            <button type="submit" className="secondary-button">Restore V2 circle</button>
          </form>
        </div>
      </div>
      {active && <div className="classic-active-circle">
        <div className="section-heading"><div><span className="section-kicker">CHIPNET V2 CIRCLE</span><h3>{active.name}</h3></div>
          <button className="secondary-button" type="button" onClick={copyInvite}>Copy invite</button></div>
        <p className="classic-contract-address">State token category: <code>{active.stateCategory}</code></p>
        {snapshot ? <>
          <div className="classic-account-summary classic-chain-stats">
            <div><b>{snapshot.completed ? "Complete" : (snapshot.round + 1) + " / " + active.members.length}</b><span>Current payout round</span></div>
            <div><b>{formatBch(snapshot.stateSatoshis)}</b><span>State reserve</span></div>
            <div><b>{snapshot.ready ? "Ready" : "Waiting"}</b><span>All member credits</span></div>
          </div>
          <div className="classic-members">
            {snapshot.credits.map((credit, index) => <div key={active.members[index]}>
              <b>Member {index + 1}{memberIndex === index ? " · Your wallet" : ""}</b>
              <code>{active.members[index]}</code>
              <span>{formatBch(credit)} credited · {formatBch(credit >= active.contribution ? active.contribution : credit)} toward next round</span>
            </div>)}
          </div>
          <p className="classic-recipient">{snapshot.completed ? "All scheduled V2 payouts are complete." : <>Next payout recipient: <b>Member {snapshot.round + 1}</b> · {snapshot.recipient}</>}</p>
        </> : <p className="classic-empty">Reading the state NFT and every member receipt from Chipnet. Refresh after confirmation if the genesis transaction is still pending.</p>}
        <label className="classic-deposit-field">Deposit amount (BCH)<input value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} inputMode="decimal" /></label>
        <div className="classic-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void refresh()}>Refresh</button>
          <button type="button" className="secondary-button" disabled={busy || memberIndex < 0 || network !== "chipnet" || Boolean(snapshot?.completed)} onClick={() => void deposit()}>
            {memberIndex < 0 ? "Connect a member wallet" : "Add my member credit"}
          </button>
          <button type="button" className="primary-button" disabled={busy || !snapshot?.ready || network !== "chipnet"} onClick={() => void payout()}>
            {snapshot?.completed ? "Circle complete" : "Payout next round"}
          </button>
        </div>
      </div>}
      {busy && <p className="classic-feedback" role="status">Preparing a Chipnet transaction…</p>}
      {notice && <p className="classic-feedback" role="status">{notice}</p>}
      {error && <p className="classic-error" role="alert">{error}</p>}
    </section>
  );
}
