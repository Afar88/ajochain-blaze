import { useMemo, useState, type FormEvent } from "react";
import { ArrowRight, LockKeyhole, ShieldCheck } from "lucide-react";
import { formatAssetAmount, parseAssetAmount } from "../core/assets";
import { MAINNET_PROJECT_TREASURY_ADDRESS } from "../core/project-treasury";
import {
  prepareBchMainnetCircleGenesisPreview,
} from "../core/bch-mainnet-circle";
import { wallet } from "../core/wizard-wallet";
import type { NetworkId } from "../core/network-config";

type Props = { network: NetworkId; walletConnected: boolean };

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

export default function BchMainnetCircleWorkspace({ network, walletConnected }: Props) {
  const [name, setName] = useState("My BCH Ajo Circle");
  const [contribution, setContribution] = useState("0.002");
  const [membersText, setMembersText] = useState("");
  const [maxFee, setMaxFee] = useState("10000");
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

  const prepare = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setNotice("");
    setPreview(null);

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

        <button className="primary-button" type="submit" disabled={busy || network !== "mainnet" || !walletConnected}>
          {busy ? "Preparing Mainnet preview…" : "Prepare on-chain creation preview"} <ArrowRight size={15} />
        </button>
      </form>

      {preview && (
        <div className="pusd-mainnet-breakdown" role="status">
          <b>Unsigned BCH Mainnet genesis preview</b>
          <div><span>Circle contract address</span><strong><code>{preview.contractAddress}</code></strong></div>
          <div><span>State CashToken category</span><strong><code>{preview.stateCategory}</code></strong></div>
          <div><span>Conservative miner-fee estimate</span><strong>{preview.feeEstimate} sats</strong></div>
          <div><span>Estimated wallet change</span><strong>{preview.estimatedChange} sats</strong></div>
          <div><span>Transaction shape</span><strong>{preview.inputCount} inputs · {preview.outputCount} outputs</strong></div>
          <small>No contract has been deployed and no transaction has been signed or broadcast.</small>
        </div>
      )}
      {error && <p className="classic-error" role="alert">{error}</p>}
      {notice && <p className="classic-notice" role="status">{notice}</p>}

      <div className="pusd-mainnet-build-status">
        <LockKeyhole size={16} />
        <span><b>Mainnet transaction execution remains disabled</b><small>The BCH V3 covenant can be prepared for review. Wallet signing, fresh-prevout verification, safe broadcasting and reorg reconciliation are not enabled for real funds.</small></span>
      </div>
    </section>
  );
}
