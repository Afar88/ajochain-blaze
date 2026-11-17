import {
  binToHex,
  decodeTransactionBCH,
  hashTransaction,
  hexToBin,
} from "@bitauth/libauth";
import { sha256 } from "@cashscript/utils";
import type {
  ElectrumNetworkProvider,
  Network,
  NetworkProvider,
  SpendableUtxo,
} from "cashscript";

export const BCH_MAINNET_GENESIS_HASH =
  "000000000019d6689c085ae165831e934ff763ae46a2c172b3f1b60a8ce26f";

/**
 * Bitcoin and Bitcoin Cash share the same genesis block. The first BCH-only
 * block is therefore required as a chain-identity checkpoint, not genesis alone.
 * Hash pinned to Bitcoin Cash Node's Mainnet chainparams UAHF checkpoint.
 */
export const BCH_MAINNET_FORK_CHECKPOINT_HEIGHT = 478_559;
export const BCH_MAINNET_FORK_CHECKPOINT_HASH =
  "000000000000000000651ef99cb9fcbe0dadde1d424bd9f15ff20136191a5eec";

export interface MainnetTipSnapshot {
  height: number;
  headerHex: string;
  genesisHeaderHex: string;
  forkCheckpointHash: string;
}

export function hashMainnetHeader(headerHex: string): string {
  if (!/^(?:[0-9a-f]{2}){80}$/i.test(headerHex)) {
    throw new Error("Electrum returned a malformed 80-byte BCH block header.");
  }
  const first = sha256(hexToBin(headerHex));
  const digest = sha256(first);
  return binToHex(Uint8Array.from(digest).reverse()).toLowerCase();
}

export function validateMainnetTipQuorum(
  snapshots: readonly MainnetTipSnapshot[],
  nowMs = Date.now(),
  maxTipAgeMs = 30 * 60 * 1000,
): { height: number; hash: string } {
  if (snapshots.length < 2) {
    throw new Error("Mainnet chain verification requires at least two independent Electrum endpoints.");
  }

  const normalized = snapshots.map((snapshot) => {
    if (!Number.isSafeInteger(snapshot.height) || snapshot.height < 1) {
      throw new Error("Electrum returned an invalid Mainnet tip height.");
    }
    const genesisHash = hashMainnetHeader(snapshot.genesisHeaderHex);
    if (genesisHash !== BCH_MAINNET_GENESIS_HASH) {
      throw new Error("An Electrum endpoint is not on the Bitcoin Cash Mainnet genesis chain.");
    }
    if (snapshot.height < BCH_MAINNET_FORK_CHECKPOINT_HEIGHT) {
      throw new Error("Electrum tip predates the BCH Mainnet chain-identity checkpoint.");
    }
    if (snapshot.forkCheckpointHash.toLowerCase() !== BCH_MAINNET_FORK_CHECKPOINT_HASH) {
      throw new Error("An Electrum endpoint is not on the Bitcoin Cash Mainnet fork chain.");
    }
    const hash = hashMainnetHeader(snapshot.headerHex);
    const bytes = hexToBin(snapshot.headerHex);
    const timestamp = new DataView(bytes.buffer, bytes.byteOffset + 68, 4).getUint32(0, true) * 1000;
    if (timestamp > nowMs + 10 * 60 * 1000 || nowMs - timestamp > maxTipAgeMs) {
      throw new Error("Electrum Mainnet tip is stale or has an implausible timestamp.");
    }
    return { height: snapshot.height, hash, headerHex: snapshot.headerHex.toLowerCase() };
  });

  const first = normalized[0];
  if (normalized.some((item) =>
    item.height !== first.height || item.hash !== first.hash || item.headerHex !== first.headerHex
  )) {
    throw new Error("Independent Electrum endpoints disagree on the BCH Mainnet chain tip.");
  }
  return { height: first.height, hash: first.hash };
}

function canonicalUtxo(utxo: SpendableUtxo) {
  if (!utxo || typeof utxo !== "object" ||
      typeof utxo.txid !== "string" || !/^[0-9a-f]{64}$/i.test(utxo.txid) ||
      !Number.isSafeInteger(utxo.vout) || utxo.vout < 0 ||
      typeof utxo.satoshis !== "bigint" || utxo.satoshis < 0n ||
      typeof utxo.lockingBytecode !== "string" ||
      !/^(?:[0-9a-f]{2})*$/i.test(utxo.lockingBytecode)) {
    throw new Error("Electrum returned a malformed Mainnet UTXO record.");
  }

  let token: {
    category: string;
    amount: string;
    nft: { capability: string; commitment: string } | null;
  } | null = null;
  if (utxo.token) {
    if (typeof utxo.token.category !== "string" ||
        !/^[0-9a-f]{64}$/i.test(utxo.token.category) ||
        typeof utxo.token.amount !== "bigint" || utxo.token.amount < 0n) {
      throw new Error("Electrum returned malformed CashToken metadata for a Mainnet UTXO.");
    }
    const nft = utxo.token.nft;
    if (nft && (typeof nft.capability !== "string" ||
        typeof nft.commitment !== "string" ||
        !/^(?:[0-9a-f]{2})*$/i.test(nft.commitment))) {
      throw new Error("Electrum returned malformed CashToken NFT metadata for a Mainnet UTXO.");
    }
    token = {
      category: utxo.token.category.toLowerCase(),
      amount: utxo.token.amount.toString(),
      nft: nft ? {
        capability: nft.capability,
        commitment: nft.commitment.toLowerCase(),
      } : null,
    };
  }

  return {
    txid: utxo.txid.toLowerCase(),
    vout: utxo.vout,
    satoshis: utxo.satoshis.toString(),
    lockingBytecode: utxo.lockingBytecode.toLowerCase(),
    token,
  };
}

export function assertMainnetUtxoSnapshotsAgree(
  snapshots: readonly SpendableUtxo[][],
): SpendableUtxo[] {
  if (snapshots.length < 2) {
    throw new Error("At least two Mainnet UTXO snapshots are required.");
  }
  const canonical = (items: SpendableUtxo[]) => {
    if (!Array.isArray(items)) {
      throw new Error("Electrum returned a malformed Mainnet UTXO snapshot.");
    }
    const seen = new Set<string>();
    const normalized = items.map((utxo) => {
      const item = canonicalUtxo(utxo);
      const outpoint = item.txid + ":" + item.vout;
      if (seen.has(outpoint)) {
        throw new Error("Electrum returned a duplicate Mainnet UTXO outpoint: " + outpoint);
      }
      seen.add(outpoint);
      return item;
    });
    return JSON.stringify(normalized.sort((a, b) =>
      (a.txid + ":" + a.vout).localeCompare(b.txid + ":" + b.vout)
    ));
  };
  const expected = canonical(snapshots[0]);
  if (snapshots.slice(1).some((snapshot) => canonical(snapshot) !== expected)) {
    throw new Error("Independent Electrum endpoints disagree on the BCH Mainnet UTXO set.");
  }
  return snapshots[0];
}

function assertPreviousOutputMatches(
  utxo: SpendableUtxo,
  rawTransactionHex: string,
): void {
  const bytes = hexToBin(rawTransactionHex);
  if (typeof decodeTransactionBCH(bytes) === "string") {
    throw new Error("Electrum returned an invalid CashTokens-aware previous transaction.");
  }
  const decoded = decodeTransactionBCH(bytes);
  if (typeof decoded === "string") throw new Error("Previous transaction decoding failed.");
  if (hashTransaction(bytes).toLowerCase() !== utxo.txid.toLowerCase()) {
    throw new Error("Raw previous transaction does not hash to the reported UTXO transaction ID.");
  }
  const output = decoded.outputs[utxo.vout];
  if (!output) throw new Error("Electrum UTXO points to a missing previous-transaction output.");
  if (output.valueSatoshis !== utxo.satoshis ||
      binToHex(output.lockingBytecode).toLowerCase() !== utxo.lockingBytecode.toLowerCase()) {
    throw new Error("Electrum UTXO value or locking script does not match its raw previous transaction.");
  }
  const outputToken = output.token;
  const utxoToken = utxo.token;
  if (Boolean(outputToken) !== Boolean(utxoToken)) {
    throw new Error("Electrum UTXO token metadata does not match its raw previous transaction.");
  }
  if (outputToken && utxoToken) {
    if (binToHex(outputToken.category).toLowerCase() !== utxoToken.category.toLowerCase() ||
        outputToken.amount !== utxoToken.amount ||
        (outputToken.nft?.capability ?? null) !== (utxoToken.nft?.capability ?? null) ||
        binToHex(outputToken.nft?.commitment ?? new Uint8Array()).toLowerCase() !==
          (utxoToken.nft?.commitment ?? "").toLowerCase()) {
      throw new Error("Electrum CashToken data does not match the raw previous transaction.");
    }
  }
}

/**
 * CashScript NetworkProvider backed by a strict, read-only Electrum quorum.
 * Every read first checks BCH Mainnet identity/tip, every UTXO snapshot must
 * agree exactly, and every reported outpoint is checked against raw transaction
 * bytes returned identically by each configured provider.
 *
 * Broadcasting intentionally fails closed. A separate release-approved
 * broadcaster is required before this provider can ever relay real funds.
 */
export class MainnetQuorumNetworkProvider implements NetworkProvider {
  readonly network: Network = "mainnet";

  constructor(private readonly providers: readonly ElectrumNetworkProvider[]) {
    if (providers.length < 2) {
      throw new Error("Configure at least two independent BCH Mainnet Electrum providers.");
    }
  }

  private async verifyTip() {
    const snapshots = await Promise.all(this.providers.map(async (provider) => {
      const [tip, genesisHeader, forkCheckpointHeader] = await Promise.all([
        provider.performRequest("blockchain.headers.subscribe") as Promise<{
          height: number;
          hex: string;
        }>,
        provider.performRequest("blockchain.block.header", 0) as Promise<string>,
        provider.performRequest(
          "blockchain.block.header",
          BCH_MAINNET_FORK_CHECKPOINT_HEIGHT,
        ) as Promise<string>,
      ]);
      return {
        height: tip.height,
        headerHex: tip.hex,
        genesisHeaderHex: genesisHeader,
        forkCheckpointHash: hashMainnetHeader(forkCheckpointHeader),
      };
    }));
    return validateMainnetTipQuorum(snapshots);
  }

  private async verifyUtxos(snapshots: SpendableUtxo[][]): Promise<SpendableUtxo[]> {
    const agreed = assertMainnetUtxoSnapshotsAgree(snapshots);
    const byTxid = new Map<string, SpendableUtxo[]>();
    for (const utxo of agreed) {
      const list = byTxid.get(utxo.txid) ?? [];
      list.push(utxo);
      byTxid.set(utxo.txid, list);
    }
    for (const [txid, utxos] of byTxid) {
      const transactions = await Promise.all(
        this.providers.map((provider) => provider.getRawTransaction(txid)),
      );
      const normalized = transactions.map((raw) => raw.toLowerCase());
      if (normalized.some((raw) => raw !== normalized[0])) {
        throw new Error("Independent Electrum endpoints returned different raw bytes for transaction " + txid + ".");
      }
      for (const utxo of utxos) assertPreviousOutputMatches(utxo, normalized[0]);
    }
    return agreed;
  }

  async getUtxos(address: string): Promise<SpendableUtxo[]> {
    await this.verifyTip();
    const snapshots = await Promise.all(this.providers.map((provider) => provider.getUtxos(address)));
    return this.verifyUtxos(snapshots);
  }

  async getUtxosForLockingBytecode(
    lockingBytecode: Uint8Array | string,
  ): Promise<SpendableUtxo[]> {
    await this.verifyTip();
    const snapshots = await Promise.all(
      this.providers.map((provider) => provider.getUtxosForLockingBytecode(lockingBytecode)),
    );
    return this.verifyUtxos(snapshots);
  }

  async getBlockHeight(): Promise<number> {
    return (await this.verifyTip()).height;
  }

  async getRawTransaction(txid: string): Promise<string> {
    await this.verifyTip();
    const transactions = await Promise.all(
      this.providers.map((provider) => provider.getRawTransaction(txid)),
    );
    const normalized = transactions.map((raw) => raw.toLowerCase());
    if (normalized.some((raw) => raw !== normalized[0])) {
      throw new Error("Independent Electrum endpoints returned different raw transaction bytes.");
    }
    if (hashTransaction(hexToBin(normalized[0])).toLowerCase() !== txid.toLowerCase()) {
      throw new Error("Raw transaction hash does not match the requested transaction ID.");
    }
    return normalized[0];
  }

  async sendRawTransaction(_txHex: string): Promise<string> {
    throw new Error(
      "BCH Mainnet quorum provider is read-only. Mainnet broadcasting requires an independently approved release path.",
    );
  }
}
