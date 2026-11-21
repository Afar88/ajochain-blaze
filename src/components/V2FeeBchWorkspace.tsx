import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { parseAssetAmount } from "../core/assets";
import { CashTokensGenesisUtxoMissingError, classicAddressToPkh, getClassicProvider, planClassicGenesisSetup } from "../core/classic-bch";
import { formatBch, type NetworkId } from "../core/network";
import { wallet } from "../core/wizard-wallet";
import { dedupeSavedV2FeeCircleRecords, getV2FeeCircleRecordIdentity } from "../core/v2-fee-circle-records";
import { updateSavedCircleChainStatus } from "../circles/saved-circle-status";
import { encodeV2FeeCircleParams } from "../core/v2-fee-discovery";
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
  return encodeV2FeeCircleParams(params);
}

function decodeCircle(encoded: string): V2FeeCircleParams {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  if (value.version !== 2 || typeof value.covenant !== "string" || !["fee-v1", "fee-v2-escrow", "fee-v3-auto-reserve", "fee-v1-guarded", "fee-v2-escrow-guarded", "fee-v3-auto-reserve-guarded", "fee-v3-auto-reserve-closing"].includes(value.covenant) || value.network !== "chipnet" ||
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
    return dedupeSavedV2FeeCircleRecords(value).filter((item) => {
      try { decodeCircle(item.encoded); return true; } catch { return false; }
    });
  } catch { return []; }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type Props = {
  network: NetworkId;
  walletConnected: boolean;
  view?: "create" | "circle";
  selectedCircle?: string | null;
  onCircleSaved?: () => void;
  onBusyChange?: (busy: boolean) => void;
};

export default function V2FeeBchWorkspace({
  network, walletConnected, view = "create", selectedCircle = null, onCircleSaved, onBusyChange,
}: Props) {
  const [, setSaved] = useState<SavedCircle[]>(readSaved);
  const [selected, setSelected] = useState<string | null>(() => selectedCircle ?? readSaved()[0]?.encoded ?? null);
  const [name, setName] = useState(() => "Ajo circle – " + new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" }));
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

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const active = useMemo(() => {
    if (!selected) return null;
    try { return decodeCircle(selected); } catch { return null; }
  }, [selected]);

  const persist = (params: V2FeeCircleParams) => {
    const encoded = encodeCircle(params);
    // Merge with storage, not component state: wallet discovery may have added circles since mount.
    const next = dedupeSavedV2FeeCircleRecords([{ encoded, savedAt: Date.now() }, ...readSaved()]);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSaved(next);
    setSelected(encoded);
    onCircleSaved?.();
  };

  const persistChainProgress = (params: V2FeeCircleParams, encoded: string, result: Snapshot) => {
    const identity = getV2FeeCircleRecordIdentity(encoded);
    if (!identity) return;
    updateSavedCircleChainStatus(window.localStorage, {
      id: "v2:" + identity.key,
      encoded,
      network: params.network,
      kind: params.network === "mainnet" ? "bch-mainnet" : "v2-fee",
      name: params.name,
      asset: "BCH",
      contribution: params.contribution.toString(),
      memberCount: params.members.length,
    }, result.closedAs === "cancelled" ? "cancelled" : result.completed ? "completed" : "active",
    result.round, result.completedAt ?? null);
  };

  const refresh = async (params = active) => {
    if (!params) return;
    setBusy(true);
    setError("");
    try {
      const result = await readV2FeeCircle(params);
      setSnapshot(result);
      if (selected) persistChainProgress(params, selected, result);
      setNotice("V2 fee-circle state and every member receipt were read from Chipnet.");
    } catch (cause) {
      setSnapshot(null);
      setError(errorText(cause));
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (selectedCircle) {
      setSelected(selectedCircle);
      setError("");
      setNotice("");
    }
  }, [selectedCircle]);

  useEffect(() => {
    if (!active) { setSnapshot(null); return; }
    let current = true;
    setSnapshot(null);
    void readV2FeeCircle(active).then((result) => {
      if (current) {
        setSnapshot(result);
        if (selected) persistChainProgress(active, selected, result);
      }
    }).catch((cause: unknown) => {
      if (current) setError(errorText(cause));
    });
    return () => { current = false; };
  }, [selected]);

  useEffect(() => {
    if (!active || !walletConnected || wallet.state !== "connected") return;
    const currentAddress = wallet.address("chipnet");
    if (currentAddress) {
      try {
        const currentKey = bytesToHex(classicAddressToPkh(currentAddress, "chipnet"));
        if (active.members.some((member) =>
          bytesToHex(classicAddressToPkh(member, "chipnet")) === currentKey,
        )) return;
      } catch { /* scan the registered member addresses below */ }
    }

    // Selene may be displaying a receive address at an index other than the
    // currently selected one. Search the connected wallet's public receive
    // branch and select the registered member address automatically.
    for (const memberAddress of active.members) {
      try {
        const matchedIndex = wallet.matchReceiveAddress(memberAddress, "chipnet", 50);
        if (matchedIndex !== null) {
          setNotice("Matched this Selene wallet to its registered circle member address (receive index " + matchedIndex + ").");
          return;
        }
      } catch {
        return;
      }
    }
  }, [selected, walletConnected, wallet.state]);

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
      setError("Switch to Chipnet to continue.");
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
        covenant: "fee-v3-auto-reserve-closing",
        name: name.trim(),
        network: "chipnet",
        members,
        contribution: parseAssetAmount("BCH", amount),
        maxFee: BigInt(maxFee.trim()),
        initiator,
        treasury: treasury.trim(),
      };
      if (!/^\d+$/.test(maxFee.trim())) throw new Error("Maximum miner fee must be a whole number of satoshis.");
      const pendingKey = "ajochain:classic-genesis-setup:v1:chipnet:" + initiator.toLowerCase();
      let pendingSetup: { status: string; txid?: string; createdAt?: number } | null = null;
      try {
        const rawPending = window.localStorage.getItem(pendingKey);
        if (rawPending) {
          const parsed = JSON.parse(rawPending) as { status?: unknown; txid?: unknown; createdAt?: unknown };
          if (parsed.status === "broadcast" && typeof parsed.txid === "string" && /^[0-9a-f]{64}$/i.test(parsed.txid)) {
            pendingSetup = { status: "broadcast", txid: parsed.txid, createdAt: Number(parsed.createdAt) || undefined };
          } else if (parsed.status === "unknown" || parsed.status === "signing") {
            pendingSetup = { status: parsed.status };
          } else {
            throw new Error("A previous CashTokens setup attempt is still recorded for this wallet. Check Selene and the Chipnet transaction history before trying again; AjoChain will not create a duplicate setup transaction.");
          }
        }
      } catch (cause) {
        if (cause instanceof Error && cause.message.startsWith("A previous CashTokens")) throw cause;
        throw new Error("AjoChain could not safely read its pending setup record. No new transaction was prepared.");
      }

      if (pendingSetup?.status === "unknown" || pendingSetup?.status === "signing") {
        throw new Error(
          pendingSetup.status === "unknown"
            ? "AjoChain could not confirm whether the previous setup transaction reached Chipnet. Check Selene and the Chipnet wallet history before retrying; duplicate setup transactions are blocked."
            : "A previous CashTokens setup attempt was interrupted before its broadcast result was saved. Check Selene and the Chipnet wallet history before retrying; AjoChain will not create a duplicate setup transaction.",
        );
      }

      let plan: Awaited<ReturnType<typeof planV2FeeGenesis>>;
      try {
        plan = await planV2FeeGenesis(draft, initiator);
      } catch (cause) {
        if (!(cause instanceof CashTokensGenesisUtxoMissingError)) throw cause;

        if (pendingSetup?.txid) {
          const provider = await getClassicProvider("chipnet");
          const currentUtxos = await provider.getUtxos(initiator);
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
          plan = await planV2FeeGenesis(draft, initiator);
        } else {
          const setup = await planClassicGenesisSetup(initiator);
          if (!window.confirm(
            "Step 1 of 2 · Prepare the CashTokens genesis coin on Chipnet?\n\n" +
            "AjoChain will send " + setup.outputSatoshis.toString() + " sats to your wallet as output 0. " +
            "The remaining BCH returns to your wallet as change, minus an estimated " + setup.fee.toString() +
            "-sat miner fee, with " + setup.changeSatoshis.toString() + " sats returned as wallet change.\n\n" +
            "This does not create the circle NFT yet. After output 0 appears in your wallet, a second " +
            "Selene approval will create the circle. No new deposit is requested.",
          )) return;

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
              "Prepare CashTokens genesis output for AjoChain",
            );
          } catch (cause) {
            try { window.localStorage.removeItem(pendingKey); } catch { /* best effort */ }
            throw cause;
          }

          let setupTxid: string;
          try {
            setupTxid = await setup.provider.sendRawTransaction(signedSetup.signedTransaction);
          } catch (cause) {
            try {
              window.localStorage.setItem(pendingKey, JSON.stringify({
                status: "unknown",
                createdAt: Date.now(),
              }));
            } catch { /* keep the earlier signing reservation if possible */ }
            throw new Error(
              "The setup transaction was signed, but Chipnet did not confirm its submission. " +
              "AjoChain has blocked automatic retries to avoid a duplicate. Check your wallet history first. " +
              errorText(cause),
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

          const refreshedUtxos = await setup.provider.getUtxos(initiator);
          const setupOutputVisible = refreshedUtxos.some((utxo) =>
            utxo.txid.toLowerCase() === setupTxid.toLowerCase() &&
            utxo.vout === 0 && !utxo.token && utxo.satoshis > 0n
          );
          if (!setupOutputVisible) {
            setNotice(
              "Setup transaction broadcast: " + setupTxid +
              ". The new vout-0 coin is not visible yet, so the circle has not been created. " +
              "Refresh and submit this same form again when the wallet reports the output. AjoChain will not create a duplicate setup transaction.",
            );
            return;
          }
          plan = await planV2FeeGenesis(draft, initiator);
        }
      }

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
        "No one must pre-fund the entire cycle. Each recipient carries one next contribution forward from their payout to cover the following round.\\n\\n" +
        "Public on-chain discovery notice: this transaction permanently links every member BCH address to this circle in public Chipnet history. Each member receives a 546-sat marker; circle settings are public, but the circle name is not. Only proceed if every listed address owner agrees to this public association.\\n" +
        "Experimental Chipnet software only; no real funds.",
      )) return;
      const signed = await wallet.signAndVerify(plan.wc, plan.walletInputs, "Create AjoChain V2 fee circle: " + draft.name);
      const provider = await getClassicProvider("chipnet");
      const txid = await provider.sendRawTransaction(signed.signedTransaction);
      persist(plan.params);
      try { window.localStorage.removeItem(pendingKey); } catch { /* best effort */ }
      setNotice("V2 fee circle submitted to Chipnet and saved on this device. Share the invite link with members. Transaction: " + txid);
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
      setNotice("Sending your member contribution approval request to Selene…");
      const signed = await wallet.signAndVerify(plan.wc, plan.walletInputs, "Pay my AjoChain member share");
      const provider = await getClassicProvider("chipnet");
      const txid = await provider.sendRawTransaction(signed.signedTransaction);
      window.dispatchEvent(new Event("ajochain:wallet-balances-changed"));
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
      window.dispatchEvent(new Event("ajochain:wallet-balances-changed"));
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
      setNotice("Sending the circle cancellation approval request to Selene…");
      const signed = await wallet.signAndVerify(plan.wc, plan.walletInputs, "Cancel AjoChain circle and refund every member");
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
          <span className="section-kicker">MEMBER CONTRIBUTIONS · CIRCLE RULES</span>
          <h2 id="v2-fee-title">{view === "create" ? "Fair-round BCH circle" : active?.name ?? "Your circle"}</h2>
          <p>{view === "create" ? "Members contribute each round. When someone collects (except on the final turn), one next contribution is held for their following round." : "See each member’s contributions, what is still due, who collects next and which actions are available."}</p>
        </div>
        <span className="classic-network">Chipnet · test coins</span>
      </div>
      <p className="circle-education-copy">For each non-final payout, one next contribution is held for the recipient's following round. Members make later contributions as usual.</p>

      {view === "create" && (<>
      <div className="circle-workspace-grid">
        <div className="circle-panel circle-create-panel">
          <div className="circle-panel-heading">
            <span className="section-kicker">NEW GROUP</span>
            <h3>Create a circle</h3>
            <p>Set the contribution and register your group members. Your connected Selene wallet is added first automatically.</p>
          </div>
          <form onSubmit={create}>
            <label>Circle name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required /></label>
            <label>Contribution per member (BCH)<input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" required /></label>
            <label>Maximum miner fee (satoshis)<input value={maxFee} onChange={(event) => setMaxFee(event.target.value)} inputMode="numeric" required /></label>
            <label>Fixed Chipnet treasury address<input value={treasury} onChange={(event) => setTreasury(event.target.value)} required /></label>
            <div className="creator-member-preview">
              <b>Member 1 · You, the creator</b>
              {walletConnected && wallet.state === "connected" && wallet.address("chipnet")
                ? <code>{wallet.address("chipnet")}</code>
                : "Connect your Selene wallet and it will be registered automatically."}
            </div>
            <label>Other members' Chipnet BCH addresses · one per line<textarea value={membersText} onChange={(event) => setMembersText(event.target.value)} rows={4} placeholder="bchtest:…\nbchtest:…" required /></label>
            <p className="field-hint">The circle setup permanently links each member BCH address to this circle on the public Chipnet blockchain. Each member receives a small marker; the settings are public, but the circle name is not. Only add addresses whose owners agree to this public association.</p>
            <button className="primary-button" type="submit" disabled={busy || network !== "chipnet" || !walletConnected}>
              {busy ? "Creating circle…" : network !== "chipnet" ? "Switch to Chipnet" : !walletConnected ? "Connect wallet first" : "Create fee circle"}
            </button>
          </form>
          <small className="field-hint">Add 1–4 other unique Chipnet addresses in payout order (2–5 members total). Each member funds the current round; a non-final recipient carries one next contribution forward.</small>
        </div>
      </div>
      <form className="classic-restore-form circle-restore-form" onSubmit={restore}>
        <label>Join an existing circle with its invite link<input value={restoreInput} onChange={(event) => setRestoreInput(event.target.value)} placeholder="Paste circle invite URL" /></label>
        <button type="submit" className="secondary-button" disabled={!restoreInput.trim()}>Restore circle</button>
      </form>
      <p className="field-hint circle-menu-hint">After you create or restore a circle, it appears on the <b>My circles</b> page for the selected network.</p>
      </>)}

      {view === "circle" && active && <div className="classic-active-circle">
        <div className="section-heading">
          <div><span className="section-kicker">SELECTED CIRCLE · CHIPNET</span><h3>{active.name}</h3></div>
          <button type="button" className="secondary-button" onClick={() => void copyInvite()}><Copy size={14} /> Copy invite</button>
        </div>
        <p className="classic-contract-address">Circle ID: <code>{active.stateCategory}</code></p>
        <p className="classic-contract-address">Fee address: <code>{active.treasury}</code> · 1% of each gross payout</p>
        {snapshot ? <>
          <div className="classic-account-summary classic-chain-stats">
            <div><b>{snapshot.completed ? "Complete" : (snapshot.round + 1) + " / " + active.members.length}</b><span>{snapshot.completed ? "All scheduled payouts" : "Next payout round"}</span></div>
            <div><b>{formatBch(snapshot.stateSatoshis)}</b><span>Funds held for the circle</span></div>
            <div><b>{snapshot.completed ? "Complete" : snapshot.ready ? "Payout unlocked" : "Contribution shortfall"}</b><span>Contributions received and the amount set aside for the next member</span></div>
          </div>
          <div className="fee-accounting-heading">
            <div><b>Member accountability ledger</b><span>What each member has paid, what is still due, and who has collected</span></div>
            <span className={snapshot.ready || snapshot.completed ? "fee-accounting-status safe" : "fee-accounting-status blocked"}>{snapshot.completed ? "Circle closed" : snapshot.ready ? "Payout unlocked" : "Payout locked"}</span>
          </div>
          {(active.covenant === "fee-v1" || active.covenant === "fee-v1-guarded") && <p className="classic-error">Older circle rules: the circle checks one contribution at a time. If a member stops contributing after collecting, later rounds may be blocked. New circles hold aside the next contribution before a payout.</p>}
          {(active.covenant === "fee-v2-escrow" || active.covenant === "fee-v2-escrow-guarded") && <p className="field-hint">This older circle uses its original full-cycle payment rule. New circles hold aside one next contribution before a payout. Existing circles are not changed automatically.</p>}
          <div className="fee-accounting-table">
            <div className="fee-accounting-row fee-accounting-header"><span>Member</span><span>Paid directly</span><span>Locked now / required</span><span>Payout received</span><span>Still due</span><span>Status</span></div>
            {snapshot.memberAccounting.map((account) => (
              <div className="fee-accounting-row" key={account.address}>
                <span data-label="Member"><b>Member {account.index + 1}{memberIndex === account.index ? " · You" : ""}</b><small>{account.address}</small></span>
                <span data-label="Paid directly">{account.totalPaidIn === null ? "Legacy history" : formatBch(account.totalPaidIn)}</span>
                <span data-label="Locked / required">{formatBch(account.currentCredit)}<small>of {formatBch(account.requiredForNextPayout)}</small></span>
                <span data-label="Payout received">{account.payoutReceived === null ? "Not tracked" : account.payoutReceived ? formatBch(account.payoutAmountReceived) : "Not yet"}</span>
                <span data-label="Still due">{formatBch(account.shortfallForNextPayout)}</span>
                <span data-label="Status"><b className={account.fullySecured ? "fee-accounting-member-safe" : "fee-accounting-member-blocked"}>{account.status}</b></span>
              </div>
            ))}
          </div>
          {snapshot.closedAs === "cancelled"
            ? <p className="classic-recipient"><b>Circle cancelled.</b> Every member's recorded credit and receipt backing was refunded. Nothing remains locked in the contract.</p>
            : snapshot.completed
            ? <p className="classic-recipient"><b>Circle completed.</b> Every registered member received their scheduled payout. No further deposits or payouts are accepted.{snapshot.closedAs === "completed" ? " The circle tokens were closed and their BCH backing returned to the initiator, so nothing remains locked." : ""}</p>
            : <p className="classic-recipient">Next payout recipient: <b>Member {snapshot.round + 1}</b> · {snapshot.recipient}</p>}
          <p className="field-hint">{snapshot.closedAs ? "This circle is closed. No further actions are possible." : snapshot.hasPaid ? "The first payout has happened. Cancellation is permanently locked; remaining escrow cannot be withdrawn." : "No payout has happened yet. Only the initiator may cancel and refund recorded member credit."}</p>
        </> : <p className="classic-empty">Reading the state NFT and all member receipts from Chipnet. Refresh if the transaction is still confirming.</p>}
        <div className="member-payment-status">
          {memberIndex >= 0
            ? <p><b>Your wallet is registered as Member {memberIndex + 1}.</b> You can pay your own share below.</p>
            : walletConnected
              ? <><p><b>This wallet is not registered in this circle.</b> Connect the Selene account that owns one of the member addresses, or create a new circle with the correct member list.</p><code>{wallet.address("chipnet") ?? "Address unavailable"}</code></>
              : <p>Connect Selene with the BCH address registered for your member slot to pay your share.</p>}
        </div>
        <label className="classic-deposit-field">Your BCH contribution deposit<input value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} inputMode="decimal" /></label>
        {memberIndex >= 0 && snapshot?.memberAccounting[memberIndex] && <p className="field-hint">Your receipt holds {formatBch(snapshot.memberAccounting[memberIndex].currentCredit)}. Amount needed for your next contribution reserve or current round: <b>{formatBch(snapshot.memberAccounting[memberIndex].shortfallForNextPayout)}</b>. <button type="button" className="fee-exact-amount-button" onClick={() => setDepositAmount(bchInputAmount(snapshot.memberAccounting[memberIndex].shortfallForNextPayout))}>Use exact amount due</button></p>}
        <div className="classic-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</button>
          <button type="button" className="secondary-button" disabled={busy || memberIndex < 0 || network !== "chipnet" || Boolean(snapshot?.completed)} onClick={() => void deposit()}>
            {memberIndex < 0 ? "Connect a registered member wallet" : "Pay my share"}
          </button>
          <button type="button" className="primary-button" disabled={busy || !snapshot?.ready || snapshot?.completed || network !== "chipnet"} onClick={() => void payout()}>Pay out next round</button>
          <button type="button" className="secondary-button" disabled={busy || !initiator || Boolean(snapshot?.hasPaid) || Boolean(snapshot?.completed)} onClick={() => void cancel()}>Cancel before first payout</button>
        </div>
      </div>}
      {busy && <p className="classic-feedback" role="status">Preparing or verifying a Chipnet transaction…</p>}
      {notice && <p className="classic-feedback" role="status">{notice}</p>}
      {error && <p className="classic-error" role="alert">{error}
        <button type="button" className="inline-dismiss" aria-label="Close error" onClick={() => setError("")}>×</button>
      </p>}
    </section>
  );
}
