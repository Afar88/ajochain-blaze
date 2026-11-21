import { describe, expect, it } from "vitest";
import { encodeCashAddress, hashTransaction, hexToBin } from "@bitauth/libauth";
import type { ElectrumNetworkProvider, SpendableUtxo } from "cashscript";
import {
  BCH_MAINNET_GENESIS_HASH,
  BCH_MAINNET_FORK_CHECKPOINT_HASH,
  BCH_MAINNET_FORK_CHECKPOINT_HEIGHT,
  BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HASH,
  BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HEIGHT,
  MainnetQuorumNetworkProvider,
  assertMainnetUtxoSnapshotsAgree,
  hashMainnetHeader,
  validateMainnetTipQuorum,
} from "./mainnet-quorum-provider";

const genesisHeader =
  "01000000" +
  "00".repeat(32) +
  "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a" +
  "29ab5f49" +
  "ffff001d" +
  "1dac2b7c";

function headerWithTimestamp(timestamp: number, marker = "00") {
  const bytes = new Uint8Array(80);
  bytes[0] = 1;
  bytes.fill(Number.parseInt(marker, 16), 4, 36);
  bytes[68] = timestamp & 0xff;
  bytes[69] = (timestamp >>> 8) & 0xff;
  bytes[70] = (timestamp >>> 16) & 0xff;
  bytes[71] = (timestamp >>> 24) & 0xff;
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

const mainnetUtxo: SpendableUtxo = {
  txid: "ab".repeat(32),
  vout: 1,
  satoshis: 10_000n,
  lockingBytecode: "76a914" + "11".repeat(20) + "88ac",
};

describe("BCH Mainnet quorum provider", () => {
  it("recognizes the canonical BCH Mainnet genesis header", () => {
    expect(hashMainnetHeader(genesisHeader)).toBe(BCH_MAINNET_GENESIS_HASH);
  });

  it("requires two endpoints to agree on a fresh Mainnet tip and genesis", () => {
    const now = 1_800_000_000_000;
    const tipHeader = headerWithTimestamp(Math.floor(now / 1000) - 30, "01");
    expect(validateMainnetTipQuorum([
      { height: 900_000, headerHex: tipHeader, genesisHeaderHex: genesisHeader, forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH, postBsvForkCheckpointHash: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HASH },
      { height: 900_000, headerHex: tipHeader, genesisHeaderHex: genesisHeader, forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH, postBsvForkCheckpointHash: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HASH },
    ], now)).toEqual({ height: 900_000, hash: hashMainnetHeader(tipHeader) });
  });

  it("rejects endpoints that disagree on height or header", () => {
    const now = 1_800_000_000_000;
    const first = headerWithTimestamp(Math.floor(now / 1000) - 30, "01");
    const second = headerWithTimestamp(Math.floor(now / 1000) - 29, "02");
    expect(() => validateMainnetTipQuorum([
      { height: 900_000, headerHex: first, genesisHeaderHex: genesisHeader, forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH, postBsvForkCheckpointHash: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HASH },
      { height: 900_001, headerHex: second, genesisHeaderHex: genesisHeader, forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH, postBsvForkCheckpointHash: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HASH },
    ], now)).toThrow(/disagree/);
  });

  it("requires BCH fork checkpoints beyond shared BTC genesis and the 2018 BCH/BSV split", () => {
    const now = 1_800_000_000_000;
    const fresh = headerWithTimestamp(Math.floor(now / 1000) - 30, "01");
    const valid = {
      height: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HEIGHT + 10,
      headerHex: fresh,
      genesisHeaderHex: genesisHeader,
      forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH,
      postBsvForkCheckpointHash: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HASH,
    };
    expect(validateMainnetTipQuorum([valid, valid], now).height)
      .toBe(BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HEIGHT + 10);
    expect(() => validateMainnetTipQuorum([
      { ...valid, forkCheckpointHash: "00".repeat(32) },
      { ...valid, forkCheckpointHash: "00".repeat(32) },
    ], now)).toThrow(/Bitcoin Cash Mainnet fork chain/);
    expect(() => validateMainnetTipQuorum([
      { ...valid, postBsvForkCheckpointHash: "00".repeat(32) },
      { ...valid, postBsvForkCheckpointHash: "00".repeat(32) },
    ], now)).toThrow(/Bitcoin Cash Mainnet chain after the 2018 BCH\/BSV split/);
    expect(() => validateMainnetTipQuorum([
      { ...valid, height: BCH_MAINNET_FORK_CHECKPOINT_HEIGHT - 1 },
      { ...valid, height: BCH_MAINNET_FORK_CHECKPOINT_HEIGHT - 1 },
    ], now)).toThrow(/predates the BCH Mainnet chain-identity checkpoint/);
    expect(() => validateMainnetTipQuorum([
      { ...valid, height: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HEIGHT - 1 },
      { ...valid, height: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HEIGHT - 1 },
    ], now)).toThrow(/predates the BCH\/BSV chain-identity checkpoint/);
  });

  it("rejects a non-Mainnet genesis or stale tip", () => {
    const now = 1_800_000_000_000;
    const fresh = headerWithTimestamp(Math.floor(now / 1000) - 30, "01");
    const wrongGenesis = "00".repeat(80);
    expect(() => validateMainnetTipQuorum([
      { height: 900_000, headerHex: fresh, genesisHeaderHex: wrongGenesis, forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH, postBsvForkCheckpointHash: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HASH },
      { height: 900_000, headerHex: fresh, genesisHeaderHex: wrongGenesis, forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH, postBsvForkCheckpointHash: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HASH },
    ], now)).toThrow(/genesis chain/);
    const stale = headerWithTimestamp(Math.floor(now / 1000) - 91 * 60, "01");
    expect(() => validateMainnetTipQuorum([
      { height: 900_000, headerHex: stale, genesisHeaderHex: genesisHeader, forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH, postBsvForkCheckpointHash: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HASH },
      { height: 900_000, headerHex: stale, genesisHeaderHex: genesisHeader, forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH, postBsvForkCheckpointHash: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HASH },
    ], now)).toThrow(/stale/);
    // A normal slow block (60 minutes) is still accepted.
    const slow = headerWithTimestamp(Math.floor(now / 1000) - 60 * 60, "01");
    expect(() => validateMainnetTipQuorum([
      { height: 900_000, headerHex: slow, genesisHeaderHex: genesisHeader, forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH, postBsvForkCheckpointHash: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HASH },
      { height: 900_000, headerHex: slow, genesisHeaderHex: genesisHeader, forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH, postBsvForkCheckpointHash: BCH_MAINNET_POST_BSV_FORK_CHECKPOINT_HASH },
    ], now)).not.toThrow(/stale/);
  });

  it("requires exact agreement across provider UTXO snapshots regardless of ordering", () => {
    const secondUtxo: SpendableUtxo = {
      txid: "cd".repeat(32),
      vout: 0,
      satoshis: 20_000n,
      lockingBytecode: "76a914" + "22".repeat(20) + "88ac",
    };
    expect(assertMainnetUtxoSnapshotsAgree([
      [mainnetUtxo, secondUtxo], [secondUtxo, { ...mainnetUtxo }],
    ])).toEqual([mainnetUtxo, secondUtxo]);
    expect(() => assertMainnetUtxoSnapshotsAgree([
      [mainnetUtxo], [{ ...mainnetUtxo, satoshis: 11_000n }],
    ])).toThrow(/disagree/);
  });

  it("rejects duplicate outpoints inside a single endpoint snapshot", () => {
    expect(() => assertMainnetUtxoSnapshotsAgree([
      [mainnetUtxo, { ...mainnetUtxo }],
      [mainnetUtxo],
    ])).toThrow(/duplicate Mainnet UTXO outpoint/);
  });

  it("rejects malformed UTXO outpoints and value metadata", () => {
    expect(() => assertMainnetUtxoSnapshotsAgree([
      [{ ...mainnetUtxo, txid: "not-a-txid" } as unknown as SpendableUtxo],
      [mainnetUtxo],
    ])).toThrow(/malformed Mainnet UTXO record/);
    expect(() => assertMainnetUtxoSnapshotsAgree([
      [{ ...mainnetUtxo, satoshis: -1n }],
      [mainnetUtxo],
    ])).toThrow(/malformed Mainnet UTXO record/);
  });

  it("rejects an Electrum UTXO mapped to the wrong Mainnet wallet address", async () => {
    const encoded = encodeCashAddress({
      prefix: "bitcoincash",
      type: "p2pkh",
      payload: new Uint8Array(20).fill(0x33),
    });
    if (typeof encoded === "string") throw new Error(encoded);
    const provider = new MainnetQuorumNetworkProvider([
      { getUtxos: async () => [mainnetUtxo] } as unknown as ElectrumNetworkProvider,
      { getUtxos: async () => [mainnetUtxo] } as unknown as ElectrumNetworkProvider,
    ]);
    // Isolate the address-to-script binding check from chain-header fixtures.
    (provider as unknown as { verifyTip: () => Promise<void> }).verifyTip = async () => undefined;
    await expect(provider.getUtxosForAddresses([encoded.address]))
      .rejects.toThrow(/locking script does not match that address/i);
  });

  it("serves quorum-agreed read-only discovery RPCs and rejects unsafe methods", async () => {
    const raw = "0100000001" + "11".repeat(32) + "00000000" + "00" + "ffffffff" +
      "01" + "e803000000000000" + "01" + "51" + "00000000";
    const txid = hashTransaction(hexToBin(raw)).toLowerCase();
    const scriptHash = "ab".repeat(32);
    const history = [
      { tx_hash: "bb".repeat(32), height: 100 },
      { tx_hash: "aa".repeat(32), height: 99 },
    ];
    const endpoint = (entries: unknown, transaction = raw) => ({
      performRequest: async (method: string) => {
        if (method === "blockchain.scripthash.get_history") return entries;
        if (method === "blockchain.transaction.get") return transaction;
        throw new Error("Unexpected Electrum RPC: " + method);
      },
    }) as unknown as ElectrumNetworkProvider;
    const quorum = new MainnetQuorumNetworkProvider([endpoint(history), endpoint(history)]);
    (quorum as unknown as { verifyTip: () => Promise<{ height: number; hash: string }> }).verifyTip = async () => ({
      height: 900_000, hash: "cc".repeat(32),
    });

    expect(await quorum.performRequest("blockchain.scripthash.get_history", scriptHash)).toEqual([
      { tx_hash: "aa".repeat(32), height: 99 },
      { tx_hash: "bb".repeat(32), height: 100 },
    ]);
    expect(await quorum.performRequest("blockchain.transaction.get", txid)).toBe(raw);
    await expect(quorum.performRequest("blockchain.transaction.broadcast", raw))
      .rejects.toThrow(/not permitted/);

    const disagreeingHistory = new MainnetQuorumNetworkProvider([
      endpoint(history), endpoint([{ tx_hash: "aa".repeat(32), height: 98 }, history[0]]),
    ]);
    (disagreeingHistory as unknown as { verifyTip: () => Promise<{ height: number; hash: string }> }).verifyTip = async () => ({
      height: 900_000, hash: "cc".repeat(32),
    });
    await expect(disagreeingHistory.performRequest("blockchain.scripthash.get_history", scriptHash))
      .rejects.toThrow(/disagree on wallet-address transaction history/);
  });

  it("cannot broadcast through the read-only Mainnet quorum provider", async () => {
    const providers = [{}, {}] as ElectrumNetworkProvider[];
    const provider = new MainnetQuorumNetworkProvider(providers);
    await expect(provider.sendRawTransaction("00")).rejects.toThrow(/read-only/);
  });
});
