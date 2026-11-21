import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { decodeClassicCircle, getClassicProvider, readClassicCircle } from "../core/classic-bch";
import { loadSavedClassicCircles } from "../core/circle-account";
import { readCircleTransactionHistory, type CircleActivitySnapshot, type CircleTransactionRecord } from "../core/chain-activity";
import { decodeV2FeeCircle, readV2FeeCircle, validateV2FeeCircleDraft, type V2FeeCircleParams } from "../core/v2-fee-bch";
import {
  PusdCircleNoStateError, createPusdMainnetCircleContracts, readPusdMainnetCircle,
  validatePusdMainnetCircleParams, type PusdMainnetCircleParams,
} from "../core/pusd-mainnet-circle";
import { formatAssetAmount } from "../core/assets";
import { formatBch } from "../core/network";

const V2_STORAGE_KEY = "ajochain-blaze:v2-fee-circles:v1";
const BCH_MAINNET_CIRCLES_KEY = "ajochain-blaze:bch-mainnet-circles-deployed:v1";
const PUSD_MAINNET_CIRCLES_KEY = "ajochain-blaze:pusd-mainnet-circles-deployed:v1";
const BCH_MAINNET_ACTIVE_KEY = "ajochain-blaze:bch-mainnet-circle-active:v1";
const PUSD_ACTIVE_KEY = "ajochain-blaze:pusd-mainnet-circle-active:v1";

type CircleRef =
  | { id: string; kind: "classic"; name: string; network: "chipnet" | "mainnet"; params: ReturnType<typeof decodeClassicCircle> }
  | { id: string; kind: "fee"; name: string; network: "chipnet" | "mainnet"; params: V2FeeCircleParams }
  | { id: string; kind: "pusd"; name: string; network: "mainnet"; params: PusdMainnetCircleParams };

type MemberRecord = {
  address: string;
  credit: bigint;
  due: bigint;
  status: string;
  totalPaidIn?: bigint | null;
  payoutReceived?: boolean | null;
  payoutAmountReceived?: bigint;
};

type CircleResult = {
  ref: CircleRef;
  status: "loading" | "ready" | "unavailable";
  stateLabel?: string;
  roundLabel?: string;
  recipient?: string | null;
  details?: string;
  memberRecords?: MemberRecord[];
  aggregatePool?: { available: bigint; required: bigint; shortfall: bigint };
  history?: CircleActivitySnapshot;
  historyError?: string;
  error?: string;
};

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : "The chain record could not be read.";
}

function readStoredV2Circles(): CircleRef[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(V2_STORAGE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      if (!item || typeof item !== "object" || typeof item.encoded !== "string") return [];
      try {
        const params = decodeV2FeeCircle(item.encoded);
        return [{
          id: "fee:" + params.network + ":" + params.stateCategory,
          kind: "fee" as const,
          name: params.name,
          network: params.network,
          params,
        }];
      } catch { return []; }
    });
  } catch { return []; }
}

function readSavedBchMainnetCircles(): CircleRef[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(BCH_MAINNET_CIRCLES_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((encoded) => {
      if (typeof encoded !== "string") return [];
      try {
        const params = decodeV2FeeCircle(encoded);
        if (params.network !== "mainnet") return [];
        return [{
          id: "fee:mainnet:" + params.stateCategory,
          kind: "fee" as const,
          name: params.name,
          network: "mainnet" as const,
          params,
        }];
      } catch { return []; }
    });
  } catch { return []; }
}

function readSavedPusdCircles(): CircleRef[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(PUSD_MAINNET_CIRCLES_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((encoded) => {
      if (typeof encoded !== "string") return [];
      try {
        const value: unknown = JSON.parse(encoded);
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const item = value as Record<string, unknown>;
        if (item.version !== 3 || item.network !== "mainnet" ||
            typeof item.name !== "string" || typeof item.stateCategory !== "string" ||
            typeof item.contribution !== "string" || !/^[0-9]+$/.test(item.contribution) ||
            typeof item.maxFee !== "string" || !/^[0-9]+$/.test(item.maxFee) ||
            typeof item.initiator !== "string" || typeof item.treasury !== "string" ||
            !Array.isArray(item.members) || !item.members.every((member) => typeof member === "string")) return [];
        const params: PusdMainnetCircleParams = {
          version: 3,
          network: "mainnet",
          name: item.name,
          members: item.members as string[],
          contribution: BigInt(item.contribution),
          maxFee: BigInt(item.maxFee),
          initiator: item.initiator,
          stateCategory: item.stateCategory,
          treasury: item.treasury,
        };
        validatePusdMainnetCircleParams(params);
        return [{
          id: "pusd:mainnet:" + params.stateCategory.toLowerCase(),
          kind: "pusd" as const,
          name: params.name,
          network: "mainnet" as const,
          params,
        }];
      } catch { return []; }
    });
  } catch { return []; }
}

function readActiveBchMainnet(): CircleRef[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(BCH_MAINNET_ACTIVE_KEY) || "null");
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.contribution !== "string" || !/^[0-9]+$/.test(item.contribution) ||
        typeof item.maxFee !== "string" || !/^[0-9]+$/.test(item.maxFee)) return [];
    const params = {
      ...item,
      contribution: BigInt(item.contribution),
      maxFee: BigInt(item.maxFee),
    } as unknown as V2FeeCircleParams;
    validateV2FeeCircleDraft(params);
    if (params.network !== "mainnet") return [];
    return [{
      id: "fee:mainnet:" + params.stateCategory,
      kind: "fee",
      name: params.name,
      network: "mainnet",
      params,
    }];
  } catch { return []; }
}

function readActivePusd(): CircleRef[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(PUSD_ACTIVE_KEY) || "null");
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.contribution !== "string" || !/^[0-9]+$/.test(item.contribution) ||
        typeof item.maxFee !== "string" || !/^[0-9]+$/.test(item.maxFee)) return [];
    const params = {
      ...item,
      contribution: BigInt(item.contribution),
      maxFee: BigInt(item.maxFee),
    } as unknown as PusdMainnetCircleParams;
    validatePusdMainnetCircleParams(params);
    return [{
      id: "pusd:mainnet:" + params.stateCategory,
      kind: "pusd",
      name: params.name,
      network: "mainnet",
      params,
    }];
  } catch { return []; }
}

function loadCircleRefs(): CircleRef[] {
  const refs: CircleRef[] = [];
  for (const saved of loadSavedClassicCircles(window.localStorage)) {
    try {
      const params = decodeClassicCircle(saved.encoded);
      refs.push({
        id: "classic:" + params.network + ":" + params.stateCategory,
        kind: "classic",
        name: params.name,
        network: params.network,
        params,
      });
    } catch { /* Invalid local bookmarks are ignored; chain state is never inferred. */ }
  }
  refs.push(
    ...readStoredV2Circles(),
    ...readSavedBchMainnetCircles(),
    ...readSavedPusdCircles(),
    ...readActiveBchMainnet(),
    ...readActivePusd(),
  );
  const unique = new Map(refs.map((ref) => [ref.id, ref]));
  return [...unique.values()].slice(0, 30);
}


async function readHistorySafely(
  provider: Parameters<typeof readCircleTransactionHistory>[0],
  network: Parameters<typeof readCircleTransactionHistory>[1],
  lockingBytecodes: Parameters<typeof readCircleTransactionHistory>[2],
): Promise<{ history?: CircleActivitySnapshot; historyError?: string }> {
  try {
    return { history: await readCircleTransactionHistory(provider, network, lockingBytecodes, 20) };
  } catch (cause) {
    return { historyError: errorText(cause) };
  }
}

async function readOneCircle(ref: CircleRef): Promise<CircleResult> {
  try {
    if (ref.kind === "classic") {
      const snapshot = await readClassicCircle(ref.params);
      const historyResult = await readHistorySafely(
        snapshot.provider, ref.network, [snapshot.contract.lockingBytecode],
      );
      const status = snapshot.status;
      const stateVerified = status.stateVerified || status.completed;
      return {
        ref, status: stateVerified ? "ready" : "unavailable",
        stateLabel: status.completed ? "Rotation complete" : stateVerified ? "Active" : "Needs checking",
        roundLabel: status.round === null ? "Round unavailable" : status.completed
          ? status.round + " / " + ref.params.members.length
          : (status.round + 1) + " / " + ref.params.members.length,
        recipient: status.recipient,
        details: "This circle uses one shared pot.",
        aggregatePool: {
          available: status.available,
          required: status.required,
          shortfall: status.shortfall,
        },
        ...historyResult,
        ...(!stateVerified ? { error: status.issues.join(" ") || "Classic circle state could not be validated." } : {}),
      };
    }
    if (ref.kind === "fee") {
      const snapshot = await readV2FeeCircle(ref.params);
      const historyResult = await readHistorySafely(
        snapshot.provider, ref.network, [snapshot.contract.lockingBytecode],
      );
      return {
        ref, status: "ready",
        stateLabel: snapshot.completed ? "Rotation complete" : snapshot.ready ? "Payout ready" : "Awaiting member credits",
        roundLabel: snapshot.completed ? snapshot.round + " / " + ref.params.members.length
          : (snapshot.round + 1) + " / " + ref.params.members.length,
        recipient: snapshot.recipient,
        details: "Member balances come from the blockchain.",
        memberRecords: snapshot.memberAccounting.map((member) => ({
          address: member.address,
          credit: member.currentCredit,
          due: member.shortfallForNextPayout,
          status: member.status,
          totalPaidIn: member.totalPaidIn,
          payoutReceived: member.payoutReceived,
          payoutAmountReceived: member.payoutAmountReceived,
        })),
        ...historyResult,
      };
    }
    let snapshot;
    try {
      snapshot = await readPusdMainnetCircle(ref.params);
    } catch (cause) {
      if (!(cause instanceof PusdCircleNoStateError)) throw cause;
      // A closed circle has no live UTXOs, but its script history is still readable.
      const provider = await getClassicProvider("mainnet");
      const { contract, escrows } = createPusdMainnetCircleContracts(ref.params, provider);
      const historyResult = await readHistorySafely(
        provider,
        "mainnet",
        [contract.lockingBytecode, ...escrows.map((escrow) => escrow.lockingBytecode)],
      );
      if (!historyResult.history?.records.length) throw cause;
      return {
        ref, status: "ready",
        stateLabel: "Closed",
        roundLabel: "Closed",
        recipient: null,
        details: "This circle is closed.",
        ...historyResult,
      };
    }
    const historyResult = await readHistorySafely(
      snapshot.provider,
      "mainnet",
      [snapshot.contract.lockingBytecode, ...snapshot.escrows.map((escrow) => escrow.lockingBytecode)],
    );
    return {
      ref, status: "ready",
      stateLabel: snapshot.completed ? "Rotation complete" : snapshot.ready ? "Payout ready" : "Awaiting member credits",
      roundLabel: snapshot.completed ? snapshot.round + " / " + ref.params.members.length
        : (snapshot.round + 1) + " / " + ref.params.members.length,
      recipient: snapshot.recipient,
      details: "PUSD member balances come from the blockchain.",
      memberRecords: snapshot.credits.map((credit, index) => ({
        address: ref.params.members[index],
        credit,
        due: credit >= ref.params.contribution ? 0n : ref.params.contribution - credit,
        status: credit >= ref.params.contribution ? "Contribution funded" : "Contribution due",
      })),
      ...historyResult,
    };
  } catch (cause) {
    return {
      ref,
      status: "unavailable",
      error: errorText(cause),
    };
  }
}

function shortTxid(txid: string) {
  return txid.slice(0, 12) + "…" + txid.slice(-10);
}

function txStatusLabel(record: CircleTransactionRecord) {
  if (record.status === "confirmed") {
    return "Confirmed · " + (record.confirmations ?? 0).toLocaleString() + " confirmations";
  }
  if (record.status === "pending") return "Pending · not confirmed";
  return "Needs checking";
}

export default function ActivityRecords({ network, compact = false }: { network: "chipnet" | "mainnet"; compact?: boolean }) {
  const [circles, setCircles] = useState<CircleRef[]>(() => loadCircleRefs().filter((ref) => ref.network === network));
  const [results, setResults] = useState<CircleResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true);
    setRefreshError("");
    const current = loadCircleRefs().filter((ref) => ref.network === network);
    setCircles(current);
    setResults(current.map((ref) => ({ ref, status: "loading" })));
    try {
      const latest = await Promise.all(current.map(readOneCircle));
      setResults(latest);
      setLastRefreshed(Date.now());
    } catch (cause) {
      setRefreshError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }, [network]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const refreshSavedRecords = () => { void refresh(); };
    window.addEventListener("ajochain:bch-mainnet-circles-changed", refreshSavedRecords);
    window.addEventListener("ajochain:saved-circles-changed", refreshSavedRecords);
    return () => {
      window.removeEventListener("ajochain:bch-mainnet-circles-changed", refreshSavedRecords);
      window.removeEventListener("ajochain:saved-circles-changed", refreshSavedRecords);
    };
  }, [refresh]);

  const transactionCount = results.reduce((sum, item) =>
    sum + (item.history?.records.length ?? 0), 0,
  );
  const confirmedCount = results.reduce((sum, item) =>
    sum + (item.history?.records.filter((record) => record.status === "confirmed").length ?? 0), 0,
  );

  return (
    <section className="page-section activity-records-page">
      {!compact && <div className="page-intro">
        <span className="section-kicker">YOUR ACTIVITY</span>
        <h1>Activity</h1>
        <p>See your circle activity and payments.</p>
      </div>}

      <div className="activity-summary-grid">
        <article className="overview-status-card">
          <div className="status-card-icon"><ShieldCheck size={18} /></div>
          <div><span className="status-label">SAVED CIRCLES</span><b>{results.filter((item) => item.status === "ready").length}</b><small>Found and saved on this network</small></div>
        </article>
        <article className="overview-status-card">
          <div className="status-card-icon"><RefreshCw size={18} /></div>
          <div><span className="status-label">TRANSACTION RECORDS</span><b>{transactionCount}</b><small>{confirmedCount} confirmed payments</small></div>
        </article>
      </div>

      <div className="activity-toolbar">
        <div>
          <b>Circle activity</b>
          <small>{lastRefreshed ? "Updated " + new Date(lastRefreshed).toLocaleString() : "Checking circle details…"}</small>
        </div>
        <button type="button" className="secondary-button" onClick={() => void refresh()} disabled={busy}>
          <RefreshCw size={15} className={busy ? "activity-spin" : ""} /> {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {refreshError && <p className="classic-error" role="alert">{refreshError}
        <button type="button" className="inline-dismiss" aria-label="Close error" onClick={() => setRefreshError("")}>×</button>
      </p>}
      {circles.length === 0 ? (
        <article className="asset-detail-card activity-empty">
          <h2>No circles saved yet</h2>
          <p>Create a circle or add an invite.</p>
        </article>
      ) : (
        <div className="activity-circle-list">
          {results.map((result) => (
            <article className="asset-detail-card activity-circle-card" key={result.ref.id}>
              <div className="activity-circle-heading">
                <div>
                  <span className="section-kicker">{result.ref.kind === "pusd" ? "PUSD" : "BCH"} · {result.ref.network.toUpperCase()}</span>
                  <h2>{result.ref.name}</h2>
                  <small>{result.ref.kind === "classic" ? "Classic BCH circle" : result.ref.kind === "fee" ? "Member-receipt BCH circle" : "PUSD member-escrow circle"}</small>
                </div>
                <span className={"activity-state-pill " + result.status}>
                  {result.status === "loading" ? "Checking…" : result.status === "ready" ? "Available" : "Unavailable"}
                </span>
              </div>
              {result.status === "loading" ? (
                <p className="classic-empty">Reading contract state and transaction history from {result.ref.network}…</p>
              ) : result.status === "unavailable" ? (
                <div className="activity-unavailable">
                  <b>Couldn't confirm this circle yet</b>
                  <details className="technical-details"><summary>Details</summary><details className="technical-details"><summary>Details</summary><p>{result.error}</p></details></details>
                  <small>This saved circle hasn't been confirmed yet.</small>
                </div>
              ) : (
                <>
                  <div className="activity-state-grid">
                    <div><span>Circle status</span><b>{result.stateLabel}</b></div>
                    <div><span>Current round</span><b>{result.roundLabel}</b></div>
                    <div><span>Next to collect</span><b>{result.recipient ?? "None"}</b></div>
                    <div><span>Network</span><b>{result.ref.network === "mainnet" ? "Mainnet" : "Chipnet"}</b></div>
                  </div>
                  {result.details && <details className="technical-details activity-source-note"><summary>Details</summary><p>{result.details}</p></details>}
                  {result.aggregatePool && (
                    <div className="activity-state-grid">
                      <div><span>On-chain aggregate pot</span><b>{formatBch(result.aggregatePool.available)}</b></div>
                      <div><span>Required for payout</span><b>{formatBch(result.aggregatePool.required)}</b></div>
                      <div><span>Pot shortfall</span><b>{formatBch(result.aggregatePool.shortfall)}</b></div>
                    </div>
                  )}
                  {result.memberRecords && (
                    <div className="activity-member-records">
                      <div className="activity-subheading"><b>Member balances</b><small>Current balances from the blockchain</small></div>
                      {result.memberRecords.map((member, index) => (
                        <div className="activity-member-row" key={member.address}>
                          <span><b>Member {index + 1}</b><small>{member.address}</small></span>
                          <span>
                            <b>Current credit: {result.ref.kind === "pusd" ? formatAssetAmount("PUSD", member.credit) + " PUSD" : formatBch(member.credit)}</b>
                            <small>{member.due > 0n ? "Still due: " + (result.ref.kind === "pusd" ? formatAssetAmount("PUSD", member.due) + " PUSD" : formatBch(member.due)) : member.status}</small>
                            {member.totalPaidIn !== undefined && member.totalPaidIn !== null && (
                              <small>Total paid in: {formatBch(member.totalPaidIn)}</small>
                            )}
                            {member.payoutReceived === true && member.payoutAmountReceived !== undefined && (
                              <small>Payout received: {formatBch(member.payoutAmountReceived)}</small>
                            )}
                            {member.payoutReceived === false && <small>Scheduled payout: not received yet</small>}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="activity-history">
                    <div className="activity-subheading">
                      <b>Recent payments</b>
                      <small>{result.historyError ? "Network check failed" : result.history?.truncated ? "Latest 20 payments" : "Payment history"}</small>
                    </div>
                    {result.historyError ? (
                      <div className="activity-unavailable">
                        <b>Couldn't load payment history</b>
                        <details className="technical-details"><summary>Details</summary><p>{result.historyError}</p></details>
                        <small>Circle details are available, but payment history isn't.</small>
                      </div>
                    ) : result.history?.records.length ? (
                      result.history.records.map((record) => (
                        <div className="activity-transaction-row" key={record.txid}>
                          <span className="activity-transaction-icon"><ShieldCheck size={15} /></span>
                          <span className="activity-transaction-main">
                            <b>{result.ref.kind === "pusd" && record.scriptIndexes.some((index) => index > 0)
                              ? "Member " + record.scriptIndexes.filter((index) => index > 0).map((index) => index).join(", ") + " payment"
                              : "Circle payment"}</b>
                            <code>{shortTxid(record.txid)}</code>
                            <small>{record.status === "confirmed" && record.blockTimestamp
                              ? new Date(record.blockTimestamp).toLocaleString() + " · block " + record.height
                              : record.status === "pending" ? "Seen in mempool · awaiting confirmation" : record.reason ?? "Payment couldn't be confirmed"}</small>
                          </span>
                          <span className={"activity-state-pill " + record.status}>{txStatusLabel(record)}</span>
                        </div>
                      ))
                    ) : (
                      <p className="classic-empty">No payments found yet.</p>
                    )}
                  </div>
                  {result.history?.truncated && <small className="activity-truncation">This circle has older transactions than the latest 20 displayed.</small>}
                </>
              )}
            </article>
          ))}
        </div>
      )}
      <p className="activity-footnote">Confirmed payments are final. Pending payments may still change.</p>
    </section>
  );
}
