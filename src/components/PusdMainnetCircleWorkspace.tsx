import { useMemo, useState, type FormEvent } from "react";
import { ArrowRight, LockKeyhole, ShieldCheck } from "lucide-react";
import { PUSD_ASSET, formatAssetAmount, parseAssetAmount } from "../core/assets";
import { classicAddressToPkh } from "../core/classic-bch";
import { calculatePusdCircleEconomics } from "../core/pusd-circle-economics";
import { MAINNET_PROJECT_TREASURY_ADDRESS } from "../core/project-treasury";
import type { NetworkId } from "../core/network-config";

type Props = { network: NetworkId; walletConnected: boolean };
type Draft = {
  name: string;
  contribution: string;
  members: string[];
  maxFeeSatoshis: string;
  savedAt: number;
};

const STORAGE_KEY = "ajochain-blaze:pusd-mainnet-circle-drafts:v1";

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

export default function PusdMainnetCircleWorkspace({ network, walletConnected }: Props) {
  const [name, setName] = useState("My PUSD Ajo Circle");
  const [contribution, setContribution] = useState("10.00");
  const [membersText, setMembersText] = useState("");
  const [maxFee, setMaxFee] = useState("20000");
  const [drafts, setDrafts] = useState<Draft[]>(readDrafts);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const memberAddresses = useMemo(() =>
    membersText.split(/\r?\n/).map((address) => address.trim()).filter(Boolean),
  [membersText]);

  const economics = useMemo(() => {
    try {
      if (memberAddresses.length < 2 || memberAddresses.length > 5) return null;
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
          <span className="section-kicker">PARYONUSD · REAL CASHTOKEN CATEGORY</span>
          <h2 id="pusd-mainnet-title">Create a PUSD Mainnet circle</h2>
          <p>Member-owned PUSD escrow, covenant-controlled payouts, 1% treasury fee and pre-payout cancellation.</p>
        </div>
        <span className="classic-network mainnet">Bitcoin Cash Mainnet</span>
      </div>

      <div className="pusd-mainnet-safety">
        <div><ShieldCheck size={17} /><span><b>Mainnet asset selected</b><small>Canonical ParyonUSD category · no test token or Chipnet substitution</small></span></div>
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
          <small>Exact 2-decimal PUSD amount. Internal calculations use integer CashToken units.</small>
        </label>
        <label>Member Mainnet token-aware addresses · one per line
          <textarea value={membersText} onChange={(event) => setMembersText(event.target.value)} rows={4} placeholder={"bitcoincash:…\nbitcoincash:…"} required />
          <small>Use each member's Bitcoin Cash Mainnet receive address that supports CashTokens.</small>
        </label>
        <label>Maximum BCH miner fee per action (satoshis)
          <input value={maxFee} onChange={(event) => setMaxFee(event.target.value)} inputMode="numeric" required />
          <small>Miner fees and token carrier satoshis are funded separately from PUSD contributions.</small>
        </label>

        <div className="pusd-mainnet-treasury">
          <span>Immutable 1% project-fee destination shared with BCH Mainnet</span>
          <code>{MAINNET_PROJECT_TREASURY_ADDRESS}</code>
        </div>

        {economics && (
          <div className="pusd-mainnet-breakdown">
            <b>First-round covenant preview</b>
            <div><span>Gross PUSD pot</span><strong>{formatAssetAmount("PUSD", economics.grossPot)} PUSD</strong></div>
            <div><span>Project fee · 1%</span><strong>{formatAssetAmount("PUSD", economics.projectFee)} PUSD</strong></div>
            <div><span>Next contribution reserved to first recipient</span><strong>{formatAssetAmount("PUSD", economics.firstPayoutReserve)} PUSD</strong></div>
            <div><span>First recipient receives</span><strong>{formatAssetAmount("PUSD", economics.firstRecipientPayout)} PUSD</strong></div>
            <div><span>Final recipient receives · no reserve</span><strong>{formatAssetAmount("PUSD", economics.finalRecipientPayout)} PUSD</strong></div>
          </div>
        )}

        <button className="primary-button" type="submit" disabled={network !== "mainnet"}>
          Save Mainnet circle draft <ArrowRight size={15} />
        </button>
      </form>

      {error && <p className="classic-error" role="alert">{error}</p>}
      {notice && <p className="classic-notice" role="status">{notice}</p>}

      <div className="pusd-mainnet-build-status">
        <LockKeyhole size={16} />
        <span><b>Next engineering stage: contract transaction planner and signed-byte verifier</b><small>The Mainnet V3 covenant source is being built with immutable treasury, fee, member receipt, reserve and cancellation rules. The current form saves a local draft only; it does not deploy or accept PUSD.</small></span>
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
        <span>CashToken category</span><code>{PUSD_ASSET.categoryId}</code>
        <span>Asset precision</span><b>{PUSD_ASSET.decimals} decimals</b>
      </div>
    </section>
  );
}
