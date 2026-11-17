import { createHash } from "node:crypto";
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
  const relay = await broadcastPusdTransactionOnce(
    sessions,
    body.signedTransactionHex,
    expectedTxid,
  );

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
          });
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
      const status = /Rate limit exceeded/.test(message) ? 429 :
        /Request body exceeds/.test(message) ? 413 :
        /Origin is not allowed/.test(message) ? 403 : 400;
      sendJson(response, status, { error: message });
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
