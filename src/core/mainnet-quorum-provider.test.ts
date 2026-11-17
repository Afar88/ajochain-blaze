import { describe, expect, it } from "vitest";
import type { ElectrumNetworkProvider, SpendableUtxo } from "cashscript";
import {
  BCH_MAINNET_GENESIS_HASH,
  BCH_MAINNET_FORK_CHECKPOINT_HASH,
  BCH_MAINNET_FORK_CHECKPOINT_HEIGHT,
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
      { height: 900_000, headerHex: tipHeader, genesisHeaderHex: genesisHeader, forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH },
      { height: 900_000, headerHex: tipHeader, genesisHeaderHex: genesisHeader, forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH },
    ], now)).toEqual({ height: 900_000, hash: hashMainnetHeader(tipHeader) });
  });

  it("rejects endpoints that disagree on height or header", () => {
    const now = 1_800_000_000_000;
    const first = headerWithTimestamp(Math.floor(now / 1000) - 30, "01");
    const second = headerWithTimestamp(Math.floor(now / 1000) - 29, "02");
    expect(() => validateMainnetTipQuorum([
      { height: 900_000, headerHex: first, genesisHeaderHex: genesisHeader, forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH },
      { height: 900_001, headerHex: second, genesisHeaderHex: genesisHeader, forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH },
    ], now)).toThrow(/disagree/);
  });

  it("requires the BCH-only fork checkpoint because BTC and BCH share genesis", () => {
    const now = 1_800_000_000_000;
    const fresh = headerWithTimestamp(Math.floor(now / 1000) - 30, "01");
    const valid = {
      height: BCH_MAINNET_FORK_CHECKPOINT_HEIGHT + 10,
      headerHex: fresh,
      genesisHeaderHex: genesisHeader,
      forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH,
    };
    expect(validateMainnetTipQuorum([valid, valid], now).height)
      .toBe(BCH_MAINNET_FORK_CHECKPOINT_HEIGHT + 10);
    expect(() => validateMainnetTipQuorum([
      { ...valid, forkCheckpointHash: "00".repeat(32) },
      { ...valid, forkCheckpointHash: "00".repeat(32) },
    ], now)).toThrow(/Bitcoin Cash Mainnet fork chain/);
    expect(() => validateMainnetTipQuorum([
      { ...valid, height: BCH_MAINNET_FORK_CHECKPOINT_HEIGHT - 1 },
      { ...valid, height: BCH_MAINNET_FORK_CHECKPOINT_HEIGHT - 1 },
    ], now)).toThrow(/predates the BCH Mainnet chain-identity checkpoint/);
  });

  it("rejects a non-Mainnet genesis or stale tip", () => {
    const now = 1_800_000_000_000;
    const fresh = headerWithTimestamp(Math.floor(now / 1000) - 30, "01");
    const wrongGenesis = "00".repeat(80);
    expect(() => validateMainnetTipQuorum([
      { height: 900_000, headerHex: fresh, genesisHeaderHex: wrongGenesis },
      { height: 900_000, headerHex: fresh, genesisHeaderHex: wrongGenesis },
    ], now)).toThrow(/genesis chain/);
    const stale = headerWithTimestamp(Math.floor(now / 1000) - 31 * 60, "01");
    expect(() => validateMainnetTipQuorum([
      { height: 900_000, headerHex: stale, genesisHeaderHex: genesisHeader, forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH },
      { height: 900_000, headerHex: stale, genesisHeaderHex: genesisHeader, forkCheckpointHash: BCH_MAINNET_FORK_CHECKPOINT_HASH },
    ], now)).toThrow(/stale/);
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

  it("cannot broadcast through the read-only Mainnet quorum provider", async () => {
    const providers = [{}, {}] as ElectrumNetworkProvider[];
    const provider = new MainnetQuorumNetworkProvider(providers);
    await expect(provider.sendRawTransaction("00")).rejects.toThrow(/read-only/);
  });
});
