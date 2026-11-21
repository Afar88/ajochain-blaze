import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { plainErrorSummary } from "./error-copy";
import { CashTokensGenesisUtxoMissingError, decodeClassicCircle, getClassicProvider, planClassicContribution, planClassicGenesis, planClassicGenesisSetup, planClassicPayout, readClassicCircle, type ClassicCircleParams, type ClassicCircleStatus } from "../core/classic-bch";
import { assertBchTransactionBroadcastAllowed } from "../core/bch-mainnet-guard";
import { buildClassicInviteRoute, loadSavedClassicCircles, restoreClassicCircleFromInvite, saveClassicCircle, type SavedClassicCircle } from "../core/circle-account";
import { parseAssetAmount } from "../core/assets";
import { formatBch, type NetworkId } from "../core/network";
import { wallet } from "../core/wizard-wallet";
import { updateSavedCircleChainStatus } from "../circles/saved-circle-status";
import { useNoticeFade } from "./notice-display";
import { WorkspaceNotice } from "./WorkspaceNotice";
import { shortClassic, toCashTokenAddress } from "../core/bch-address";
import { recallSnapshot, rememberSnapshot } from "./remembered-snapshots";

type Props = {
  network: NetworkId;
  walletConnected: boolean;
  selectedCircle?: string | null;
  onBusyChange?: (busy: boolean) => void;
};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function ClassicBchWorkspace({ network, walletConnected, selectedCircle = null, onBusyChange }: Props) {
  const [saved, setSaved] = useState<SavedClassicCircle[]>(() => loadSavedClassicCircles(window.localStorage));
  const [selected, setSelected] = useState<string | null>(() => selectedCircle ?? loadSavedClassicCircles(window.localStorage).find((entry) => {
    try { return decodeClassicCircle(entry.encoded).network === network; } catch { return false; }
  })?.encoded ?? null);
  const [name, setName] = useState(() => "Ajo circle – " + new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" }));
  const [amount, setAmount] = useState("0.001");
  const [maxFee, setMaxFee] = useState("10000");
  const [membersText, setMembersText] = useState("");
  const [restoreInput, setRestoreInput] = useState("");
  const [status, setStatus] = useState<ClassicCircleStatus | null>(null);
  // True when the last read failed and the details shown are from an earlier check.
  const [statusStale, setStatusStale] = useState(false);
  // True while remembered details are shown and a fresh read is still running.
  const [checkingSaved, setCheckingSaved] = useState(false);
  const quietRefreshTimersRef = useRef<number[]>([]);
  const selectedRef = useRef<string | null>(null);
  const [contractAddress, setContractAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useNoticeFade(notice, () => setNotice(""));

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const activeCircle = useMemo(() => {
    if (!selected) return null;
    try {
      const circle = decodeClassicCircle(selected);
      return circle.network === network ? circle : null;
    } catch { return null; }
  }, [selected, network]);

  const networkSavedCount = useMemo(() => saved.filter((entry) => {
    try { return decodeClassicCircle(entry.encoded).network === network; } catch { return false; }
  }).length, [saved, network]);

  useEffect(() => {
    if (selectedCircle) return;
    const next = loadSavedClassicCircles(window.localStorage).find((entry) => {
      try { return decodeClassicCircle(entry.encoded).network === network; } catch { return false; }
    });
    setSelected(next?.encoded ?? null);
  }, [network, selectedCircle]);

  const persist = (params: ClassicCircleParams) => {
    const next = saveClassicCircle(window.localStorage, params);
    setSaved(next);
    setSelected(next[0]?.encoded ?? null);
  };

  const saveChainProgress = (params: ClassicCircleParams, circleStatus: ClassicCircleStatus, encoded: string | null) => {
    if (!encoded) return;
    updateSavedCircleChainStatus(window.localStorage, {
      id: "classic:" + params.network + ":" + params.stateCategory.toLowerCase(),
      encoded,
      network: params.network,
      kind: "classic",
      name: params.name,
      asset: "BCH",
      contribution: params.contribution.toString(),
      memberCount: params.members.length,
    }, circleStatus.completed ? "completed" : "active", circleStatus.round, null);
  };

  const refresh = async (params = activeCircle) => {
    if (!params) return;
    setBusy(true);
    setError("");
    try {
      const snapshot = await readClassicCircle(params);
      setStatus(snapshot.status);
      setStatusStale(false);
      rememberSnapshot(selected, { status: snapshot.status, contractAddress: snapshot.contract.address });
      saveChainProgress(params, snapshot.status, selected);
      setContractAddress(snapshot.contract.address);
      setNotice("Circle details updated.");
    } catch (cause) {
      // Keep the last good details on screen and say they may be out of date.
      setStatusStale(true);
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  // After a send, re-read the circle in the background a few seconds later so
  // the network has the new transaction. This never changes the message or
  // error on screen, and a failed read keeps the details already shown.
  const refreshQuietly = (params: ClassicCircleParams, encoded: string | null, delayMs = 3_000) => {
    const timer = window.setTimeout(() => {
      quietRefreshTimersRef.current = quietRefreshTimersRef.current.filter((id) => id !== timer);
      void readClassicCircle(params).then((snapshot) => {
        if (selectedRef.current !== encoded) return;
        setStatus(snapshot.status);
        setStatusStale(false);
        rememberSnapshot(encoded, { status: snapshot.status, contractAddress: snapshot.contract.address });
        saveChainProgress(params, snapshot.status, encoded);
        setContractAddress(snapshot.contract.address);
      }).catch(() => {
        if (selectedRef.current === encoded) setStatusStale(true);
      });
    }, delayMs);
    quietRefreshTimersRef.current.push(timer);
  };

  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => () => {
    for (const timer of quietRefreshTimersRef.current) window.clearTimeout(timer);
    quietRefreshTimersRef.current = [];
  }, []);

  useEffect(() => {
    if (!activeCircle) {
      setStatus(null);
      return;
    }
    let current = true;
    // Show what we read last time right away; replace it when the fresh read lands.
    const remembered = recallSnapshot<{ status: ClassicCircleStatus; contractAddress: string }>(selected);
    setStatus(remembered?.status ?? null);
    if (remembered) setContractAddress(remembered.contractAddress);
    setStatusStale(false);
    setCheckingSaved(Boolean(remembered));
    void readClassicCircle(activeCircle).then((snapshot) => {
      if (current) {
        setStatus(snapshot.status);
        setCheckingSaved(false);
        rememberSnapshot(selected, { status: snapshot.status, contractAddress: snapshot.contract.address });
        saveChainProgress(activeCircle, snapshot.status, selected);
        setContractAddress(snapshot.contract.address);
      }
    }).catch((cause: unknown) => {
      if (!current) return;
      setCheckingSaved(false);
      if (remembered) setStatusStale(true);
      setError(message(cause));
    });
    return () => { current = false; };
  }, [selected, activeCircle?.stateCategory, network]);

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
      setError("Connect Selene in Selene, then submit the circle again.");
      return;
    }
    const walletAddress = wallet.address(network);
    if (!walletAddress) {
      setError("No wallet address is available for this network. Reconnect Selene first.");
      return;
    }
    const members = membersText.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    try {
      const contribution = parseAssetAmount("BCH", amount);
      const feeCap = BigInt(maxFee.trim());
      if (!/^\d+$/.test(maxFee.trim())) throw new Error("Maximum fee must be a whole number of satoshis.");
      const draft = { version: 1 as const, name: name.trim(), network, members, contribution, maxFee: feeCap };
      setBusy(true);

      const pendingKey = "ajochain:classic-genesis-setup:v1:" + network + ":" + walletAddress.toLowerCase();
      let pendingSetup: { status: string; txid?: string; createdAt?: number } | null = null;
      try {
        const rawPending = window.localStorage.getItem(pendingKey);
        if (rawPending) {
          const parsed = JSON.parse(rawPending) as { status?: unknown; txid?: unknown; createdAt?: unknown };
          if (parsed.status === "broadcast" && typeof parsed.txid === "string" && /^[0-9a-f]{64}$/i.test(parsed.txid)) {
            pendingSetup = { status: "broadcast", txid: parsed.txid, createdAt: Number(parsed.createdAt) || undefined };
          } else if (parsed.status === "unknown" || parsed.status === "signing") {
            // First check whether a valid vout-0 coin is now present. If it is,
            // the existing planner can safely use it without another setup spend.
            pendingSetup = { status: parsed.status };
          } else {
            throw new Error("A previous CashTokens setup attempt is still recorded for this wallet. Check Selene and the Chipnet transaction history before trying again; AjoChain will not create a duplicate setup transaction.");
          }
        }
      } catch (cause) {
        if (cause instanceof Error && (cause.message.startsWith("A previous CashTokens") || cause.message.startsWith("AjoChain could not confirm"))) throw cause;
        throw new Error("AjoChain could not safely read its pending setup record. No new transaction was prepared.");
      }

      let plan: Awaited<ReturnType<typeof planClassicGenesis>>;
      try {
        plan = await planClassicGenesis(draft, walletAddress);
      } catch (cause) {
        if (!(cause instanceof CashTokensGenesisUtxoMissingError) || network !== "chipnet") throw cause;

        if (pendingSetup?.status === "unknown" || pendingSetup?.status === "signing") {
          throw new Error(
            pendingSetup.status === "unknown"
              ? "AjoChain could not confirm whether the previous setup transaction reached Chipnet. Check Selene and the Chipnet wallet history before retrying; duplicate setup transactions are blocked."
              : "A previous CashTokens setup attempt was interrupted before its broadcast result was saved. Check Selene and the Chipnet wallet history before retrying; AjoChain will not create a duplicate setup transaction.",
          );
        } else if (pendingSetup?.txid) {
          const provider = await getClassicProvider("chipnet");
          const currentUtxos = await provider.getUtxos(walletAddress);
          const pendingOutput = currentUtxos.find((utxo) =>
            utxo.txid.toLowerCase() === pendingSetup!.txid!.toLowerCase() &&
            utxo.vout === 0 && !utxo.token && utxo.satoshis > 0n
          );
          if (!pendingOutput) {
            throw new Error(
              "AjoChain already broadcast your setup transaction (" + pendingSetup.txid +
              "), but its output-0 coin is not yet visible as spendable in the wallet. " +
              "Do not send another setup transaction. Refresh and retry after Chipnet indexes that output.",
            );
          }
          plan = await planClassicGenesis(draft, walletAddress);
        } else {
          const setup = await planClassicGenesisSetup(walletAddress);
          if (!window.confirm(
            "Step 1 of 2 · Prepare your small Chipnet setup coin?\n\n" +
            "AjoChain will send " + setup.outputSatoshis.toString() + " sats to your wallet. " +
            "The rest returns to your wallet, minus an estimated " + setup.fee.toString() +
            "-sat miner fee.\n\n" +
            "This does not create your circle yet. After the setup coin appears, approve again in Selene. " +
            "You won't need to make another deposit.",
          )) return;

          // Reserve this wallet/network operation before requesting a signature so
          // a reload cannot silently create another setup transaction.
          try {
            window.localStorage.setItem(pendingKey, JSON.stringify({
              status: "signing",
              createdAt: Date.now(),
            }));
          } catch {
            throw new Error("Browser storage is unavailable. AjoChain cannot safely track a pending setup transaction, so nothing was signed or broadcast.");
          }

          let signedSetup: Awaited<ReturnType<typeof wallet.signAndVerify>>;
          try {
            signedSetup = await wallet.signAndVerify(
              setup.wc,
              setup.walletInputs,
              "Prepare your Chipnet setup coin for AjoChain",
            );
          } catch (cause) {
            try { window.localStorage.removeItem(pendingKey); } catch { /* best effort */ }
            throw cause;
          }

          let setupTxid: string;
          try {
            setupTxid = await setup.provider.sendRawTransaction(signedSetup.signedTransaction);
          } catch (cause) {
            // Submission may have reached the node even when the response was
            // lost. Keep the retry lock rather than risk broadcasting twice.
            try {
              window.localStorage.setItem(pendingKey, JSON.stringify({
                status: "unknown",
                createdAt: Date.now(),
              }));
            } catch { /* keep the earlier signing reservation if possible */ }
            throw new Error(
              "The setup transaction was signed, but Chipnet did not confirm its submission. " +
              "AjoChain has blocked automatic retries to avoid a duplicate. Check your wallet history first. " +
              message(cause),
            );
          }

          try {
            window.localStorage.setItem(pendingKey, JSON.stringify({
              status: "broadcast",
              txid: setupTxid,
              createdAt: Date.now(),
            }));
          } catch {
            setNotice(
              "Setup transaction broadcast: " + setupTxid +
              ". The browser could not update its pending record. Do not submit another setup transaction; check this transaction in Chipnet and refresh the wallet before continuing.",
            );
            return;
          }

          const refreshedUtxos = await setup.provider.getUtxos(walletAddress);
          const setupOutputVisible = refreshedUtxos.some((utxo) =>
            utxo.txid.toLowerCase() === setupTxid.toLowerCase() &&
            utxo.vout === 0 && !utxo.token && utxo.satoshis > 0n
          );
          if (!setupOutputVisible) {
            setNotice(
              "Setup transaction broadcast: " + setupTxid +
              ". The new vout-0 coin is not visible yet, so the circle NFT has not been created. " +
              "Refresh and submit this same form again when the wallet reports the output. AjoChain will not create a duplicate setup transaction.",
            );
            return;
          }
          plan = await planClassicGenesis(draft, walletAddress);
        }
      }

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
        "Step 2 of 2 · Create this Classic BCH circle on Chipnet?\n\n" +
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
      // Retain the setup outpoint lock until the category transaction succeeds.
      // This prevents a retry from creating a duplicate setup after an uncertain
      // circle-creation broadcast.
      try { window.localStorage.removeItem(pendingKey); } catch { /* best effort */ }
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
        " on Chipnet?\n\nThe contribution goes to this circle address:\n" + plan.contract.address,
      )) return;
      const signed = await wallet.signAndVerify(
        plan.wc,
        plan.walletInputs,
        "Contribute to AjoChain circle: " + activeCircle.name,
      );
      const txid = await plan.provider.sendRawTransaction(signed.signedTransaction);
      setNotice("Contribution broadcast. Transaction ID: " + txid);
      refreshQuietly(activeCircle, selected);
      window.dispatchEvent(new Event("ajochain:wallet-balances-changed"));
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
        "Send the payout for round " + (plan.round + 1) + "?\n\n" +
        "Recipient: " + plan.recipient + "\n" +
        "Recipient amount: " + formatBch(plan.payoutAmount) + "\n" +
        "Miner fee: up to " + plan.fee.toString() + " sats\n\n" +
        "The circle rules send this payout to the selected member. It cannot be redirected here.",
      )) return;
      const txid = await plan.provider.sendRawTransaction(plan.builder.build());
      setNotice("Payout broadcast. Transaction ID: " + txid);
      refreshQuietly(activeCircle, selected);
      window.dispatchEvent(new Event("ajochain:wallet-balances-changed"));
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
      if (restored.network !== network) {
        throw new Error("This invite is for " + (restored.network === "mainnet" ? "Mainnet" : "Chipnet") + ". Use the network switcher before restoring it here.");
      }
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
          <span className="section-kicker">CLASSIC BCH · OLDER SAVINGS</span>
          <h2 id="classic-workspace-title">Create and manage circles</h2>
          <p>Create circles, pay in and collect payouts.</p>
        </div>
        <span className={network === "mainnet" ? "classic-network mainnet" : "classic-network"}>
          {network === "mainnet" ? "Mainnet" : "Chipnet · test"}
        </span>
      </div>

      <div className="classic-account-summary">
        <div><b>{networkSavedCount}</b><span>Circles on this network</span></div>
        <div><b>{walletConnected ? "Connected" : "Not connected"}</b><span>Selene wallet</span></div>
        <p>Circles stay on this phone. Save invite links for recovery.</p>
      </div>

      <div className="classic-workspace-grid">
        <div className="classic-create-panel">
          <h3>Start a Classic BCH circle</h3>
          <p>2–5 unique BCH addresses, in payout order.</p><small>One shared pot. Individual deposits aren't tracked.</small>
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
          <h3>Restore an existing circle</h3>
          <form className="classic-restore-form" onSubmit={restore}>
            <label>Circle invite link
              <input value={restoreInput} onChange={(event) => setRestoreInput(event.target.value)} placeholder="Paste the full invite URL" />
            </label>
            <button type="submit" className="secondary-button">Restore circle</button>
          </form>
          <p className="classic-empty">Saved circles appear in My circles for this network.</p>
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
              <div key={member}><b>Member {index + 1}</b><code>{toCashTokenAddress(member)}</code>
                {toCashTokenAddress(member) !== member && <small className="wallet-classic-address">Same as {shortClassic(member)}</small>}</div>
            ))}
          </div>
          {status && checkingSaved && !statusStale && <p className="field-hint refresh-stale-note checking" role="status">Showing the last details we read. Checking for updates…</p>}
          {status && statusStale && <p className="field-hint refresh-stale-note" role="status">These details may be out of date. The latest check didn't finish, so this is the last result we have.</p>}
          {status ? (
            <>
              <div className="classic-account-summary classic-chain-stats">
                <div><b>{status.round === null ? "Not started" : status.completed ? "Complete" : (status.round + 1) + " / " + activeCircle.members.length}</b><span>Current round</span></div>
                <div><b>{formatBch(status.available)}</b><span>Observed pot</span></div>
                <div><b>{status.ready ? "Ready" : formatBch(status.shortfall) + " short"}</b><span>Next payout condition</span></div>
              </div>
              {status.issues.length > 0 && <ul className="classic-issues">{status.issues.map((item) => <li key={item}>{item}</li>)}</ul>}
              {status.recipient && <p className="classic-recipient">Next payout recipient: <b>{status.recipient}</b></p>}
            </>
          ) : (
            <p className="classic-empty">Checking the circle. Refresh if the network is unavailable.</p>
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
          <p className="classic-disclaimer">Classic V1 uses one shared pot. Member deposits aren't tracked.</p>
          <p className="classic-disclaimer">Mainnet payments are disabled in this build.</p>
        </div>
      )}

      {busy && <p className="classic-feedback" role="status">Working with the selected BCH network…</p>}
      <WorkspaceNotice notice={notice} className="classic-feedback" onClose={() => setNotice("")} />
      {error && <div className="classic-error" role="alert">
        <span>{plainErrorSummary(error)}</span>
        <details className="technical-details"><summary>Details</summary><p>{error}</p></details>
        <button type="button" className="inline-dismiss" aria-label="Close error" onClick={() => setError("")}>×</button>
      </div>}
    </section>
  );
}
