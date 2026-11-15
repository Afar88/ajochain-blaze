import { useEffect, useMemo, useState, type FormEvent } from "react";
import { decodeClassicCircle, planClassicContribution, planClassicGenesis, planClassicPayout, readClassicCircle, type ClassicCircleParams, type ClassicCircleStatus } from "../core/classic-bch";
import { assertBchTransactionBroadcastAllowed } from "../core/bch-mainnet-guard";
import { buildClassicInviteRoute, loadSavedClassicCircles, restoreClassicCircleFromInvite, saveClassicCircle, type SavedClassicCircle } from "../core/circle-account";
import { parseAssetAmount } from "../core/assets";
import { formatBch, type NetworkId } from "../core/network";
import { wallet } from "../core/wizard-wallet";

type Props = {
  network: NetworkId;
  walletConnected: boolean;
};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function ClassicBchWorkspace({ network, walletConnected }: Props) {
  const [saved, setSaved] = useState<SavedClassicCircle[]>(() => loadSavedClassicCircles(window.localStorage));
  const [selected, setSelected] = useState<string | null>(() => loadSavedClassicCircles(window.localStorage)[0]?.encoded ?? null);
  const [name, setName] = useState("My Ajo Circle");
  const [amount, setAmount] = useState("0.001");
  const [maxFee, setMaxFee] = useState("10000");
  const [membersText, setMembersText] = useState("");
  const [restoreInput, setRestoreInput] = useState("");
  const [status, setStatus] = useState<ClassicCircleStatus | null>(null);
  const [contractAddress, setContractAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const activeCircle = useMemo(() => {
    if (!selected) return null;
    try { return decodeClassicCircle(selected); } catch { return null; }
  }, [selected]);

  const persist = (params: ClassicCircleParams) => {
    const next = saveClassicCircle(window.localStorage, params);
    setSaved(next);
    setSelected(next[0]?.encoded ?? null);
  };

  const refresh = async (params = activeCircle) => {
    if (!params) return;
    setBusy(true);
    setError("");
    try {
      const snapshot = await readClassicCircle(params);
      setStatus(snapshot.status);
      setContractAddress(snapshot.contract.address);
      setNotice("Chain data refreshed from " + params.network + ". A provider response is not a substitute for an independent Mainnet verification quorum.");
    } catch (cause) {
      setStatus(null);
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!activeCircle) {
      setStatus(null);
      return;
    }
    let current = true;
    setStatus(null);
    void readClassicCircle(activeCircle).then((snapshot) => {
      if (current) { setStatus(snapshot.status); setContractAddress(snapshot.contract.address); }
    }).catch((cause: unknown) => {
      if (current) setError(message(cause));
    });
    return () => { current = false; };
  }, [selected, activeCircle?.stateCategory]);

  const connect = () => {
    setError("");
    if (wallet.state === "disconnected") {
      if (!wallet.tryResume()) wallet.connect();
    } else if (wallet.state === "idle") {
      wallet.connect();
    }
  };

  const startCircle = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!walletConnected || wallet.state !== "connected") {
      connect();
      setError("Connect Selene through WizardConnect, then submit the circle again.");
      return;
    }
    const walletAddress = wallet.address(network);
    if (!walletAddress) {
      setError("The connected wallet does not have a verified receive address for this network.");
      return;
    }
    const members = membersText.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    try {
      const contribution = parseAssetAmount("BCH", amount);
      const feeCap = BigInt(maxFee.trim());
      if (!/^\d+$/.test(maxFee.trim())) throw new Error("Maximum fee must be a whole number of satoshis.");
      const draft = { version: 1 as const, name: name.trim(), network, members, contribution, maxFee: feeCap };
      setBusy(true);
      const plan = await planClassicGenesis(draft, walletAddress);
      setContractAddress(plan.contract.address);
      try {
        assertBchTransactionBroadcastAllowed(network);
      } catch (gate) {
        setNotice(
          "Mainnet plan prepared for review only. Contract address: " + plan.contract.address +
          ". Estimated miner fee: " + plan.fee.toString() + " sats. No signature was requested and no transaction was broadcast. " +
          message(gate),
        );
        return;
      }
      if (!window.confirm(
        "Create this Classic BCH circle on Chipnet?\n\n" +
        plan.contract.address + "\n" +
        "Contribution: " + formatBch(contribution) + " per member\n" +
        "This deploys the circle state NFT and spends wallet BCH for the miner fee.",
      )) return;
      const signed = await wallet.signAndVerify(
        plan.wc,
        plan.walletInputs,
        "Create AjoChain circle: " + draft.name,
      );
      const txid = await plan.provider.sendRawTransaction(signed.signedTransaction);
      persist(plan.params);
      setNotice("Circle creation broadcast on Chipnet. Transaction ID: " + txid + ". Save and share the invite link below.");
      setStatus(null);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const contribute = async () => {
    if (!activeCircle) return;
    setError("");
    setNotice("");
    if (!walletConnected || wallet.state !== "connected") {
      connect();
      setError("Connect the wallet that will fund this contribution, then try again.");
      return;
    }
    const walletAddress = wallet.address(activeCircle.network);
    if (!walletAddress) {
      setError("No receive address is available for the circle's network.");
      return;
    }
    setBusy(true);
    try {
      const plan = await planClassicContribution(activeCircle, walletAddress);
      assertBchTransactionBroadcastAllowed(activeCircle.network);
      if (!window.confirm(
        "Contribute " + formatBch(activeCircle.contribution) + " to " + activeCircle.name +
        " on Chipnet?\n\nThe contribution goes to the covenant address:\n" + plan.contract.address,
      )) return;
      const signed = await wallet.signAndVerify(
        plan.wc,
        plan.walletInputs,
        "Contribute to AjoChain circle: " + activeCircle.name,
      );
      const txid = await plan.provider.sendRawTransaction(signed.signedTransaction);
      setNotice("Contribution broadcast. Transaction ID: " + txid);
      await refresh(activeCircle);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const payout = async () => {
    if (!activeCircle) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const plan = await planClassicPayout(activeCircle);
      assertBchTransactionBroadcastAllowed(activeCircle.network);
      if (!window.confirm(
        "Broadcast the covenant payout for round " + (plan.round + 1) + "?\n\n" +
        "Recipient: " + plan.recipient + "\n" +
        "Recipient amount: " + formatBch(plan.payoutAmount) + "\n" +
        "Miner fee: up to " + plan.fee.toString() + " sats\n\n" +
        "The payout is enforced by the circle covenant and cannot be redirected here.",
      )) return;
      const txid = await plan.provider.sendRawTransaction(plan.builder.build());
      setNotice("Payout broadcast. Transaction ID: " + txid);
      await refresh(activeCircle);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const restore = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    try {
      const restored = restoreClassicCircleFromInvite(restoreInput);
      const next = saveClassicCircle(window.localStorage, restored);
      setSaved(next);
      setSelected(next[0]?.encoded ?? null);
      setRestoreInput("");
      setNotice("Circle link restored to this browser. The chain will be read next; restoring a link does not prove funds or membership.");
    } catch (cause) {
      setError(message(cause));
    }
  };

  const copyInvite = async () => {
    if (!activeCircle) return;
    const route = buildClassicInviteRoute(activeCircle);
    const url = window.location.origin + window.location.pathname + route;
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Invite link copied.");
    } catch {
      setNotice("Copy is unavailable in this browser. Invite route: " + route);
    }
  };

  return (
    <section className="classic-workspace section-card" aria-labelledby="classic-workspace-title">
      <div className="section-heading classic-workspace-heading">
        <div>
          <span className="section-kicker">CLASSIC BCH · V1 CONTRACT</span>
          <h2 id="classic-workspace-title">Create and manage circles</h2>
          <p>Live Chipnet creation, contributions, covenant payouts, and invite recovery.</p>
        </div>
        <span className={network === "mainnet" ? "classic-network mainnet" : "classic-network"}>
          {network === "mainnet" ? "Mainnet · read-only" : "Chipnet · test"}
        </span>
      </div>

      <div className="classic-account-summary">
        <div><b>{saved.length}</b><span>Circles saved on this browser</span></div>
        <div><b>{walletConnected ? "Connected" : "Not connected"}</b><span>WizardConnect wallet</span></div>
        <p>Local account index only. It does not create a cloud login or synchronize data across devices; keep invite links as a recovery method.</p>
      </div>

      <div className="classic-workspace-grid">
        <div className="classic-create-panel">
          <h3>Start a Classic BCH circle</h3>
          <p>2–5 unique BCH member addresses in payout order. Classic V1 is an aggregate pot: the contract controls payout order but does not prove which member funded a contribution.</p>
          <form onSubmit={startCircle}>
            <label>Circle name
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required />
            </label>
            <label>Contribution per member (BCH)
              <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.001" required />
            </label>
            <label>Maximum miner fee per payout (sats)
              <input value={maxFee} onChange={(event) => setMaxFee(event.target.value)} inputMode="numeric" required />
            </label>
            <label>Member BCH addresses · one per line
              <textarea value={membersText} onChange={(event) => setMembersText(event.target.value)} rows={4} placeholder="Paste the first member address&#10;Paste the second member address" required />
            </label>
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? "Preparing…" : network === "mainnet" ? "Prepare Mainnet plan" : "Create circle on Chipnet"}
            </button>
          </form>
        </div>

        <div className="classic-account-panel">
          <h3>My circles</h3>
          {saved.length ? (
            <div className="classic-saved-list">
              {saved.map((entry) => {
                let params: ClassicCircleParams | null = null;
                try { params = decodeClassicCircle(entry.encoded); } catch { /* filtered by loader */ }
                if (!params) return null;
                return (
                  <button
                    type="button"
                    key={entry.encoded}
                    className={selected === entry.encoded ? "classic-saved-item selected" : "classic-saved-item"}
                    onClick={() => { setSelected(entry.encoded); setError(""); }}
                  >
                    <b>{params.name}</b>
                    <span>{params.network} · {params.members.length} members · {formatBch(params.contribution)} each</span>
                    <small>Saved {new Date(entry.savedAt).toLocaleDateString()}</small>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="classic-empty">No circles saved yet. Create one or restore an invite link.</p>
          )}
          <form className="classic-restore-form" onSubmit={restore}>
            <label>Restore a circle invite link
              <input value={restoreInput} onChange={(event) => setRestoreInput(event.target.value)} placeholder="Paste the full invite URL" />
            </label>
            <button type="submit" className="secondary-button">Restore circle</button>
          </form>
        </div>
      </div>

      {activeCircle && (
        <div className="classic-active-circle">
          <div className="section-heading">
            <div><span className="section-kicker">SELECTED CIRCLE · {activeCircle.network.toUpperCase()}</span><h3>{activeCircle.name}</h3></div>
            <button type="button" className="secondary-button" onClick={copyInvite}>Copy invite link</button>
          </div>
          <p className="classic-contract-address">Contract address: <code>{contractAddress || "Loading…"}</code></p>
          <div className="classic-members">
            {activeCircle.members.map((member, index) => (
              <div key={member}><b>Member {index + 1}</b><code>{member}</code></div>
            ))}
          </div>
          {status ? (
            <>
              <div className="classic-account-summary classic-chain-stats">
                <div><b>{status.round === null ? "Not started" : status.completed ? "Complete" : (status.round + 1) + " / " + activeCircle.members.length}</b><span>Current round</span></div>
                <div><b>{formatBch(status.available)}</b><span>Confirmed pot contributions</span></div>
                <div><b>{status.ready ? "Ready" : formatBch(status.shortfall) + " short"}</b><span>Next payout condition</span></div>
              </div>
              {status.issues.length > 0 && <ul className="classic-issues">{status.issues.map((item) => <li key={item}>{item}</li>)}</ul>}
              {status.recipient && <p className="classic-recipient">Next payout recipient: <b>{status.recipient}</b></p>}
            </>
          ) : (
            <p className="classic-empty">Reading circle state from its original network. Use refresh to retry if the Electrum provider is unavailable.</p>
          )}
          <div className="classic-actions">
            <button type="button" className="secondary-button" onClick={() => void refresh()} disabled={busy}>Refresh chain state</button>
            <button type="button" className="secondary-button" onClick={() => void contribute()} disabled={busy}>
              Contribute {formatBch(activeCircle.contribution)}
            </button>
            <button type="button" className="primary-button" onClick={() => void payout()} disabled={busy || !status?.ready || activeCircle.network !== network}>
              {status?.completed ? "Circle complete" : "Pay out next round"}
            </button>
          </div>
          <p className="classic-disclaimer">Classic V1 does not track individual member credit or late payments. Chain state, not this browser's saved list, determines whether a payout is possible. The Mainnet transaction kill-switch remains closed in this build.</p>
        </div>
      )}

      {busy && <p className="classic-feedback" role="status">Working with the selected BCH network…</p>}
      {notice && <p className="classic-feedback" role="status">{notice}</p>}
      {error && <p className="classic-error" role="alert">{error}</p>}
    </section>
  );
}
