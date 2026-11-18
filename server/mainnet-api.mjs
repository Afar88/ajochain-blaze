import { createHash } from "node:crypto";
import { Contract } from "cashscript";
import v3AutoReserveArtifact from "../contracts/AjoCircleV3AutoReserve.json" with { type: "json" };
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  binToHex,
  createVirtualMachineBch2026,
  decodeCashAddress,
  decodeTransactionBCH,
  getDustThreshold,
  hashTransaction,
  hexToBin,
} from "@bitauth/libauth";

const PUSD_CATEGORY = "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544";
// Hard release gate: runtime environment variables must never activate real-value broadcasts.
export const MAINNET_BROADCAST_ENABLED = false;
export const MAINNET_GENESIS = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
export const BCH_MAINNET_FORK_CHECKPOINT_HEIGHT = 478_559;
export const BCH_MAINNET_FORK_CHECKPOINT_HASH =
  "000000000000000000651ef99cb9fcbe0dadde1d424bd9f15ff20136191a5eec";
export const BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HEIGHT = 556_767;
export const BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HASH =
  "0000000000000000004626ff6e3b936941d341c5932ece4357eeccac44e6d56c";
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_TIP_AGE_MS = 30 * 60 * 1000;
const MAX_UTXOS_PER_ADDRESS = 1_000;
const MAX_WALLET_ADDRESSES = 20;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const isHex = (value) => typeof value === "string" && /^(?:[0-9a-f]{2})+$/i.test(value);
const reverseHex = (value) => value.match(/../g).reverse().join("").toLowerCase();

function parseServerList(value = process.env.ELECTRUM_SERVERS ?? "") {
  const servers = value.split(",").map((item) => item.trim()).filter(Boolean);
  const unique = [...new Set(servers)];
  if (unique.length < 2) {
    throw new Error("Configure at least two independent ELECTRUM_SERVERS endpoints for mainnet quorum.");
  }
  const hostnames = new Set();
  for (const endpoint of unique) {
    const url = new URL(endpoint);
    if (url.protocol !== "wss:" || !url.hostname) {
      throw new Error("Mainnet Electrum endpoints must use secure wss:// URLs.");
    }
    hostnames.add(url.hostname.toLowerCase());
  }
  if (hostnames.size < 2) {
    throw new Error("Electrum quorum endpoints must use at least two different hostnames.");
  }
  return unique;
}

function doubleSha256(bytes) {
  const first = createHash("sha256").update(bytes).digest();
  return createHash("sha256").update(first).digest();
}

export function hashBlockHeader(headerHex) {
  if (!isHex(headerHex) || headerHex.length !== 160) {
    throw new Error("Electrum returned a malformed 80-byte block header.");
  }
  return Buffer.from(doubleSha256(Buffer.from(headerHex, "hex"))).reverse().toString("hex");
}

export function cashAddressToLockingBytecode(address) {
  if (typeof address !== "string" || !address.trim()) {
    throw new Error("A Bitcoin Cash mainnet address is required.");
  }
  const decoded = decodeCashAddress(address.trim());
  if (typeof decoded === "string") throw new Error("Invalid CashAddress: " + decoded);
  if (decoded.prefix !== "bitcoincash") {
    throw new Error("Only Bitcoin Cash mainnet CashAddresses are supported by this service.");
  }
  const type = String(decoded.type).toLowerCase();
  const payload = binToHex(decoded.payload).toLowerCase();
  if (type === "p2pkh" || type === "p2pkhwithtokens") {
    if (!/^[0-9a-f]{40}$/.test(payload)) throw new Error("P2PKH CashAddress payload must be 20 bytes.");
    return "76a914" + payload + "88ac";
  }
  if (type === "p2sh" || type === "p2shwithtokens") {
    if (/^[0-9a-f]{40}$/.test(payload)) return "a914" + payload + "87";
    if (/^[0-9a-f]{64}$/.test(payload)) return "aa20" + payload + "87";
    throw new Error("P2SH CashAddress payload must be 20 or 32 bytes.");
  }
  throw new Error("Unsupported CashAddress script type: " + decoded.type);
}

export function lockingBytecodeToScriptHash(lockingBytecodeHex) {
  if (!isHex(lockingBytecodeHex)) throw new Error("Locking bytecode must be non-empty hexadecimal.");
  const sha256 = createHash("sha256").update(Buffer.from(lockingBytecodeHex, "hex")).digest();
  return Buffer.from(sha256).reverse().toString("hex");
}

export function normalizeElectrumUnspent(value) {
  if (!Array.isArray(value)) throw new Error("Electrum listunspent response is not an array.");
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== "object" ||
        !/^[0-9a-f]{64}$/i.test(item.tx_hash) ||
        !Number.isSafeInteger(item.tx_pos) || item.tx_pos < 0 ||
        !Number.isSafeInteger(item.height) || item.height < 0 ||
        !(Number.isSafeInteger(item.value) || (typeof item.value === "string" && /^\d+$/.test(item.value)))) {
      throw new Error("Electrum returned a malformed unspent output record.");
    }
    const valueSatoshis = BigInt(item.value);
    if (valueSatoshis <= 0n) throw new Error("Electrum returned a non-positive UTXO value.");
    const txid = item.tx_hash.toLowerCase();
    const key = txid + ":" + item.tx_pos;
    if (seen.has(key)) throw new Error("Electrum returned a duplicate UTXO outpoint.");
    seen.add(key);
    return { txid, vout: item.tx_pos, height: item.height, satoshis: valueSatoshis.toString() };
  }).sort((a, b) => (a.txid + ":" + a.vout).localeCompare(b.txid + ":" + b.vout));
}

export function assertUnspentSnapshotsAgree(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) {
    throw new Error("At least two Electrum UTXO snapshots are required.");
  }
  const canonical = (items) => JSON.stringify(items.map((item) =>
    [item.txid, item.vout, item.height, item.satoshis],
  ).sort((a, b) => (a[0] + ":" + a[1]).localeCompare(b[0] + ":" + b[1])));
  const expected = canonical(snapshots[0]);
  if (snapshots.some((snapshot) => canonical(snapshot) !== expected)) {
    throw new Error("Configured Electrum servers disagree on the wallet's unspent output set.");
  }
  return snapshots[0];
}

class ElectrumSession {
  constructor(endpoint, timeoutMs) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(endpoint);
    this.openPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to Electrum: " + endpoint)), timeoutMs);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Unable to connect to configured Electrum endpoint: " + endpoint));
      }, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      let message;
      try {
        const data = typeof event.data === "string" ? event.data : String(event.data);
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (!Number.isInteger(message.id)) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error("Electrum " + (message.error.message ?? JSON.stringify(message.error))));
      } else {
        pending.resolve(message.result);
      }
    });
    this.ws.addEventListener("close", () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Electrum connection closed before a response was received."));
        this.pending.delete(id);
      }
    });
  }

  async call(method, params) {
    await this.openPromise;
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Electrum connection is not open.");
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Electrum request timed out: " + method));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // A failed WebSocket close must not hide the primary request result.
    }
  }
}

async function withElectrumSessions(callback) {
  if (typeof WebSocket === "undefined") {
    throw new Error("This Node.js runtime does not provide the WebSocket client required for Electrum.");
  }
  const timeoutMs = Number(process.env.ELECTRUM_RPC_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) {
    throw new Error("ELECTRUM_RPC_TIMEOUT_MS must be between 1000 and 60000.");
  }
  const sessions = parseServerList().map((endpoint) => new ElectrumSession(endpoint, timeoutMs));
  try {
    return await callback(sessions);
  } finally {
    sessions.forEach((session) => session.close());
  }
}

/**
 * Bitcoin and Bitcoin Cash share genesis. Verify both BCH-specific fork
 * checkpoints before the API trusts a server for PUSD UTXO/unspent responses.
 */
export function assertBchMainnetChainIdentity({
  height, genesisHash, forkCheckpointHash, postBsvForkCheckpointHash,
}) {
  if (!Number.isSafeInteger(height) || height < 1) {
    throw new Error("Electrum returned an invalid Mainnet tip height.");
  }
  if (genesisHash !== MAINNET_GENESIS) {
    throw new Error("Electrum endpoint is not on the Bitcoin Cash mainnet genesis chain.");
  }
  if (height < BCH_MAINNET_FORK_CHECKPOINT_HEIGHT) {
    throw new Error("Electrum tip predates the BCH/BTC chain-identity checkpoint.");
  }
  if (forkCheckpointHash !== BCH_MAINNET_FORK_CHECKPOINT_HASH) {
    throw new Error("Electrum endpoint is not on the Bitcoin Cash mainnet chain after the 2017 BCH/BTC split.");
  }
  if (height < BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HEIGHT) {
    throw new Error("Electrum tip predates the BCH/BSV chain-identity checkpoint.");
  }
  if (postBsvForkCheckpointHash !== BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HASH) {
    throw new Error("Electrum endpoint is not on the Bitcoin Cash mainnet chain after the 2018 BCH/BSV split.");
  }
}

async function getServerTip(session) {
  const [
    header,
    genesisHeader,
    forkCheckpointHeader,
    postBsvForkCheckpointHeader,
  ] = await Promise.all([
    session.call("blockchain.headers.subscribe", []),
    session.call("blockchain.block.header", [0]),
    session.call("blockchain.block.header", [BCH_MAINNET_FORK_CHECKPOINT_HEIGHT]),
    session.call("blockchain.block.header", [BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HEIGHT]),
  ]);
  if (!header || !Number.isSafeInteger(header.height) || !isHex(header.hex) || header.hex.length !== 160) {
    throw new Error("Electrum returned an invalid current chain tip.");
  }
  assertBchMainnetChainIdentity({
    height: header.height,
    genesisHash: hashBlockHeader(genesisHeader),
    forkCheckpointHash: hashBlockHeader(forkCheckpointHeader),
    postBsvForkCheckpointHash: hashBlockHeader(postBsvForkCheckpointHeader),
  });
  const timestamp = Buffer.from(header.hex, "hex").readUInt32LE(68) * 1000;
  if (timestamp > Date.now() + 10 * 60 * 1000 || Date.now() - timestamp > MAX_TIP_AGE_MS) {
    throw new Error("Electrum chain tip is stale or has an implausible timestamp.");
  }
  return {
    height: header.height,
    hash: hashBlockHeader(header.hex),
    headerHex: header.hex.toLowerCase(),
    timestamp,
  };
}

function assertTipQuorum(tips) {
  if (tips.length < 2) throw new Error("Electrum mainnet quorum is unavailable.");
  const first = tips[0];
  if (tips.some((tip) => tip.height !== first.height || tip.hash !== first.hash || tip.headerHex !== first.headerHex)) {
    throw new Error("Configured Electrum servers disagree on the Bitcoin Cash mainnet tip.");
  }
  return { height: first.height, hash: first.hash, timestamp: first.timestamp };
}

async function getTipQuorum(sessions) {
  const tips = await Promise.all(sessions.map((session) => getServerTip(session)));
  return assertTipQuorum(tips);
}

function bchPerKilobyteToSatoshis(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const satoshis = Math.ceil(value * 100_000_000);
  if (!Number.isSafeInteger(satoshis) || satoshis <= 0 || satoshis > 1_000_000_000) return null;
  return BigInt(satoshis);
}

async function getFeeRateQuorum(sessions) {
  const quotes = await Promise.all(sessions.map(async (session) => {
    let estimated = -1;
    let relay = -1;
    try { estimated = await session.call("blockchain.estimatefee", [2]); } catch { /* try relay floor */ }
    try { relay = await session.call("blockchain.relayfee", []); } catch { /* no fee policy */ }
    const candidates = [
      bchPerKilobyteToSatoshis(estimated),
      bchPerKilobyteToSatoshis(relay),
    ].filter((value) => value !== null);
    if (candidates.length === 0) return null;
    return candidates.reduce((highest, value) => value > highest ? value : highest);
  }));
  const valid = quotes.filter((quote) => quote !== null);
  if (valid.length < 2) {
    throw new Error("At least two Electrum servers must return a usable BCH fee estimate or relay floor.");
  }
  const feeRateSatoshisPerKb = valid.reduce((highest, value) => value > highest ? value : highest);
  return {
    feeRateSatoshisPerKb: (feeRateSatoshisPerKb < 1000n ? 1000n : feeRateSatoshisPerKb).toString(),
    source: "highest of independent Electrum estimates/relay floors, with a 1 sat/byte minimum",
    serversResponding: valid.length,
    serversConfigured: sessions.length,
  };
}

async function getUnspentSnapshots(sessions, lockingBytecodes) {
  const scriptHashes = [...new Set(lockingBytecodes.map(lockingBytecodeToScriptHash))];
  const snapshots = await Promise.all(sessions.map(async (session) => {
    const byOutpoint = new Map();
    for (const scriptHash of scriptHashes) {
      const result = await session.call("blockchain.scripthash.listunspent", [scriptHash]);
      const normalized = normalizeElectrumUnspent(result);
      for (const utxo of normalized) {
        const key = utxo.txid + ":" + utxo.vout;
        if (byOutpoint.has(key)) throw new Error("Same UTXO appeared under multiple wallet scripts.");
        byOutpoint.set(key, utxo);
      }
    }
    return [...byOutpoint.values()].sort((a, b) =>
      (a.txid + ":" + a.vout).localeCompare(b.txid + ":" + b.vout),
    );
  }));
  assertUnspentSnapshotsAgree(snapshots);
  return snapshots;
}

function tokenFromOutput(output) {
  if (!output.token) return undefined;
  const token = {
    category: binToHex(output.token.category).toLowerCase(),
    amount: output.token.amount.toString(),
  };
  if (output.token.nft) {
    token.nft = {
      capability: output.token.nft.capability,
      commitment: binToHex(output.token.nft.commitment),
    };
  }
  return token;
}

async function fetchPreviousTransaction(session, txid) {
  const response = await session.call("blockchain.transaction.get", [txid]);
  const hex = typeof response === "string"
    ? response
    : (response?.hex ?? response?.txHex);
  if (!isHex(hex)) throw new Error("Electrum did not return raw transaction bytes for " + txid + ".");
  const bytes = hexToBin(hex);
  const decoded = decodeTransactionBCH(bytes);
  if (typeof decoded === "string") throw new Error("Raw previous transaction failed CashTokens-aware decoding: " + decoded);
  if (hashTransaction(bytes).toLowerCase() !== txid.toLowerCase()) {
    throw new Error("Raw previous transaction hash mismatch for " + txid + ".");
  }
  return { hex: hex.toLowerCase(), decoded };
}

export function assertPreviousTransactionsAgree(transactions) {
  if (!Array.isArray(transactions) || transactions.length < 2) {
    throw new Error("At least two raw previous-transaction responses are required.");
  }
  const normalized = transactions.map((transaction) => {
    if (!transaction || !isHex(transaction.hex)) {
      throw new Error("An Electrum endpoint returned malformed raw previous-transaction bytes.");
    }
    return transaction.hex.toLowerCase();
  });
  if (normalized.some((hex) => hex !== normalized[0])) {
    throw new Error("Independent Electrum endpoints disagree on raw previous-transaction bytes.");
  }
  return normalized[0];
}


/** Compute the Electrum transaction merkle root (txid and branch hashes are display-order hex). */
export function computeElectrumMerkleRoot(txid, merkle, position) {
  if (!/^[0-9a-f]{64}$/i.test(txid) ||
      !Array.isArray(merkle) || merkle.length > 32 ||
      !Number.isSafeInteger(position) || position < 0 || position > 0xffffffff) {
    throw new Error("Electrum returned a malformed transaction merkle proof.");
  }

  let node = Buffer.from(txid, "hex").reverse();
  let index = position;
  for (const siblingHex of merkle) {
    if (!/^[0-9a-f]{64}$/i.test(siblingHex)) {
      throw new Error("Electrum merkle proof contains a malformed sibling hash.");
    }
    const sibling = Buffer.from(siblingHex, "hex").reverse();
    const pair = (index & 1) === 1
      ? Buffer.concat([sibling, node])
      : Buffer.concat([node, sibling]);
    node = doubleSha256(pair);
    index = Math.floor(index / 2);
  }
  if (index !== 0) {
    throw new Error("Electrum merkle proof position exceeds the supplied branch depth.");
  }
  return Buffer.from(node).reverse().toString("hex");
}

/** Verify a transaction merkle proof against the merkle root in an 80-byte BCH block header. */
export function verifyElectrumMerkleProof(txid, proof, headerHex) {
  if (!proof || !Number.isSafeInteger(proof.block_height) || proof.block_height < 1 ||
      !Array.isArray(proof.merkle) ||
      !Number.isSafeInteger(proof.pos) || proof.pos < 0 ||
      !isHex(headerHex) || headerHex.length !== 160) {
    return false;
  }
  let root;
  try {
    root = computeElectrumMerkleRoot(txid, proof.merkle, proof.pos);
  } catch {
    return false;
  }
  const headerRoot = Buffer.from(headerHex, "hex").subarray(36, 68).reverse().toString("hex");
  return root === headerRoot;
}

function normalizeElectrumMerkleProof(value) {
  if (!value || typeof value !== "object" ||
      !Number.isSafeInteger(value.block_height) || value.block_height < 1 ||
      !Array.isArray(value.merkle) ||
      !Number.isSafeInteger(value.pos) || value.pos < 0 ||
      value.merkle.length > 32 ||
      value.merkle.some((item) => !/^[0-9a-f]{64}$/i.test(item))) {
    throw new Error("Electrum returned a malformed confirmed-transaction merkle proof.");
  }
  return {
    block_height: value.block_height,
    merkle: value.merkle.map((item) => item.toLowerCase()),
    pos: value.pos,
  };
}

function isElectrumUnconfirmedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  // Keep this allow-list narrow: "method not found", provider outages, and
  // arbitrary RPC failures must never be misreported as an ordinary pending tx.
  return /no information available about transaction|transaction not found in block|transaction (?:is )?not confirmed(?: in a block)?|no (?:confirmed )?merkle proof (?:available )?for (?:this )?transaction/i.test(message);
}

/**
 * Read a transaction's status from every configured provider. "confirmed" is
 * returned only when all providers supply identical raw bytes and identical
 * merkle proofs, and the proof verifies against the same block header on every
 * provider. This is an Electrum quorum check, not local SPV/chainwork validation.
 *
 * A previously-confirmed transaction may return pending/unknown after a reorg;
 * callers must replace the old state with the latest result rather than pinning
 * a historical confirmation.
 */
export async function getVerifiedTransactionStatus(sessions, tip, txid) {
  const normalizedTxid = String(txid ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedTxid)) {
    throw new Error("Transaction ID must be exactly 32 bytes of hexadecimal.");
  }
  const unknown = (reason) => ({
    network: "mainnet",
    txid: normalizedTxid,
    status: "unknown",
    confirmations: null,
    tipHeight: tip?.height ?? null,
    tipHash: tip?.hash ?? null,
    providerConfidence: 0,
    reason,
    retryPolicy: "Do not infer failure or retry a spend from an unknown lookup result.",
  });
  if (!Array.isArray(sessions) || sessions.length < 2) {
    return unknown("At least two Electrum providers are required for transaction-status quorum.");
  }
  if (!tip || !Number.isSafeInteger(tip.height) || tip.height < 1 ||
      typeof tip.hash !== "string" || !/^[0-9a-f]{64}$/i.test(tip.hash)) {
    return unknown("A verified BCH Mainnet tip quorum is unavailable.");
  }

  const observations = await Promise.all(sessions.map(async (session) => {
    try {
      const response = await session.call("blockchain.transaction.get", [normalizedTxid]);
      const hex = typeof response === "string" ? response : (response?.hex ?? response?.txHex);
      if (!isHex(hex) || hashTransaction(hexToBin(hex)).toLowerCase() !== normalizedTxid) {
        return { rawHex: null, proof: null, proofError: null, error: "Provider returned missing, malformed, or mismatched raw transaction bytes." };
      }
      let proof = null;
      let proofError = null;
      try {
        proof = normalizeElectrumMerkleProof(
          await session.call("blockchain.transaction.get_merkle", [normalizedTxid]),
        );
      } catch (error) {
        proofError = error instanceof Error ? error.message : String(error);
      }
      return { rawHex: hex.toLowerCase(), proof, proofError, error: null };
    } catch (error) {
      return {
        rawHex: null,
        proof: null,
        proofError: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));

  if (observations.some((item) => item.error || !item.rawHex)) {
    return unknown("Not every provider returned the exact transaction bytes. This may be propagation delay, a conflict, a provider fault, or a reorganisation.");
  }
  try {
    assertPreviousTransactionsAgree(observations.map((item) => ({ hex: item.rawHex })));
  } catch {
    return unknown("Electrum providers disagree on the raw transaction bytes.");
  }

  const proofCount = observations.filter((item) => item.proof !== null).length;
  if (proofCount === 0) {
    if (observations.some((item) => !isElectrumUnconfirmedError(item.proofError))) {
      return unknown("The transaction is known by the providers, but confirmation-proof lookup failed for a reason other than an ordinary unconfirmed transaction.");
    }
    return {
      network: "mainnet",
      txid: normalizedTxid,
      status: "pending",
      confirmations: 0,
      tipHeight: tip.height,
      tipHash: tip.hash,
      providerConfidence: sessions.length,
      verification: "identical-raw-transaction-known-by-electrum-quorum",
      reason: "All configured providers know the exact transaction, but none supplied a block-inclusion proof. This is not confirmation.",
      retryPolicy: "Do not create or broadcast a replacement until inputs and mempool state have been reconciled.",
    };
  }
  if (proofCount !== sessions.length) {
    return unknown("Electrum providers disagree about whether the transaction has a confirmed block-inclusion proof.");
  }

  const proof = observations[0].proof;
  const proofFingerprint = JSON.stringify(proof);
  if (observations.some((item) => JSON.stringify(item.proof) !== proofFingerprint)) {
    return unknown("Electrum providers disagree on the transaction's block height, position, or merkle branch.");
  }
  if (proof.block_height > tip.height) {
    return unknown("Transaction proof refers to a block above the agreed Mainnet tip.");
  }

  let headers;
  try {
    headers = await Promise.all(sessions.map((session) =>
      session.call("blockchain.block.header", [proof.block_height]),
    ));
  } catch {
    return unknown("Could not retrieve the candidate confirmation block header from every provider.");
  }
  if (headers.some((header) => !isHex(header) || header.length !== 160) ||
      headers.some((header) => header.toLowerCase() !== headers[0].toLowerCase())) {
    return unknown("Electrum providers disagree on the block header containing the transaction.");
  }
  const blockHeader = headers[0].toLowerCase();
  if (!verifyElectrumMerkleProof(normalizedTxid, proof, blockHeader)) {
    return unknown("The transaction merkle proof does not match the agreed block header.");
  }

  return {
    network: "mainnet",
    txid: normalizedTxid,
    status: "confirmed",
    confirmations: tip.height - proof.block_height + 1,
    blockHeight: proof.block_height,
    blockHash: hashBlockHeader(blockHeader),
    tipHeight: tip.height,
    tipHash: tip.hash,
    providerConfidence: sessions.length,
    verification: "electrum-quorum-merkle-inclusion",
    verificationLimit: "Providers agree on the block header and transaction inclusion proof; this is not local SPV or chainwork validation.",
    retryPolicy: "Do not rebroadcast a confirmed transaction.",
  };
}

async function fetchQuorumPreviousTransaction(sessions, txid) {
  const transactions = await Promise.all(
    sessions.map((session) => fetchPreviousTransaction(session, txid)),
  );
  const agreedHex = assertPreviousTransactionsAgree(transactions);
  return transactions[0].hex === agreedHex ? transactions[0] : { ...transactions[0], hex: agreedHex };
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

async function getVerifiedAddressUtxos(sessions, tip, address) {
  const lockingBytecode = cashAddressToLockingBytecode(address);
  const snapshots = await getUnspentSnapshots(sessions, [lockingBytecode]);
  const all = snapshots[0];
  if (all.length > MAX_UTXOS_PER_ADDRESS) {
    throw new Error("Wallet has more than " + MAX_UTXOS_PER_ADDRESS + " UTXOs; consolidate before requesting a complete verified snapshot.");
  }
  const confirmed = all.filter((utxo) => utxo.height > 0);
  const unconfirmedCount = all.length - confirmed.length;
  const rawPreviousTransactions = {};
  const previousPromises = new Map();
  const walletUtxos = await mapConcurrent(confirmed, 8, async (candidate) => {
    let previousPromise = previousPromises.get(candidate.txid);
    if (!previousPromise) {
      previousPromise = fetchQuorumPreviousTransaction(sessions, candidate.txid);
      previousPromises.set(candidate.txid, previousPromise);
    }
    const previous = await previousPromise;
    rawPreviousTransactions[candidate.txid] = previous.hex;
    const output = previous.decoded.outputs[candidate.vout];
    if (!output) throw new Error("Electrum referenced a transaction output index that does not exist.");
    if (binToHex(output.lockingBytecode).toLowerCase() !== lockingBytecode) {
      throw new Error("Electrum UTXO does not match the requested CashAddress script.");
    }
    if (output.valueSatoshis.toString() !== candidate.satoshis) {
      throw new Error("Electrum UTXO satoshi value does not match the raw previous transaction.");
    }
    const token = tokenFromOutput(output);
    return {
      txid: candidate.txid,
      vout: candidate.vout,
      satoshis: output.valueSatoshis.toString(),
      lockingBytecode,
      height: candidate.height,
      ...(token ? { token } : {}),
      provenance: {
        rawTransactionVerified: true,
        walletScriptVerified: true,
        electrumQuorum: sessions.length,
        unspentChecked: true,
        tipHeight: tip.height,
        tipHash: tip.hash,
      },
    };
  });
  const pusdUtxos = [];
  const bchUtxos = [];
  const unsupportedTokenUtxos = [];
  let totalPusdAmount = 0n;
  for (const utxo of walletUtxos) {
    if (!utxo.token) {
      bchUtxos.push(utxo);
    } else if (utxo.token.category === PUSD_CATEGORY && !utxo.token.nft && BigInt(utxo.token.amount) > 0n) {
      pusdUtxos.push(utxo);
      totalPusdAmount += BigInt(utxo.token.amount);
    } else {
      unsupportedTokenUtxos.push({
        txid: utxo.txid,
        vout: utxo.vout,
        category: utxo.token.category,
        amount: utxo.token.amount,
        hasNft: Boolean(utxo.token.nft),
      });
    }
  }
  return {
    providerId: "ajochain-electrum-quorum",
    network: "mainnet",
    address,
    category: PUSD_CATEGORY,
    tipHeight: tip.height,
    tipHash: tip.hash,
    observedAtMs: Date.now(),
    paginationComplete: true,
    providerConfidence: sessions.length,
    pusdUtxos,
    bchUtxos,
    unsupportedTokenUtxos,
    walletUtxoCount: walletUtxos.length,
    unconfirmedUtxoCount: unconfirmedCount,
    totalPusdAmount: totalPusdAmount.toString(),
    rawPreviousTransactions,
  };
}

export function assertPusdTokenOutputCarrier(output, outputIndex = 0) {
  const minimumCarrier = getDustThreshold(output);
  if (output.valueSatoshis < minimumCarrier) {
    throw new Error(
      "PUSD token output " + outputIndex + " carrier is below the serialized-output dust threshold of " +
      minimumCarrier.toString() + " sats.",
    );
  }
}

export function assertPusdBchChangeCarrier(output, outputIndex = 0) {
  const minimumCarrier = getDustThreshold(output);
  if (output.valueSatoshis < minimumCarrier) {
    throw new Error(
      "BCH change output " + outputIndex + " is below the serialized-output dust threshold of " +
      minimumCarrier.toString() + " sats.",
    );
  }
}

export function readPusdWalletUnlockingPushes(script) {
  const pushes = [];
  let offset = 0;
  while (offset < script.length) {
    const opcode = script[offset++];
    let length;
    if (opcode <= 75) {
      length = opcode;
    } else if (opcode === 0x4c) {
      if (offset + 1 > script.length) throw new Error("Malformed wallet PUSHDATA1 unlocking script.");
      length = script[offset++];
    } else if (opcode === 0x4d) {
      if (offset + 2 > script.length) throw new Error("Malformed wallet PUSHDATA2 unlocking script.");
      length = script[offset] | (script[offset + 1] << 8);
      offset += 2;
    } else if (opcode === 0x4e) {
      if (offset + 4 > script.length) throw new Error("Malformed wallet PUSHDATA4 unlocking script.");
      length = script.readUInt32LE(offset);
      offset += 4;
    } else {
      throw new Error("Wallet-owned P2PKH input contains a non-push unlocking opcode.");
    }
    if (offset + length > script.length) throw new Error("Wallet unlocking script push exceeds its available bytes.");
    pushes.push(script.subarray(offset, offset + length));
    offset += length;
  }
  return pushes;
}

export function assertRequiredPusdSighash(script, inputIndex = 0) {
  const pushes = readPusdWalletUnlockingPushes(Buffer.from(script));
  if (pushes.length !== 2) {
    throw new Error("Wallet-owned P2PKH input " + inputIndex + " must contain exactly a signature and public-key push.");
  }
  const signature = pushes[0];
  const publicKey = pushes[1];
  if (signature.length < 2 || signature[signature.length - 1] !== 0x61) {
    throw new Error("Wallet-owned P2PKH input " + inputIndex + " must use SIGHASH_ALL | FORKID | UTXOS (0x61).");
  }
  if (publicKey.length !== 33 && publicKey.length !== 65) {
    throw new Error("Wallet-owned P2PKH input " + inputIndex + " has an invalid public-key length.");
  }
}

function parsePositiveBigInt(value, label, allowZero = false) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(label + " must be an integer decimal string.");
  }
  const parsed = BigInt(value);
  if (allowZero ? parsed < 0n : parsed <= 0n) {
    throw new Error(label + " is outside the permitted range.");
  }
  return parsed;
}

function normalizeWalletAddresses(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_WALLET_ADDRESSES) {
    throw new Error("Supply between 1 and " + MAX_WALLET_ADDRESSES + " wallet-derived mainnet addresses.");
  }
  const scripts = value.map(cashAddressToLockingBytecode);
  if (new Set(scripts).size !== scripts.length) {
    throw new Error("Duplicate wallet addresses were supplied.");
  }
  return scripts;
}

/**
 * Relay a fully verified transaction exactly once. If the relay response is
 * lost or malformed, query every configured provider for the exact txid before
 * returning an outcome. Never blindly relay to a second provider after an
 * ambiguous result: the first provider may already have accepted the spend.
 */
const PUSD_BROADCAST_LEDGER_PREFIX = "ajochain:{mainnet-spend}:pusd:submission:v2:";
const MAINNET_SPEND_INPUT_LOCK_PREFIX = "ajochain:{mainnet-spend}:input:v1:";

/**
 * Durable cross-instance idempotency ledger for PUSD Mainnet broadcasts.
 * Uses Upstash Redis REST. There is intentionally no in-memory fallback:
 * missing credentials, storage failures and ambiguous states fail closed.
 * Raw signed transaction bytes are never persisted.
 */
export function isPusdBroadcastLedgerConfigured(env = process.env) {
  const url = env?.UPSTASH_REDIS_REST_URL;
  const token = env?.UPSTASH_REDIS_REST_TOKEN;
  if (typeof url !== "string" || !url.trim() ||
      typeof token !== "string" || !token.trim()) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && Boolean(parsed.hostname) &&
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

export function createUpstashPusdBroadcastLedger(options = {}) {
  const restUrl = options.url ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = options.token ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof restUrl !== "string" || !restUrl.trim() ||
      typeof token !== "string" || !token.trim()) {
    throw new Error("PUSD durable broadcast ledger is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN as private server-side environment variables.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("PUSD durable broadcast ledger requires a server-side HTTPS fetch implementation.");
  }
  let endpoint;
  try { endpoint = new URL(restUrl); }
  catch { throw new Error("PUSD durable broadcast ledger URL is invalid."); }
  if (endpoint.protocol !== "https:" || !endpoint.hostname ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("PUSD durable broadcast ledger must use a clean HTTPS REST URL.");
  }
  const endpointUrl = endpoint.toString().replace(/\/+$/, "");

  async function command(args) {
    let response;
    try {
      response = await fetchImpl(endpointUrl, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
    } catch {
      throw new Error("PUSD durable broadcast ledger is unavailable; no retry or broadcast was attempted.");
    }
    if (!response || !response.ok) {
      throw new Error("PUSD durable broadcast ledger request failed (HTTP " +
        String(response?.status ?? "unknown") + "); broadcast remains blocked.");
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error("PUSD durable broadcast ledger returned malformed JSON; broadcast remains blocked."); }
    if (!payload || typeof payload !== "object" ||
        Object.prototype.hasOwnProperty.call(payload, "error")) {
      throw new Error("PUSD durable broadcast ledger command failed; broadcast remains blocked.");
    }
    return payload.result;
  }

  function normalizeTransaction(txid, signedTransactionHex) {
    if (!/^[0-9a-f]{64}$/i.test(String(txid)) || !isHex(signedTransactionHex)) {
      throw new Error("A valid PUSD transaction ID and exact signed transaction bytes are required for durable idempotency.");
    }
    const normalizedTxid = txid.toLowerCase();
    const normalizedHex = signedTransactionHex.toLowerCase();
    const signedBytes = hexToBin(normalizedHex);
    const actualTxid = hashTransaction(signedBytes).toLowerCase();
    if (actualTxid !== normalizedTxid) {
      throw new Error("PUSD durable ledger transaction ID does not match the signed transaction bytes.");
    }
    const decoded = decodeTransactionBCH(signedBytes);
    if (typeof decoded === "string") {
      throw new Error("PUSD durable ledger could not decode the exact signed transaction inputs: " + decoded);
    }
    if (decoded.inputs.length === 0 || decoded.inputs.length > 500) {
      throw new Error("Mainnet spend reservation requires between 1 and 500 input outpoints.");
    }
    const inputOutpoints = decoded.inputs.map((input) => {
      if (!Number.isSafeInteger(input.outpointIndex) || input.outpointIndex < 0) {
        throw new Error("Signed transaction contains an invalid input outpoint index.");
      }
      const previousTxid = reverseHex(binToHex(input.outpointTransactionHash));
      if (!/^[0-9a-f]{64}$/.test(previousTxid)) {
        throw new Error("Signed transaction contains a malformed input transaction hash.");
      }
      return previousTxid + ":" + input.outpointIndex;
    }).sort();
    if (new Set(inputOutpoints).size !== inputOutpoints.length) {
      throw new Error("Signed transaction contains duplicate input outpoints.");
    }
    const digest = createHash("sha256").update(Buffer.from(normalizedHex, "hex")).digest("hex");
    return { txid: normalizedTxid, digest, inputOutpoints };
  }

  const keyFor = (txid) => PUSD_BROADCAST_LEDGER_PREFIX + txid;
  const inputLockKeyFor = (outpoint) => MAINNET_SPEND_INPUT_LOCK_PREFIX + outpoint;

  function parseRecord(raw, txid) {
    if (typeof raw !== "string") {
      throw new Error("PUSD durable broadcast ledger record has an invalid type.");
    }
    let record;
    try { record = JSON.parse(raw); }
    catch { throw new Error("PUSD durable broadcast ledger record is corrupt; broadcast remains blocked."); }
    if (!record || record.version !== 2 || record.txid !== txid ||
        !/^[0-9a-f]{64}$/.test(record.transactionDigest) ||
        !Array.isArray(record.inputOutpoints) || record.inputOutpoints.length === 0 ||
        record.inputOutpoints.length > 500 ||
        record.inputOutpoints.some((item) => typeof item !== "string" || !/^[0-9a-f]{64}:\d+$/.test(item)) ||
        new Set(record.inputOutpoints).size !== record.inputOutpoints.length ||
        !["submitting", "accepted", "already-known", "unknown"].includes(record.status)) {
      throw new Error("PUSD durable broadcast ledger record failed validation; broadcast remains blocked.");
    }
    return record;
  }

  async function readRecord(txid) {
    const raw = await command(["GET", keyFor(txid)]);
    if (raw === null || raw === undefined) return null;
    return parseRecord(raw, txid);
  }

  function parseInputLock(raw, outpoint) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "string") {
      throw new Error("Mainnet input reservation has an invalid type; broadcast remains blocked.");
    }
    let lock;
    try { lock = JSON.parse(raw); }
    catch { throw new Error("Mainnet input reservation is corrupt; broadcast remains blocked."); }
    if (!lock || lock.version !== 1 || lock.outpoint !== outpoint ||
        !/^[0-9a-f]{64}$/.test(lock.txid) ||
        !/^[0-9a-f]{64}$/.test(lock.transactionDigest)) {
      throw new Error("Mainnet input reservation failed validation; broadcast remains blocked.");
    }
    return lock;
  }

  function assertLockMatches(lock, normalized, outpoint) {
    if (!lock || lock.txid !== normalized.txid ||
        lock.transactionDigest !== normalized.digest ||
        lock.outpoint !== outpoint) {
      const owner = lock?.txid ? " (" + lock.txid + ")" : "";
      throw new Error(
        "Mainnet input outpoint " + outpoint +
        " is already reserved by a different transaction" + owner +
        ". It was not broadcast; reconcile the existing spend before attempting another transaction.",
      );
    }
  }

  async function reserve(txid, signedTransactionHex) {
    const normalized = normalizeTransaction(txid, signedTransactionHex);
    const now = new Date().toISOString();
    const record = {
      version: 2,
      txid: normalized.txid,
      transactionDigest: normalized.digest,
      inputOutpoints: normalized.inputOutpoints,
      status: "submitting",
      relayStatus: null,
      createdAt: now,
      updatedAt: now,
    };
    const lockEntries = normalized.inputOutpoints.map((outpoint) => [
      inputLockKeyFor(outpoint),
      JSON.stringify({
        version: 1,
        txid: normalized.txid,
        transactionDigest: normalized.digest,
        outpoint,
      }),
    ]);
    const allEntries = [[keyFor(normalized.txid), JSON.stringify(record)], ...lockEntries];

    // MSETNX atomically reserves the transaction ID and every input outpoint.
    // All keys share a Redis hash tag so the multi-key reservation stays in one
    // Redis Cluster slot. Locks have no TTL and are intentionally shared by
    // future BCH and PUSD Mainnet spend paths.
    const result = await command(["MSETNX", ...allEntries.flat()]);
    if (Number(result) === 1) return { acquired: true, record };
    if (Number(result) !== 0) {
      throw new Error("PUSD durable broadcast ledger returned an unexpected atomic reservation result.");
    }

    const keys = allEntries.map(([key]) => key);
    const values = await command(["MGET", ...keys]);
    if (!Array.isArray(values) || values.length !== keys.length) {
      throw new Error("Mainnet input reservation lookup returned an incomplete result; broadcast remains blocked.");
    }
    const existingRecord = values[0] === null || values[0] === undefined
      ? null
      : parseRecord(values[0], normalized.txid);
    if (!existingRecord) {
      const conflictLocks = normalized.inputOutpoints.map((outpoint, index) =>
        parseInputLock(values[index + 1], outpoint),
      );
      const conflict = conflictLocks.find((lock) =>
        lock && (lock.txid !== normalized.txid || lock.transactionDigest !== normalized.digest),
      );
      if (conflict) assertLockMatches(conflict, normalized, conflict.outpoint);
      throw new Error("Mainnet input reservation exists without its transaction record; broadcast remains blocked for manual reconciliation.");
    }
    if (existingRecord.transactionDigest !== normalized.digest ||
        JSON.stringify(existingRecord.inputOutpoints) !== JSON.stringify(normalized.inputOutpoints)) {
      throw new Error("PUSD durable broadcast ledger found a transaction-ID, input-set or digest mismatch; broadcast remains blocked.");
    }

    const missingEntries = [];
    for (let index = 0; index < normalized.inputOutpoints.length; index += 1) {
      const outpoint = normalized.inputOutpoints[index];
      const lock = parseInputLock(values[index + 1], outpoint);
      if (lock) assertLockMatches(lock, normalized, outpoint);
      else missingEntries.push(lockEntries[index]);
    }
    if (missingEntries.length > 0) {
      // Backfill only missing locks, still atomically. A competing transaction
      // that wins any input lock causes this reservation to fail.
      const backfillResult = await command(["MSETNX", ...missingEntries.flat()]);
      if (Number(backfillResult) !== 1) {
        const backfillValues = await command(["MGET", ...missingEntries.map(([key]) => key)]);
        if (!Array.isArray(backfillValues) || backfillValues.length !== missingEntries.length) {
          throw new Error("Mainnet input reservation backfill could not be verified; broadcast remains blocked.");
        }
        for (let index = 0; index < missingEntries.length; index += 1) {
          const outpoint = normalized.inputOutpoints.find((item) => inputLockKeyFor(item) === missingEntries[index][0]);
          const lock = parseInputLock(backfillValues[index], outpoint);
          assertLockMatches(lock, normalized, outpoint);
        }
      }
    }
    return { acquired: false, record: existingRecord };
  }

  async function complete(txid, signedTransactionHex, status) {
    if (!["accepted", "already-known", "unknown"].includes(status)) {
      throw new Error("Invalid PUSD durable broadcast terminal status.");
    }
    const normalized = normalizeTransaction(txid, signedTransactionHex);
    const current = await readRecord(normalized.txid);
    if (!current || current.transactionDigest !== normalized.digest ||
        JSON.stringify(current.inputOutpoints) !== JSON.stringify(normalized.inputOutpoints)) {
      throw new Error("PUSD durable broadcast reservation is missing or does not match the signed bytes and input set.");
    }
    const locks = await command([
      "MGET",
      ...normalized.inputOutpoints.map(inputLockKeyFor),
    ]);
    if (!Array.isArray(locks) || locks.length !== normalized.inputOutpoints.length) {
      throw new Error("Mainnet input reservations could not be rechecked; broadcast remains blocked.");
    }
    for (let index = 0; index < locks.length; index += 1) {
      assertLockMatches(
        parseInputLock(locks[index], normalized.inputOutpoints[index]),
        normalized,
        normalized.inputOutpoints[index],
      );
    }
    if (current.status !== "submitting") {
      if (current.status === status) return current;
      throw new Error("PUSD durable broadcast record is already terminal (" + current.status + ").");
    }
    const updated = { ...current, status, relayStatus: status, updatedAt: new Date().toISOString() };
    const result = await command(["SET", keyFor(normalized.txid), JSON.stringify(updated), "XX"]);
    if (result !== "OK") throw new Error("PUSD durable broadcast state could not be persisted; later retries remain blocked.");
    return updated;
  }

  async function get(txid) {
    if (!/^[0-9a-f]{64}$/i.test(String(txid))) {
      throw new Error("Supply a transaction ID containing exactly 64 hexadecimal characters.");
    }
    return readRecord(txid.toLowerCase());
  }

  return Object.freeze({ reserve, complete, get });
}

export async function broadcastPusdTransactionOnce(sessions, signedTransactionHex, expectedTxid) {
  if (!Array.isArray(sessions) || sessions.length < 2) {
    throw new Error("PUSD broadcast recovery requires the configured Electrum quorum.");
  }
  if (!isHex(signedTransactionHex) || !/^[0-9a-f]{64}$/i.test(expectedTxid)) {
    throw new Error("A valid signed transaction and expected transaction ID are required.");
  }

  const normalizedHex = signedTransactionHex.toLowerCase();
  const actualTxid = hashTransaction(hexToBin(normalizedHex)).toLowerCase();
  const normalizedTxid = expectedTxid.toLowerCase();
  if (actualTxid !== normalizedTxid) {
    throw new Error("Expected transaction ID does not match the exact signed transaction bytes.");
  }

  let relayFailure;
  try {
    const relayResult = await sessions[0].call(
      "blockchain.transaction.broadcast",
      [normalizedHex],
    );
    if (typeof relayResult === "string" && relayResult.toLowerCase() === normalizedTxid) {
      return { txid: normalizedTxid, relayStatus: "accepted" };
    }
    relayFailure = new Error(
      "Electrum relay returned a transaction ID that does not match the signed bytes.",
    );
  } catch (error) {
    relayFailure = error instanceof Error ? error : new Error("Unknown Electrum relay error.");
  }

  // A successful lookup is evidence that the exact transaction is already
  // known to a provider. It is not evidence of block confirmation.
  for (const session of sessions) {
    try {
      const knownTransactionHex = await session.call(
        "blockchain.transaction.get",
        [normalizedTxid],
      );
      if (typeof knownTransactionHex === "string" &&
          isHex(knownTransactionHex) &&
          knownTransactionHex.toLowerCase() === normalizedHex) {
        return { txid: normalizedTxid, relayStatus: "already-known" };
      }
    } catch {
      // Continue observing the remaining providers. A lookup failure does not
      // authorize another broadcast attempt.
    }
  }

  const detail = relayFailure?.message ?? "No valid relay response was received.";
  throw new Error(
    "PUSD broadcast result is UNKNOWN for " + normalizedTxid +
    ". It was not retried. Check this exact transaction ID with the configured " +
    "providers and reconcile its mempool/confirmation state before any manual retry. " +
    "Initial relay result: " + detail,
  );
}

async function verifyPusdSpendAndBroadcast(sessions, tip, body) {
  const walletScripts = normalizeWalletAddresses(body.walletAddresses);
  const recipientScript = cashAddressToLockingBytecode(body.recipientAddress);
  const changeScript = cashAddressToLockingBytecode(body.changeAddress);
  if (!walletScripts.includes(changeScript)) {
    throw new Error("PUSD change address must be derived from the connected wallet.");
  }
  if (recipientScript === changeScript) {
    throw new Error("Recipient and wallet change addresses must be different.");
  }
  const requiredAmount = parsePositiveBigInt(body.requiredPusdAmount, "PUSD amount");
  const maxFee = parsePositiveBigInt(body.maxFeeSatoshis, "Maximum fee", true);
  if (!isHex(body.signedTransactionHex)) {
    throw new Error("Signed transaction must be complete hexadecimal bytes.");
  }
  const signedBytes = hexToBin(body.signedTransactionHex);
  const transaction = decodeTransactionBCH(signedBytes);
  if (typeof transaction === "string") throw new Error("Signed transaction failed BCH/CashTokens decoding: " + transaction);
  if (transaction.inputs.length === 0 || transaction.outputs.length === 0) {
    throw new Error("Signed transaction must contain inputs and outputs.");
  }

  const initialSnapshots = await getUnspentSnapshots(sessions, walletScripts);
  const initialUnspent = new Set(initialSnapshots[0].map((item) => item.txid + ":" + item.vout));
  const previousByTxid = {};
  const sourceOutputs = [];
  const seen = new Set();
  let inputSatoshis = 0n;
  let inputPusd = 0n;

  for (const [index, input] of transaction.inputs.entries()) {
    const outpointTxid = reverseHex(binToHex(input.outpointTransactionHash));
    const key = outpointTxid + ":" + input.outpointIndex;
    if (seen.has(key)) throw new Error("Signed transaction contains a duplicate input outpoint.");
    seen.add(key);
    if (!initialUnspent.has(key)) throw new Error("Input " + index + " is already spent or is not present in every Electrum server's UTXO set.");
    let previous = previousByTxid[outpointTxid];
    if (!previous) {
      previous = await fetchQuorumPreviousTransaction(sessions, outpointTxid);
      previousByTxid[outpointTxid] = previous;
    }
    const sourceOutput = previous.decoded.outputs[input.outpointIndex];
    if (!sourceOutput) throw new Error("Previous output index does not exist for input " + index + ".");
    const lockingBytecode = binToHex(sourceOutput.lockingBytecode).toLowerCase();
    if (!walletScripts.includes(lockingBytecode)) {
      throw new Error("Input " + index + " is not controlled by a locally derived wallet address.");
    }
    if (/^76a914[0-9a-f]{40}88ac$/.test(lockingBytecode)) {
      assertRequiredPusdSighash(input.unlockingBytecode, index);
    }
    if (sourceOutput.valueSatoshis <= 0n) throw new Error("Input " + index + " has no BCH carrier value.");
    if (sourceOutput.token) {
      const category = binToHex(sourceOutput.token.category).toLowerCase();
      if (category !== PUSD_CATEGORY || sourceOutput.token.nft || sourceOutput.token.amount <= 0n) {
        throw new Error("Input " + index + " contains an unsupported token category, NFT or amount.");
      }
      inputPusd += sourceOutput.token.amount;
    }
    inputSatoshis += sourceOutput.valueSatoshis;
    sourceOutputs.push(sourceOutput);
  }

  if (inputPusd < requiredAmount) throw new Error("Verified PUSD inputs do not cover the requested amount.");

  let recipientAmount = 0n;
  let changeAmount = 0n;
  let recipientOutputs = 0;
  let changeOutputs = 0;
  let outputSatoshis = 0n;
  for (const [index, output] of transaction.outputs.entries()) {
    outputSatoshis += output.valueSatoshis;
    const script = binToHex(output.lockingBytecode).toLowerCase();
    if (output.token) {
      const category = binToHex(output.token.category).toLowerCase();
      if (category !== PUSD_CATEGORY || output.token.nft || output.token.amount <= 0n) {
        throw new Error("Output " + index + " contains an unsupported token category, NFT or amount.");
      }
      assertPusdTokenOutputCarrier(output, index);
      if (script === recipientScript) {
        recipientAmount += output.token.amount;
        recipientOutputs += 1;
      } else if (script === changeScript) {
        changeAmount += output.token.amount;
        changeOutputs += 1;
      } else {
        throw new Error("PUSD output " + index + " is not directed to the approved recipient or wallet change address.");
      }
    } else {
      if (!walletScripts.includes(script)) {
        throw new Error("BCH-only output " + index + " is not directed to a wallet-derived change address.");
      }
      assertPusdBchChangeCarrier(output, index);
    }
  }

  const expectedChange = inputPusd - requiredAmount;
  if (recipientAmount !== requiredAmount || recipientOutputs !== 1) {
    throw new Error("Signed transaction does not pay the exact requested PUSD amount to the approved recipient.");
  }
  if (changeAmount !== expectedChange || changeOutputs !== (expectedChange > 0n ? 1 : 0)) {
    throw new Error("Signed transaction does not return the exact PUSD remainder to the wallet change address.");
  }
  if (recipientOutputs + changeOutputs !== transaction.outputs.filter((output) => output.token !== undefined).length) {
    throw new Error("Signed transaction contains an unaccounted token output.");
  }

  const fee = inputSatoshis - outputSatoshis;
  if (fee < 0n) throw new Error("Signed transaction creates BCH value.");
  if (fee > maxFee) throw new Error("Signed transaction fee exceeds the approved maximum.");

  const vmResult = createVirtualMachineBch2026().verify({ transaction, sourceOutputs });
  if (vmResult !== true) {
    throw new Error("Signed BCH/CashTokens transaction failed virtual-machine validation: " + vmResult);
  }

  // Re-query the full wallet UTXO set after script verification and immediately
  // before network submission to reduce stale-plan and mempool double-spend risk.
  const finalSnapshots = await getUnspentSnapshots(sessions, walletScripts);
  const finalUnspent = new Set(finalSnapshots[0].map((item) => item.txid + ":" + item.vout));
  for (const key of seen) {
    if (!finalUnspent.has(key)) {
      throw new Error("Input " + key + " was spent while the transaction was being verified.");
    }
  }

  const expectedTxid = hashTransaction(signedBytes).toLowerCase();
  const ledger = createUpstashPusdBroadcastLedger();
  const reservation = await ledger.reserve(expectedTxid, body.signedTransactionHex);
  let relay;
  if (!reservation.acquired) {
    if (reservation.record.status === "accepted" ||
        reservation.record.status === "already-known") {
      relay = {
        txid: expectedTxid,
        relayStatus: reservation.record.relayStatus ?? reservation.record.status,
      };
    } else {
      throw new Error(
        "PUSD durable broadcast ledger already records this exact transaction as " +
        reservation.record.status + ". It was not relayed again. Check the exact transaction ID and reconcile its provider/confirmation status before taking any further action.",
      );
    }
  } else {
    try {
      relay = await broadcastPusdTransactionOnce(sessions, body.signedTransactionHex, expectedTxid);
      await ledger.complete(expectedTxid, body.signedTransactionHex, relay.relayStatus);
    } catch (cause) {
      // A failed final state write leaves the original submitting reservation
      // in place, which continues to block every later relay attempt.
      try { await ledger.complete(expectedTxid, body.signedTransactionHex, "unknown"); }
      catch { /* submitting remains a permanent retry lock */ }
      throw cause;
    }
  }

  return {
    txid: expectedTxid,
    relayStatus: relay.relayStatus,
    confirmationStatus: "not-checked",
    feeSatoshis: fee.toString(),
    inputPusdAmount: inputPusd.toString(),
    recipientPusdAmount: recipientAmount.toString(),
    changePusdAmount: changeAmount.toString(),
    inputCount: transaction.inputs.length,
    outputCount: transaction.outputs.length,
    network: "mainnet",
    tipHeight: tip.height,
    broadcast: true,
  };
}

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
    .split(",").map((origin) => origin.trim()).filter(Boolean),
);
const rateLimit = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;


const BCH_MAINNET_PROJECT_TREASURY_ADDRESS = "bitcoincash:zqtu3577x0swy2gsra6km3033xcj8swg8s4rld9w7q";
const BCH_MAINNET_PROJECT_TREASURY_SCRIPT = "76a91417c8d3de33e0e229101f756dc5f189b123c1c83c88ac";
const BCH_MAINNET_CIRCLE_STATE_DUST = 1_000n;
const BCH_MAINNET_CIRCLE_RECEIPT_DUST = 1_000n;
const BCH_MAINNET_CIRCLE_CHANGE_DUST = 546n;
const BCH_MAINNET_CASH_SCRIPT_INT_MAX = 0x7fffffffffffffffn;

function requireMainnetP2pkhScript(address, label) {
  const script = cashAddressToLockingBytecode(address);
  if (!/^76a914[0-9a-f]{40}88ac$/.test(script)) {
    throw new Error(label + " must be a Bitcoin Cash Mainnet P2PKH address.");
  }
  return script;
}

function validateBchMainnetCircleForVerification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.version !== 2 || value.network !== "mainnet" ||
      value.covenant !== "fee-v3-auto-reserve-mainnet" ||
      typeof value.name !== "string" || !value.name.trim() || value.name.length > 60 ||
      !Array.isArray(value.members) || value.members.length < 2 || value.members.length > 5 ||
      !/^[0-9a-f]{64}$/i.test(String(value.stateCategory ?? ""))) {
    throw new Error("A valid BCH Mainnet V3 circle context is required.");
  }
  const contribution = parsePositiveBigInt(value.contribution, "Circle contribution");
  const maxFee = parsePositiveBigInt(value.maxFee, "Circle maximum fee");
  if (contribution < 200_000n || contribution > BCH_MAINNET_CASH_SCRIPT_INT_MAX ||
      maxFee < 1_000n || maxFee > BCH_MAINNET_CASH_SCRIPT_INT_MAX) {
    throw new Error("BCH Mainnet circle contribution or maximum fee is outside the V3 covenant limits.");
  }
  const members = value.members.map((address, index) =>
    requireMainnetP2pkhScript(address, "Circle member " + (index + 1)),
  );
  if (new Set(members).size !== members.length) {
    throw new Error("BCH Mainnet circle member addresses must be unique.");
  }
  const initiatorScript = requireMainnetP2pkhScript(value.initiator, "Circle initiator");
  if (value.treasury !== BCH_MAINNET_PROJECT_TREASURY_ADDRESS) {
    throw new Error("BCH Mainnet circle fee treasury does not match the immutable AjoChain treasury.");
  }
  const treasuryScript = requireMainnetP2pkhScript(value.treasury, "Project treasury");
  if (treasuryScript !== BCH_MAINNET_PROJECT_TREASURY_SCRIPT) {
    throw new Error("BCH Mainnet project treasury locking bytecode does not match the reviewed constant.");
  }
  const pot = BigInt(members.length) * contribution;
  const projectFee = pot / 100n;
  if (projectFee < BCH_MAINNET_CIRCLE_CHANGE_DUST ||
      maxFee > pot - projectFee - BCH_MAINNET_CIRCLE_CHANGE_DUST) {
    throw new Error("BCH Mainnet circle economics do not leave dust-safe fee and payout outputs.");
  }
  return {
    name: value.name.trim(),
    members,
    memberAddresses: value.members.slice(),
    memberCount: members.length,
    contribution,
    maxFee,
    stateCategory: String(value.stateCategory).toLowerCase(),
    initiatorScript,
    treasuryScript,
  };
}

/**
 * Derive the Mainnet V3 covenant script on the server from the compiled source
 * artifact and the same constructor bindings used by the client. The provider
 * is deliberately mocked: this function performs no network access.
 */
export function createBchMainnetV3ContractContext(circleValue) {
  const circle = validateBchMainnetCircleForVerification(circleValue);
  const memberPkhBytes = circle.members.map((script) => hexToBin(script.slice(6, 46)));
  while (memberPkhBytes.length < 5) memberPkhBytes.push(new Uint8Array(20));
  const treasuryPkhBytes = hexToBin(BCH_MAINNET_PROJECT_TREASURY_SCRIPT.slice(6, 46));
  const initiatorPkhBytes = hexToBin(circle.initiatorScript.slice(6, 46));
  const provider = {
    network: "mainnet",
    getUtxos: async () => { throw new Error("Local BCH Mainnet contract derivation must not access network providers."); },
    getBlockHeight: async () => { throw new Error("Local BCH Mainnet contract derivation must not access network providers."); },
    getRawTransaction: async () => { throw new Error("Local BCH Mainnet contract derivation must not access network providers."); },
    sendRawTransaction: async () => { throw new Error("Local BCH Mainnet contract derivation must never broadcast."); },
  };
  const contract = new Contract(v3AutoReserveArtifact, [
    memberPkhBytes[0], memberPkhBytes[1], memberPkhBytes[2],
    memberPkhBytes[3], memberPkhBytes[4],
    BigInt(circle.memberCount),
    circle.contribution,
    circle.maxFee,
    hexToBin(circle.stateCategory).reverse(),
    initiatorPkhBytes,
    treasuryPkhBytes,
  ], { provider, contractType: "p2sh32" });
  const contractLockingBytecode = String(contract.lockingBytecode).toLowerCase();
  if (!/^aa20[0-9a-f]{64}87$/.test(contractLockingBytecode)) {
    throw new Error("Server-derived BCH Mainnet V3 contract did not produce a valid P2SH32 locking script.");
  }
  if (cashAddressToLockingBytecode(contract.tokenAddress) !== contractLockingBytecode) {
    throw new Error("Server-derived BCH Mainnet V3 contract address and locking script disagree.");
  }
  return {
    ...circle,
    contractLockingBytecode,
    contractAddress: contract.tokenAddress,
  };
}

function bchTokenCategoryHex(token) {
  return token?.category ? binToHex(token.category).toLowerCase() : null;
}

function bchNftCommitmentHex(token) {
  return token?.nft?.commitment ? binToHex(token.nft.commitment).toLowerCase() : null;
}

function assertBchMainnetCircleTokenOutput(output, context, capability, commitment, index) {
  const script = binToHex(output.lockingBytecode).toLowerCase();
  const token = output.token;
  if (script !== context.contractLockingBytecode || !token ||
      bchTokenCategoryHex(token) !== context.stateCategory ||
      token.amount !== 0n || !token.nft ||
      token.nft.capability !== capability ||
      bchNftCommitmentHex(token) !== commitment) {
    throw new Error("BCH Mainnet transaction output " + index + " does not match the expected V3 contract NFT.");
  }
  if (output.valueSatoshis < getDustThreshold(output)) {
    throw new Error("BCH Mainnet transaction output " + index + " is below the CashTokens dust threshold.");
  }
}

function assertBchMainnetPlainOutput(output, expectedScript, index) {
  const script = binToHex(output.lockingBytecode).toLowerCase();
  if (script !== expectedScript || output.token) {
    throw new Error("BCH Mainnet transaction output " + index + " is not the expected token-free recipient or wallet change.");
  }
  if (output.valueSatoshis < getDustThreshold(output)) {
    throw new Error("BCH Mainnet transaction output " + index + " is below the BCH dust threshold.");
  }
}

function bchMainnetNftCommitment(output, label) {
  const commitment = bchNftCommitmentHex(output?.token);
  if (!commitment) throw new Error(label + " is missing its CashTokens NFT commitment.");
  return commitment;
}

function assertBchMainnetReceiptIndex(output, expectedIndex, label) {
  const commitment = bchMainnetNftCommitment(output, label);
  if (!/^520[0-4][0-9a-f]{16}$/.test(commitment) ||
      Number.parseInt(commitment.slice(2, 4), 16) !== expectedIndex) {
    throw new Error(label + " is not the registered member receipt at index " + expectedIndex + ".");
  }
}

function assertBchMainnetStateCommitment(output, expectedRound, expectedPaid, label) {
  const commitment = bchMainnetNftCommitment(output, label);
  if (!/^540[0-5][01]$/.test(commitment) ||
      Number.parseInt(commitment.slice(2, 4), 16) !== expectedRound ||
      Number.parseInt(commitment.slice(4, 6), 16) !== expectedPaid) {
    throw new Error(label + " does not contain the expected V3 round and payout marker.");
  }
}

/**
 * Independently verify a Selene-signed BCH Mainnet V3 transaction.
 * This endpoint only verifies; it never reserves, relays, or broadcasts.
 */
export async function verifyBchMainnetCircleTransaction(sessions, tip, body) {
  const operation = body?.operation;
  if (!["genesis", "deposit", "payout", "cancel"].includes(operation)) {
    throw new Error("Unsupported BCH Mainnet circle verification operation.");
  }
  const context = createBchMainnetV3ContractContext(body.circle);
  const walletScripts = normalizeWalletAddresses(body.walletAddresses);
  if (walletScripts.length !== 1 ||
      walletScripts.some((script) => !/^76a914[0-9a-f]{40}88ac$/.test(script))) {
    throw new Error("BCH Mainnet verification requires exactly one connected wallet-derived P2PKH address.");
  }
  if (operation === "genesis" && walletScripts[0] !== context.initiatorScript) {
    throw new Error("BCH Mainnet V3 genesis must be reviewed by the registered connected initiator wallet.");
  }
  if (!isHex(body.signedTransactionHex)) {
    throw new Error("Signed BCH Mainnet transaction must be complete hexadecimal bytes.");
  }
  const signedBytes = hexToBin(body.signedTransactionHex);
  const transaction = decodeTransactionBCH(signedBytes);
  if (typeof transaction === "string") {
    throw new Error("Signed BCH Mainnet transaction failed CashTokens-aware decoding: " + transaction);
  }
  if (transaction.inputs.length === 0 || transaction.outputs.length === 0) {
    throw new Error("Signed BCH Mainnet transaction must contain inputs and outputs.");
  }
  if (transaction.inputs.length > 100 || transaction.outputs.length > 100) {
    throw new Error("Signed BCH Mainnet transaction exceeds the permitted input or output count.");
  }

  const txid = hashTransaction(signedBytes).toLowerCase();
  const previousByTxid = new Map();
  const sourceOutputs = [];
  const inputScripts = [];
  const inputOutpoints = new Set();
  let inputSatoshis = 0n;

  for (const [index, input] of transaction.inputs.entries()) {
    const previousTxid = reverseHex(binToHex(input.outpointTransactionHash));
    const outpoint = previousTxid + ":" + input.outpointIndex;
    if (inputOutpoints.has(outpoint)) {
      throw new Error("Signed BCH Mainnet transaction contains a duplicate input outpoint.");
    }
    inputOutpoints.add(outpoint);
    let previous = previousByTxid.get(previousTxid);
    if (!previous) {
      previous = await fetchQuorumPreviousTransaction(sessions, previousTxid);
      previousByTxid.set(previousTxid, previous);
    }
    const sourceOutput = previous.decoded.outputs[input.outpointIndex];
    if (!sourceOutput) throw new Error("BCH Mainnet input " + index + " references a missing previous output.");
    const script = binToHex(sourceOutput.lockingBytecode).toLowerCase();
    if (script !== context.contractLockingBytecode && !walletScripts.includes(script)) {
      throw new Error("BCH Mainnet input " + index + " is neither the expected V3 contract nor a connected-wallet P2PKH input.");
    }
    if (script === context.contractLockingBytecode) {
      if (!sourceOutput.token ||
          bchTokenCategoryHex(sourceOutput.token) !== context.stateCategory ||
          sourceOutput.token.amount !== 0n || !sourceOutput.token.nft) {
        throw new Error("BCH Mainnet covenant input " + index + " is not a state or receipt NFT for this circle.");
      }
    } else {
      if (sourceOutput.token) {
        throw new Error("BCH Mainnet wallet funding inputs must be token-free BCH UTXOs.");
      }
      assertRequiredPusdSighash(input.unlockingBytecode, index);
    }
    inputScripts.push(script);
    sourceOutputs.push(sourceOutput);
    inputSatoshis += sourceOutput.valueSatoshis;
  }

  const currentUtxoSnapshots = await getUnspentSnapshots(sessions, [...new Set(inputScripts)]);
  const currentUtxos = new Map(currentUtxoSnapshots[0].map((utxo) => [
    utxo.txid + ":" + utxo.vout,
    utxo,
  ]));
  for (const [index, input] of transaction.inputs.entries()) {
    const previousTxid = reverseHex(binToHex(input.outpointTransactionHash));
    const outpoint = previousTxid + ":" + input.outpointIndex;
    const current = currentUtxos.get(outpoint);
    if (!current || current.height <= 0 ||
        BigInt(current.satoshis) !== sourceOutputs[index].valueSatoshis) {
      throw new Error("BCH Mainnet input " + outpoint + " is not confirmed and unspent in every configured Electrum provider.");
    }
  }

  const memberCount = context.memberCount;
  const contractInputCount = operation === "genesis" ? 0 : operation === "deposit" ? 2 : memberCount + 1;
  for (let index = 0; index < sourceOutputs.length; index += 1) {
    const isContractInput = inputScripts[index] === context.contractLockingBytecode;
    if (isContractInput !== (index < contractInputCount)) {
      throw new Error("BCH Mainnet transaction input order does not match the selected V3 lifecycle operation.");
    }
  }

  if (operation === "genesis") {
    const firstInput = transaction.inputs[0];
    const firstInputTxid = reverseHex(binToHex(firstInput.outpointTransactionHash));
    if (firstInputTxid !== context.stateCategory || firstInput.outpointIndex !== 0) {
      throw new Error("BCH Mainnet V3 genesis category must be derived from the first non-token input at vout 0.");
    }
    if (transaction.outputs.length !== memberCount + 2) {
      throw new Error("BCH Mainnet V3 genesis must contain exactly one state NFT, one receipt per member, and wallet change.");
    }
    if (sourceOutputs.some((output) => output.token)) {
      throw new Error("BCH Mainnet V3 genesis inputs must be non-token BCH UTXOs.");
    }
    assertBchMainnetCircleTokenOutput(
      transaction.outputs[0], context, "minting", "540000", 0,
    );
    if (transaction.outputs[0].valueSatoshis !== BCH_MAINNET_CIRCLE_STATE_DUST) {
      throw new Error("BCH Mainnet V3 genesis state reserve must be exactly 1,000 satoshis.");
    }
    for (let index = 0; index < memberCount; index += 1) {
      const commitment = "52" + index.toString(16).padStart(2, "0") + "00".repeat(8);
      assertBchMainnetCircleTokenOutput(
        transaction.outputs[index + 1], context, "none", commitment, index + 1,
      );
      if (transaction.outputs[index + 1].valueSatoshis !== BCH_MAINNET_CIRCLE_RECEIPT_DUST) {
        throw new Error("BCH Mainnet V3 genesis member receipt reserve must be exactly 1,000 satoshis.");
      }
    }
    if (inputScripts.some((script) => script !== context.initiatorScript)) {
      throw new Error("Every BCH Mainnet V3 genesis funding input must belong to the registered initiator wallet.");
    }
    assertBchMainnetPlainOutput(
      transaction.outputs[memberCount + 1],
      context.initiatorScript,
      memberCount + 1,
    );
  } else if (operation === "deposit") {
    const memberIndex = body.memberIndex;
    if (!Number.isSafeInteger(memberIndex) || memberIndex < 0 || memberIndex >= memberCount ||
        transaction.inputs.length !== 3 || transaction.outputs.length !== 3) {
      throw new Error("BCH Mainnet V3 member deposit must have a valid member index and exactly three inputs and outputs.");
    }
    if (sourceOutputs[0].token.nft.capability !== "minting") {
      throw new Error("BCH Mainnet V3 deposit input 0 must be the minting state NFT.");
    }
    assertBchMainnetReceiptIndex(sourceOutputs[1], memberIndex, "BCH Mainnet deposit input 1");
    if (inputScripts[2] !== context.members[memberIndex] || inputScripts[2] !== walletScripts[0]) {
      throw new Error("BCH Mainnet deposit funding input must belong to both the registered member and the connected wallet.");
    }
    if (bchTokenCategoryHex(transaction.outputs[0].token) !== context.stateCategory ||
        transaction.outputs[0].token?.nft?.capability !== "minting" ||
        bchTokenCategoryHex(transaction.outputs[1].token) !== context.stateCategory ||
        transaction.outputs[1].token?.nft?.capability !== "none") {
      throw new Error("BCH Mainnet deposit must preserve the state NFT and member receipt in the V3 covenant.");
    }
    if (binToHex(transaction.outputs[0].lockingBytecode).toLowerCase() !== context.contractLockingBytecode ||
        binToHex(transaction.outputs[1].lockingBytecode).toLowerCase() !== context.contractLockingBytecode) {
      throw new Error("BCH Mainnet deposit token outputs must return to the exact V3 contract.");
    }
    assertBchMainnetPlainOutput(transaction.outputs[2], inputScripts[2], 2);
  } else if (operation === "payout") {
    if (transaction.inputs.length !== memberCount + 2 ||
        transaction.outputs.length !== memberCount + 4) {
      throw new Error("BCH Mainnet V3 payout must have the exact ordered state, receipt, fee-input and output layout.");
    }
    if (sourceOutputs[0].token.nft.capability !== "minting") {
      throw new Error("BCH Mainnet V3 payout input 0 must be the minting state NFT.");
    }
    const stateCommitment = bchMainnetNftCommitment(sourceOutputs[0], "BCH Mainnet payout state");
    if (!/^540[0-5][01]$/.test(stateCommitment)) {
      throw new Error("BCH Mainnet payout state commitment is malformed.");
    }
    const round = Number.parseInt(stateCommitment.slice(2, 4), 16);
    if (round >= memberCount) throw new Error("BCH Mainnet V3 payout state is already complete.");
    for (let index = 0; index < memberCount; index += 1) {
      assertBchMainnetReceiptIndex(sourceOutputs[index + 1], index, "BCH Mainnet payout receipt input " + (index + 1));
    }
    const feeInputScript = inputScripts[memberCount + 1];
    if (feeInputScript !== walletScripts[0]) {
      throw new Error("BCH Mainnet payout fee input must belong to the connected fee-paying wallet.");
    }
    const pot = BigInt(memberCount) * context.contribution;
    const projectFee = pot / 100n;
    const reserve = round + 1 < memberCount ? context.contribution : 0n;
    const recipientPayout = pot - projectFee - reserve;
    for (let index = 0; index <= memberCount; index += 1) {
      if (binToHex(transaction.outputs[index].lockingBytecode).toLowerCase() !== context.contractLockingBytecode ||
          !transaction.outputs[index].token) {
        throw new Error("BCH Mainnet V3 payout contract outputs must preserve the state NFT and ordered member receipts.");
      }
    }
    assertBchMainnetPlainOutput(transaction.outputs[memberCount + 1], context.treasuryScript, memberCount + 1);
    assertBchMainnetPlainOutput(transaction.outputs[memberCount + 2], context.members[round], memberCount + 2);
    assertBchMainnetPlainOutput(transaction.outputs[memberCount + 3], feeInputScript, memberCount + 3);
    if (transaction.outputs[memberCount + 1].valueSatoshis !== projectFee ||
        transaction.outputs[memberCount + 2].valueSatoshis !== recipientPayout) {
      throw new Error("BCH Mainnet V3 payout treasury fee or scheduled member amount does not match the immutable circle rules.");
    }
  } else {
    if (transaction.inputs.length !== memberCount + 2 ||
        transaction.outputs.length !== memberCount + 1 ||
        inputScripts[memberCount + 1] !== context.initiatorScript ||
        walletScripts[0] !== context.initiatorScript) {
      throw new Error("BCH Mainnet V3 cancellation must include every ordered receipt and the registered initiator fee input.");
    }
    assertBchMainnetStateCommitment(sourceOutputs[0], 0, 0, "BCH Mainnet cancellation state");
    for (let index = 0; index < memberCount; index += 1) {
      assertBchMainnetReceiptIndex(sourceOutputs[index + 1], index, "BCH Mainnet cancellation receipt input " + (index + 1));
      assertBchMainnetPlainOutput(transaction.outputs[index], context.members[index], index);
    }
    assertBchMainnetPlainOutput(transaction.outputs[memberCount], context.initiatorScript, memberCount);
  }

  let outputSatoshis = 0n;
  for (const [index, output] of transaction.outputs.entries()) {
    outputSatoshis += output.valueSatoshis;
    if (output.valueSatoshis < getDustThreshold(output)) {
      throw new Error("BCH Mainnet transaction output " + index + " is below the consensus dust threshold.");
    }
    if (output.token && (
      bchTokenCategoryHex(output.token) !== context.stateCategory ||
      binToHex(output.lockingBytecode).toLowerCase() !== context.contractLockingBytecode
    )) {
      throw new Error("BCH Mainnet transaction contains a CashToken output outside this exact V3 circle.");
    }
  }
  const minerFee = inputSatoshis - outputSatoshis;
  if (minerFee <= 0n || minerFee > context.maxFee) {
    throw new Error("BCH Mainnet transaction miner fee is outside this circle's approved maximum.");
  }
  const vmResult = createVirtualMachineBch2026().verify({ transaction, sourceOutputs });
  if (vmResult !== true) {
    throw new Error("Signed BCH Mainnet V3 transaction failed BCH 2026 virtual-machine verification: " + vmResult);
  }
  return {
    network: "mainnet",
    operation,
    txid,
    contractAddress: context.contractAddress,
    feeSatoshis: minerFee.toString(),
    inputCount: transaction.inputs.length,
    outputCount: transaction.outputs.length,
    tipHeight: tip.height,
    tipHash: tip.hash,
    confirmedInputs: transaction.inputs.length,
    verified: true,
    broadcast: false,
    message: "Selene signature, exact V3 contract bindings, confirmed UTXOs, Electrum quorum and BCH 2026 VM checks passed. No transaction was broadcast.",
  };
}

function setCors(request, response) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const protocol = String(request.headers["x-forwarded-proto"] ?? "https").split(",")[0].trim();
  const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "").split(",")[0].trim();
  const sameOrigin = Boolean(host) && origin === protocol + "://" + host;
  if (!sameOrigin && !allowedOrigins.has(origin)) return false;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Max-Age", "600");
  return true;
}

function sendJson(response, status, payload) {
  const serialized = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": Buffer.byteLength(serialized),
  });
  response.end(serialized);
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new Error("Request body exceeds the permitted size.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function applyRateLimit(request) {
  const now = Date.now();
  const key = request.headers["x-forwarded-for"]?.split(",")[0]?.trim() || request.socket.remoteAddress || "unknown";
  const entries = (rateLimit.get(key) ?? []).filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);
  if (entries.length >= RATE_LIMIT_MAX) throw new Error("Rate limit exceeded; retry in one minute.");
  entries.push(now);
  rateLimit.set(key, entries);
}

export function mainnetApiErrorStatus(message) {
  if (/Rate limit exceeded/.test(message)) return 429;
  if (/Request body exceeds/.test(message)) return 413;
  if (/Origin is not allowed/.test(message)) return 403;
  // A competing transaction cannot reserve an already-locked input.
  if (/input outpoint .*already reserved|input reservation exists/i.test(message)) return 409;
  // Durable state and ambiguous relay failures must fail closed as unavailable.
  if (/result is UNKNOWN|durable broadcast ledger|UPSTASH_REDIS_REST|input reservation/i.test(message)) return 503;
  return 400;
}

export function createMainnetApiServer() {
  return createServer(async (request, response) => {
    if (!setCors(request, response)) {
      sendJson(response, 403, { error: "Origin is not allowed." });
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    try {
      applyRateLimit(request);
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/api/fees") {
        await withElectrumSessions(async (sessions) => {
          const [tip, fees] = await Promise.all([
            getTipQuorum(sessions),
            getFeeRateQuorum(sessions),
          ]);
          sendJson(response, 200, { network: "mainnet", tipHeight: tip.height, tipHash: tip.hash, ...fees });
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        await withElectrumSessions(async (sessions) => {
          const tip = await getTipQuorum(sessions);
          sendJson(response, 200, {
            status: "ready",
            network: "mainnet",
            providerId: "ajochain-electrum-quorum",
            providerConfidence: sessions.length,
            tipHeight: tip.height,
            tipHash: tip.hash,
            broadcastEnabled: MAINNET_BROADCAST_ENABLED,
            pusdDurableSubmissionLedgerConfigured: isPusdBroadcastLedgerConfigured(),
          });
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/pusd/submission") {
        const txid = url.searchParams.get("txid") ?? "";
        if (!/^[0-9a-f]{64}$/i.test(txid)) {
          throw new Error("Supply a transaction ID containing exactly 64 hexadecimal characters.");
        }
        const record = await createUpstashPusdBroadcastLedger().get(txid);
        sendJson(response, 200, {
          network: "mainnet",
          txid: txid.toLowerCase(),
          submissionStatus: record?.status ?? "not-recorded",
          relayStatus: record?.relayStatus ?? null,
          createdAt: record?.createdAt ?? null,
          updatedAt: record?.updatedAt ?? null,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/transaction/status") {
        const txid = url.searchParams.get("txid") ?? "";
        if (!/^[0-9a-f]{64}$/i.test(txid)) {
          throw new Error("Supply a transaction ID containing exactly 64 hexadecimal characters.");
        }
        await withElectrumSessions(async (sessions) => {
          const tip = await getTipQuorum(sessions);
          const result = await getVerifiedTransactionStatus(sessions, tip, txid);
          sendJson(response, 200, result);
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/bch/verify") {
        const body = await readJson(request);
        await withElectrumSessions(async (sessions) => {
          const tip = await getTipQuorum(sessions);
          const result = await verifyBchMainnetCircleTransaction(sessions, tip, body);
          sendJson(response, 200, result);
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/pusd/utxos") {
        const address = url.searchParams.get("address") ?? "";
        await withElectrumSessions(async (sessions) => {
          const tip = await getTipQuorum(sessions);
          const snapshot = await getVerifiedAddressUtxos(sessions, tip, address);
          sendJson(response, 200, snapshot);
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/pusd/unspent") {
        const body = await readJson(request);
        const walletScripts = normalizeWalletAddresses(body.walletAddresses ?? [body.address]);
        if (!Array.isArray(body.outpoints) || body.outpoints.length === 0 || body.outpoints.length > 500) {
          throw new Error("Supply between 1 and 500 outpoints to recheck.");
        }
        const outpoints = body.outpoints.map((item) => {
          if (!item || !/^[0-9a-f]{64}$/i.test(item.txid) ||
              !Number.isSafeInteger(item.vout) || item.vout < 0) {
            throw new Error("Invalid outpoint in unspent-state request.");
          }
          return { txid: item.txid.toLowerCase(), vout: item.vout };
        });
        await withElectrumSessions(async (sessions) => {
          const tip = await getTipQuorum(sessions);
          const snapshots = await getUnspentSnapshots(sessions, walletScripts);
          const present = new Set(snapshots[0].map((item) => item.txid + ":" + item.vout));
          const unspent = Object.fromEntries(outpoints.map((item) => [
            item.txid + ":" + item.vout,
            present.has(item.txid + ":" + item.vout),
          ]));
          sendJson(response, 200, { network: "mainnet", tipHeight: tip.height, tipHash: tip.hash, unspent });
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/pusd/broadcast") {
        if (!MAINNET_BROADCAST_ENABLED) {
          sendJson(response, 403, { error: "Mainnet broadcast is disabled until the release review is approved." });
          return;
        }
        const body = await readJson(request);
        await withElectrumSessions(async (sessions) => {
          const tip = await getTipQuorum(sessions);
          const result = await verifyPusdSpendAndBroadcast(sessions, tip, body);
          sendJson(response, 200, result);
        });
        return;
      }
      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown service error.";
      sendJson(response, mainnetApiErrorStatus(message), { error: message });
    }
  });
}

const isDirectExecution = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isDirectExecution) {
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  const server = createMainnetApiServer();
  server.listen(port, "0.0.0.0", () => {
    process.stdout.write("AjoChain mainnet API listening on port " + port + "\n");
  });
}
