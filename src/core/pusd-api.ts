import { binToHex, decodeCashAddress } from "@bitauth/libauth";
import { PUSD_ASSET } from "./assets";
import { assertPusdMainnetSpendingAllowed } from "./pusd-mainnet-guard";
import { validatePusdProviderSnapshot } from "./pusd-provider-guard";
import { authenticatePusdUtxo } from "./pusd-utxo-auth";
import { verifySignedPusdTransaction } from "./pusd-signed-transaction";
import type { AuthenticatedPusdUtxo, PusdUtxo } from "./pusd-utxo";

type ApiError = { error?: string };

export interface PusdWalletBalance {
  address: string;
  balance: bigint;
  utxos: AuthenticatedPusdUtxo[];
  tipHeight: number;
  tipHash: string;
  observedAtMs: number;
  providerConfidence: number;
  walletUtxoCount: number;
  unconfirmedUtxoCount: number;
  unsupportedTokenUtxos: number;
  rawPreviousTransactions: Record<string, string>;
}

export interface PusdFeeQuote {
  feeRateSatoshisPerKb: bigint;
  source: string;
  serversResponding: number;
  serversConfigured: number;
}

export interface PusdBroadcastResult {
  txid: string;
  relayStatus: "accepted" | "already-known";
  confirmationStatus: "not-checked";
  feeSatoshis: bigint;
  inputPusdAmount: bigint;
  recipientPusdAmount: bigint;
  changePusdAmount: bigint;
  network: "mainnet";
  tipHeight: number;
  broadcast: true;
}

export interface MainnetTransactionStatus {
  network: "mainnet";
  txid: string;
  status: "confirmed" | "pending" | "unknown";
  confirmations: number | null;
  tipHeight: number | null;
  tipHash: string | null;
  providerConfidence: number;
  blockHeight?: number;
  blockHash?: string;
  verification?: string;
  verificationLimit?: string;
  reason?: string;
  retryPolicy: string;
}

interface RawPusdUtxo {
  txid: string;
  vout: number;
  satoshis: string;
  token: { category: string; amount: string; nft?: unknown };
}

interface RawWalletSnapshot {
  providerId: string;
  network: "mainnet";
  address: string;
  category: string;
  tipHeight: number;
  tipHash: string;
  observedAtMs: number;
  paginationComplete: boolean;
  providerConfidence: number;
  pusdUtxos: RawPusdUtxo[];
  rawPreviousTransactions: Record<string, string>;
  walletUtxoCount: number;
  unconfirmedUtxoCount: number;
  unsupportedTokenUtxos: unknown[];
}

/** Convert only standard BCH CashAddress templates supported by this wallet. */
export function cashAddressToExpectedLockingBytecode(address: string): string {
  const decoded = decodeCashAddress(address.trim());
  if (typeof decoded === "string" || decoded.prefix !== "bitcoincash") {
    throw new Error("Expected a valid Bitcoin Cash mainnet address from the connected wallet.");
  }
  const type = String(decoded.type).toLowerCase();
  const payload = binToHex(decoded.payload).toLowerCase();
  if ((type === "p2pkh" || type === "p2pkhwithtokens") && /^[0-9a-f]{40}$/.test(payload)) {
    return "76a914" + payload + "88ac";
  }
  if (type === "p2sh" || type === "p2shwithtokens") {
    if (/^[0-9a-f]{40}$/.test(payload)) return "a914" + payload + "87";
    if (/^[0-9a-f]{64}$/.test(payload)) return "aa20" + payload + "87";
  }
  throw new Error("The connected wallet address uses an unsupported BCH locking script.");
}

function apiBaseUrl(): string {
  const configured = import.meta.env.VITE_PUSD_API_URL;
  const url = (typeof configured === "string" && configured.trim()
    ? configured.trim()
    : window.location.origin).replace(/\/+$/, "");
  if (!/^https:\/\//i.test(url) && !/^http:\/\/localhost(?::\d+)?$/i.test(url)) {
    throw new Error("PUSD API URL must use HTTPS (HTTP is allowed only on localhost).");
  }
  return url;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiBaseUrl() + path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
    credentials: "omit",
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("AjoChain PUSD API returned an unreadable response.");
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as ApiError).error ?? "API request failed.")
      : "PUSD API request failed with HTTP " + response.status + ".";
    throw new Error(message);
  }
  return payload as T;
}


export type PusdMainnetCircleVerificationOperation = "genesis" | "deposit" | "payout" | "cancel";

export interface PusdMainnetCircleVerificationRequest {
  operation: PusdMainnetCircleVerificationOperation;
  circle: {
    version: 3;
    network: "mainnet";
    name: string;
    members: string[];
    contribution: string;
    maxFee: string;
    stateCategory: string;
    initiator: string;
    treasury: string;
  };
  walletAddresses: string[];
  signedTransactionHex: string;
  memberIndex?: number;
  amount?: string;
}

export interface PusdMainnetCircleVerificationResult {
  network: "mainnet";
  operation: PusdMainnetCircleVerificationOperation;
  txid: string;
  contractAddress: string;
  escrowAddresses: string[];
  feeSatoshis: string;
  inputCount: number;
  outputCount: number;
  tipHeight: number;
  tipHash: string;
  confirmedInputs: number;
  verified: true;
  broadcast: false;
  message: string;
}

/**
 * Send Selene-signed PUSD circle bytes to the read-only backend verifier.
 * This endpoint independently authenticates prevouts and contract execution;
 * it has no broadcast or submission path.
 */
export async function verifyPusdMainnetCircleSignedTransaction(
  request: PusdMainnetCircleVerificationRequest,
): Promise<PusdMainnetCircleVerificationResult> {
  if (request.operation === "deposit" &&
      (!Number.isSafeInteger(request.memberIndex) || typeof request.amount !== "string")) {
    throw new Error("PUSD circle deposit verification requires its member index and raw PUSD amount.");
  }
  const result = await requestJson<PusdMainnetCircleVerificationResult>(
    "/api/pusd/circle/verify",
    { method: "POST", body: JSON.stringify(request) },
  );
  if (result.network !== "mainnet" || result.operation !== request.operation ||
      result.broadcast !== false || result.verified !== true ||
      !/^[0-9a-f]{64}$/i.test(result.txid)) {
    throw new Error("PUSD Mainnet server verification returned an inconsistent or unsafe result.");
  }
  return result;
}

function normalizeRawPusdUtxos(raw: RawPusdUtxo[]): PusdUtxo[] {
  if (!Array.isArray(raw)) throw new Error("PUSD provider returned an invalid UTXO list.");
  return raw.map((utxo) => {
    if (!utxo || typeof utxo.txid !== "string" ||
        !Number.isSafeInteger(utxo.vout) || typeof utxo.satoshis !== "string" ||
        !/^\d+$/.test(utxo.satoshis) || !utxo.token ||
        typeof utxo.token.category !== "string" ||
        typeof utxo.token.amount !== "string" || !/^\d+$/.test(utxo.token.amount) ||
        utxo.token.nft !== undefined) {
      throw new Error("PUSD provider returned an incomplete or unsupported token UTXO.");
    }
    return {
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: BigInt(utxo.satoshis),
      token: { category: utxo.token.category, amount: BigInt(utxo.token.amount) },
    };
  });
}

/**
 * Fetch live read-only PUSD balance from the configured AjoChain API.
 * Each result is authenticated from raw previous transaction bytes and has
 * its unspent status rechecked through the API before it can be returned.
 */
export async function fetchPusdWalletBalance(address: string): Promise<PusdWalletBalance> {
  if (!address || !address.startsWith("bitcoincash:")) {
    throw new Error("Connect the Selene wallet on Bitcoin Cash mainnet first.");
  }
  const query = new URLSearchParams({ address });
  const snapshot = await requestJson<RawWalletSnapshot>("/api/pusd/utxos?" + query.toString());
  if (!snapshot || snapshot.network !== "mainnet" || snapshot.address !== address ||
      snapshot.category !== PUSD_ASSET.categoryId) {
    throw new Error("PUSD provider identity, network, address or category did not match the request.");
  }
  if (!Number.isSafeInteger(snapshot.providerConfidence) || snapshot.providerConfidence < 2) {
    throw new Error("PUSD UTXO state was not independently confirmed by two Electrum servers.");
  }
  if (!snapshot.rawPreviousTransactions || typeof snapshot.rawPreviousTransactions !== "object") {
    throw new Error("PUSD provider did not include authenticated previous transaction bytes.");
  }

  const candidates = normalizeRawPusdUtxos(snapshot.pusdUtxos);
  const normalized = validatePusdProviderSnapshot({
    providerId: snapshot.providerId,
    network: snapshot.network,
    address: snapshot.address,
    category: snapshot.category,
    tipHeight: snapshot.tipHeight,
    tipHash: snapshot.tipHash,
    observedAtMs: snapshot.observedAtMs,
    paginationComplete: snapshot.paginationComplete,
    utxos: candidates,
  }, {
    expectedAddress: address,
    nowMs: Date.now(),
    maxAgeMs: 2 * 60 * 1000,
    minTipHeight: 1,
  });

  const expectedScript = cashAddressToExpectedLockingBytecode(address);
  const authenticated: AuthenticatedPusdUtxo[] = [];
  for (const utxo of normalized) {
    const rawPreviousTransactionHex = snapshot.rawPreviousTransactions[utxo.txid];
    if (!rawPreviousTransactionHex) {
      throw new Error("Missing raw previous transaction for PUSD outpoint " + utxo.txid + ":" + utxo.vout + ".");
    }
    const verified = await authenticatePusdUtxo({
      outpoint: { txid: utxo.txid, vout: utxo.vout },
      rawPreviousTransactionHex,
      expectedLockingBytecode: expectedScript,
      unspentEvidence: {
        async isUnspent(outpoint) {
          const result = await requestJson<{
            network: string;
            unspent: Record<string, boolean>;
          }>("/api/pusd/unspent", {
            method: "POST",
            body: JSON.stringify({ walletAddresses: [address], outpoints: [outpoint] }),
          });
          const key = outpoint.txid + ":" + outpoint.vout;
          return result.network === "mainnet" && result.unspent?.[key] === true;
        },
      },
    });
    authenticated.push(verified);
  }

  return {
    address,
    balance: authenticated.reduce((total, utxo) => total + (utxo.token?.amount ?? 0n), 0n),
    utxos: authenticated,
    tipHeight: snapshot.tipHeight,
    tipHash: snapshot.tipHash,
    observedAtMs: snapshot.observedAtMs,
    providerConfidence: snapshot.providerConfidence,
    walletUtxoCount: snapshot.walletUtxoCount,
    unconfirmedUtxoCount: snapshot.unconfirmedUtxoCount,
    unsupportedTokenUtxos: snapshot.unsupportedTokenUtxos?.length ?? 0,
    rawPreviousTransactions: snapshot.rawPreviousTransactions,
  };
}

/**
 * Query the current quorum view of a BCH Mainnet transaction. A later query
 * may downgrade a previously confirmed result after a chain reorganisation.
 */
export async function fetchMainnetTransactionStatus(txid: string): Promise<MainnetTransactionStatus> {
  const normalized = txid.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Transaction ID must be exactly 64 hexadecimal characters.");
  }
  const result = await requestJson<MainnetTransactionStatus>(
    "/api/transaction/status?" + new URLSearchParams({ txid: normalized }).toString(),
  );
  const validBase = Boolean(result) &&
    result.network === "mainnet" &&
    typeof result.txid === "string" &&
    result.txid.toLowerCase() === normalized &&
    ["confirmed", "pending", "unknown"].includes(result.status) &&
    Number.isSafeInteger(result.providerConfidence) &&
    result.providerConfidence >= 0 &&
    typeof result.retryPolicy === "string" &&
    (result.confirmations === null ||
      (Number.isSafeInteger(result.confirmations) && result.confirmations >= 0));

  if (!validBase) {
    throw new Error("Mainnet transaction-status response failed validation.");
  }

  if (result.status === "confirmed") {
    const blockHeight = result.blockHeight;
    const tipHeight = result.tipHeight;
    if (result.providerConfidence < 2 ||
        typeof result.confirmations !== "number" || result.confirmations < 1 ||
        typeof blockHeight !== "number" || !Number.isSafeInteger(blockHeight) || blockHeight < 1 ||
        typeof result.blockHash !== "string" || !/^[0-9a-f]{64}$/i.test(result.blockHash) ||
        typeof tipHeight !== "number" || !Number.isSafeInteger(tipHeight) || tipHeight < blockHeight ||
        typeof result.tipHash !== "string" || !/^[0-9a-f]{64}$/i.test(result.tipHash)) {
      throw new Error("Confirmed Mainnet transaction response failed confirmation-proof validation.");
    }
  } else if (result.status === "pending") {
    if (result.providerConfidence < 2 || result.confirmations !== 0 ||
        typeof result.tipHeight !== "number" || !Number.isSafeInteger(result.tipHeight) ||
        result.tipHeight < 1 ||
        typeof result.tipHash !== "string" || !/^[0-9a-f]{64}$/i.test(result.tipHash)) {
      throw new Error("Pending Mainnet transaction response failed provider-quorum validation.");
    }
  } else if (result.confirmations !== null) {
    throw new Error("Unknown Mainnet transaction response cannot claim a confirmation count.");
  }
  return result;
}

/** Get a fee quote that has been checked against the configured Electrum quorum. */
export async function fetchPusdFeeQuote(): Promise<PusdFeeQuote> {
  const quote = await requestJson<{
    network: string;
    feeRateSatoshisPerKb: string;
    source: string;
    serversResponding: number;
    serversConfigured: number;
  }>("/api/fees");
  if (quote.network !== "mainnet" || !/^\d+$/.test(quote.feeRateSatoshisPerKb) ||
      !Number.isSafeInteger(quote.serversResponding) || quote.serversResponding < 2 ||
      quote.serversResponding > quote.serversConfigured) {
    throw new Error("PUSD fee estimate did not pass the mainnet Electrum quorum checks.");
  }
  const feeRateSatoshisPerKb = BigInt(quote.feeRateSatoshisPerKb);
  if (feeRateSatoshisPerKb <= 0n || feeRateSatoshisPerKb > 1_000_000_000n) {
    throw new Error("PUSD fee quote is outside the permitted range.");
  }
  return {
    feeRateSatoshisPerKb,
    source: quote.source,
    serversResponding: quote.serversResponding,
    serversConfigured: quote.serversConfigured,
  };
}

/**
 * Re-verify a Selene-signed transfer locally, then ask the backend to repeat
 * all checks against fresh chain state before broadcasting. The backend can
 * still reject this request while mainnet broadcast remains disabled.
 */
export async function verifyAndBroadcastPusdTransfer(options: {
  // Defense in depth: callers cannot bypass the Mainnet spend lock by invoking this API directly.
  signedTransactionHex: string;
  walletAddress: string;
  recipientAddress: string;
  changeAddress: string;
  walletLockingBytecodes: readonly string[];
  requiredPusdAmount: bigint;
  maxFeeSatoshis: bigint;
  rawPreviousTransactions: Record<string, string>;
}): Promise<PusdBroadcastResult> {
  assertPusdMainnetSpendingAllowed({ network: "mainnet", asset: "PUSD" });
  const {
    signedTransactionHex,
    walletAddress,
    recipientAddress,
    changeAddress,
    walletLockingBytecodes,
    requiredPusdAmount,
    maxFeeSatoshis,
    rawPreviousTransactions,
  } = options;
  const recipientLockingBytecode = cashAddressToExpectedLockingBytecode(recipientAddress);
  const changeLockingBytecode = cashAddressToExpectedLockingBytecode(changeAddress);
  const verified = await verifySignedPusdTransaction({
    signedTransactionHex,
    rawPreviousTransactions,
    walletLockingBytecodes,
    recipientLockingBytecode,
    changeLockingBytecode,
    requiredPusdAmount,
    maxFeeSatoshis,
    unspentEvidence: {
      async isUnspent(outpoint) {
        const result = await requestJson<{
          network: string;
          unspent: Record<string, boolean>;
        }>("/api/pusd/unspent", {
          method: "POST",
          body: JSON.stringify({ walletAddresses: [walletAddress], outpoints: [outpoint] }),
        });
        return result.network === "mainnet" &&
          result.unspent?.[outpoint.txid + ":" + outpoint.vout] === true;
      },
    },
  });

  const broadcast = await requestJson<{
    txid: string;
    relayStatus: "accepted" | "already-known";
    confirmationStatus: "not-checked";
    feeSatoshis: string;
    inputPusdAmount: string;
    recipientPusdAmount: string;
    changePusdAmount: string;
    network: "mainnet";
    tipHeight: number;
    broadcast: true;
  }>("/api/pusd/broadcast", {
    method: "POST",
    body: JSON.stringify({
      signedTransactionHex,
      walletAddresses: [walletAddress],
      recipientAddress,
      changeAddress,
      requiredPusdAmount: requiredPusdAmount.toString(),
      maxFeeSatoshis: maxFeeSatoshis.toString(),
    }),
  });
  if (broadcast.network !== "mainnet" || broadcast.txid.toLowerCase() !== verified.txid.toLowerCase() ||
      broadcast.recipientPusdAmount !== requiredPusdAmount.toString()) {
    throw new Error("Mainnet backend confirmation does not match the locally verified signed transaction.");
  }
  return {
    txid: broadcast.txid,
    relayStatus: broadcast.relayStatus,
    confirmationStatus: broadcast.confirmationStatus,
    feeSatoshis: BigInt(broadcast.feeSatoshis),
    inputPusdAmount: BigInt(broadcast.inputPusdAmount),
    recipientPusdAmount: BigInt(broadcast.recipientPusdAmount),
    changePusdAmount: BigInt(broadcast.changePusdAmount),
    network: "mainnet",
    tipHeight: broadcast.tipHeight,
    broadcast: true,
  };
}
