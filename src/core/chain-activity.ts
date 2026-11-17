import { binToHex, decodeTransactionBCH, hashTransaction, hexToBin } from "@bitauth/libauth";
import { sha256 } from "@cashscript/utils";
import type { NetworkProvider } from "cashscript";
import type { NetworkId } from "./network-config";
import type { MainnetScriptHistorySnapshot, MainnetScriptHistoryRecord } from "./mainnet-quorum-provider";

export type CircleTransactionRecord = MainnetScriptHistoryRecord & {
  network: NetworkId;
  source: "independent-mainnet-quorum" | "single-chipnet-provider";
};

export interface CircleActivitySnapshot {
  network: NetworkId;
  tipHeight: number;
  tipHash: string | null;
  providerConfidence: number;
  truncated: boolean;
  records: CircleTransactionRecord[];
}

type ElectrumAccess = NetworkProvider & {
  performRequest?: (method: string, ...params: unknown[]) => Promise<unknown>;
  getScriptHistory?: (
    lockingBytecodes: readonly (Uint8Array | string)[],
    limit?: number,
  ) => Promise<MainnetScriptHistorySnapshot>;
};

function scriptHashForLockingBytecode(lockingBytecode: Uint8Array | string): string {
  const bytes = typeof lockingBytecode === "string" ? hexToBin(lockingBytecode) : lockingBytecode;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error("Circle history requires non-empty locking bytecode.");
  }
  return binToHex(Uint8Array.from(sha256(bytes)).reverse()).toLowerCase();
}

function normalizeHistory(value: unknown): Array<{ txid: string; height: number }> {
  if (!Array.isArray(value) || value.length > 5_000) {
    throw new Error("Chipnet Electrum returned an invalid or oversized script history.");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Malformed Chipnet history entry.");
    const entry = item as Record<string, unknown>;
    if (typeof entry.tx_hash !== "string" || !/^[0-9a-f]{64}$/i.test(entry.tx_hash) ||
        !Number.isSafeInteger(entry.height) || Number(entry.height) < -1) {
      throw new Error("Chipnet Electrum returned an invalid transaction history item.");
    }
    const txid = entry.tx_hash.toLowerCase();
    if (seen.has(txid)) throw new Error("Chipnet Electrum returned a duplicate history transaction.");
    seen.add(txid);
    return { txid, height: Number(entry.height) };
  }).sort((a, b) => a.txid.localeCompare(b.txid));
}

function normalizeProof(value: unknown): { block_height: number; merkle: string[]; pos: number } {
  if (!value || typeof value !== "object") throw new Error("Missing Chipnet transaction merkle proof.");
  const proof = value as Record<string, unknown>;
  if (!Number.isSafeInteger(proof.block_height) || Number(proof.block_height) < 1 ||
      !Number.isSafeInteger(proof.pos) || Number(proof.pos) < 0 ||
      !Array.isArray(proof.merkle) || proof.merkle.length > 32 ||
      proof.merkle.some((item) => typeof item !== "string" || !/^[0-9a-f]{64}$/i.test(item))) {
    throw new Error("Chipnet Electrum returned a malformed merkle proof.");
  }
  return {
    block_height: Number(proof.block_height),
    merkle: (proof.merkle as string[]).map((item) => item.toLowerCase()),
    pos: Number(proof.pos),
  };
}

function verifyMerkleProof(
  txid: string,
  proof: { block_height: number; merkle: string[]; pos: number },
  headerHex: string,
): boolean {
  if (!/^(?:[0-9a-f]{2}){80}$/i.test(headerHex)) return false;
  let node = hexToBin(txid).reverse();
  let position = proof.pos;
  for (const siblingHex of proof.merkle) {
    const sibling = hexToBin(siblingHex).reverse();
    node = sha256(sha256((position & 1) === 1
      ? new Uint8Array([...sibling, ...node])
      : new Uint8Array([...node, ...sibling])));
    position = Math.floor(position / 2);
  }
  if (position !== 0) return false;
  const root = binToHex(node.reverse()).toLowerCase();
  const headerRoot = binToHex(hexToBin(headerHex).slice(36, 68).reverse()).toLowerCase();
  return root === headerRoot;
}

async function readChipnetHistory(
  provider: ElectrumAccess,
  lockingBytecodes: readonly (Uint8Array | string)[],
  limit: number,
): Promise<CircleActivitySnapshot> {
  if (!provider.performRequest) {
    throw new Error("The selected Chipnet provider does not expose Electrum script-history reads.");
  }
  const scriptHashes = lockingBytecodes.map(scriptHashForLockingBytecode);
  if (scriptHashes.length === 0 || scriptHashes.length > 8 || new Set(scriptHashes).size !== scriptHashes.length) {
    throw new Error("Supply between one and eight unique circle and escrow scripts.");
  }
  const [tipHeight, histories] = await Promise.all([
    provider.getBlockHeight(),
    Promise.all(scriptHashes.map(async (scriptHash) =>
      normalizeHistory(await provider.performRequest!(
        "blockchain.scripthash.get_history", scriptHash,
      )),
    )),
  ]);
  const entries = new Map<string, { txid: string; height: number; scriptIndexes: number[] }>();
  histories.forEach((history, scriptIndex) => {
    for (const item of history) {
      const existing = entries.get(item.txid);
      if (existing && existing.height !== item.height) {
        throw new Error("Chipnet history returned conflicting heights for the same transaction.");
      }
      if (existing) existing.scriptIndexes.push(scriptIndex);
      else entries.set(item.txid, { ...item, scriptIndexes: [scriptIndex] });
    }
  });
  const all = [...entries.values()].sort((a, b) => {
    if (a.height <= 0 && b.height > 0) return -1;
    if (b.height <= 0 && a.height > 0) return 1;
    if (a.height !== b.height) return b.height - a.height;
    return a.txid.localeCompare(b.txid);
  });
  const selected = all.slice(0, limit);
  const records = await Promise.all(selected.map(async (entry): Promise<CircleTransactionRecord> => {
    const base = {
      network: "chipnet" as const,
      txid: entry.txid,
      height: entry.height,
      scriptIndexes: entry.scriptIndexes,
      providerConfidence: 1,
      source: "single-chipnet-provider" as const,
    };
    try {
      const raw = await provider.getRawTransaction(entry.txid);
      if (!/^(?:[0-9a-f]{2})+$/i.test(raw) ||
          hashTransaction(hexToBin(raw)).toLowerCase() !== entry.txid ||
          typeof decodeTransactionBCH(hexToBin(raw)) === "string") {
        throw new Error("The Chipnet raw transaction does not match its transaction ID.");
      }
      if (entry.height <= 0) {
        return { ...base, status: "pending", confirmations: 0, blockHash: null, blockTimestamp: null };
      }
      const proof = normalizeProof(await provider.performRequest!("blockchain.transaction.get_merkle", entry.txid));
      if (proof.block_height !== entry.height || entry.height > tipHeight) {
        throw new Error("Chipnet history and merkle proof disagree on the transaction height.");
      }
      const header = await provider.performRequest!("blockchain.block.header", entry.height);
      if (typeof header !== "string" || !verifyMerkleProof(entry.txid, proof, header)) {
        throw new Error("The Chipnet transaction merkle proof does not match its block header.");
      }
      const headerBytes = hexToBin(header);
      const blockTimestamp = new DataView(
        headerBytes.buffer, headerBytes.byteOffset + 68, 4,
      ).getUint32(0, true) * 1000;
      const blockHash = binToHex(sha256(sha256(headerBytes)).reverse()).toLowerCase();
      return {
        ...base,
        status: "confirmed",
        confirmations: tipHeight - entry.height + 1,
        blockHash,
        blockTimestamp,
      };
    } catch (error) {
      return {
        ...base,
        status: "unknown",
        confirmations: null,
        blockHash: null,
        blockTimestamp: null,
        reason: error instanceof Error ? error.message : "Chipnet transaction could not be verified.",
      };
    }
  }));
  return {
    network: "chipnet",
    tipHeight,
    tipHash: null,
    providerConfidence: 1,
    truncated: all.length > selected.length,
    records,
  };
}

/**
 * Read history for the scripts that actually hold a circle's state/receipts.
 * Mainnet uses independent-provider quorum; Chipnet uses one configured
 * Electrum provider and labels that lower confidence explicitly.
 */
export async function readCircleTransactionHistory(
  provider: NetworkProvider,
  network: NetworkId,
  lockingBytecodes: readonly (Uint8Array | string)[],
  limit = 30,
): Promise<CircleActivitySnapshot> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Activity history limit must be between 1 and 100.");
  }
  const access = provider as ElectrumAccess;
  if (network === "mainnet") {
    if (!access.getScriptHistory) {
      throw new Error("Mainnet provider does not expose quorum-verified script history.");
    }
    const snapshot = await access.getScriptHistory(lockingBytecodes, limit);
    return {
      ...snapshot,
      records: snapshot.records.map((record) => ({
        ...record,
        network: "mainnet",
        source: "independent-mainnet-quorum",
      })),
    };
  }
  return readChipnetHistory(access, lockingBytecodes, limit);
}
