import { describe, expect, it } from "vitest";
import { binToHex, cashAddressToLockingBytecode, encodeTransaction, hashTransactionUiOrder, hexToBin, sha256, type Transaction } from "@bitauth/libauth";
import { MockNetworkProvider, type NetworkProvider } from "cashscript";
import { pkhToAddress } from "./bch-address";
import { createV2FeeCircleContract, v2FeeReceiptCommitment, v2FeeStateCommitment, type V2FeeCircleParams } from "./v2-fee-bch";
import { decodeV2FeeDiscoveryNote, encodeV2FeeDiscoveryNote, v2FeeDiscoveryOutputs } from "./v2-fee-discovery-note";
import { discoverV2FeeCircles, parseV2FeeDiscoveryTransaction } from "./v2-fee-discovery";

const pkh = (byte: number) => new Uint8Array(20).fill(byte);
const CATEGORY = "ab".repeat(32);
const params: V2FeeCircleParams = {
  version: 2,
  covenant: "fee-v3-auto-reserve-closing",
  name: "Found circle " + CATEGORY.slice(0, 8),
  network: "chipnet",
  members: [pkhToAddress(pkh(1), "chipnet"), pkhToAddress(pkh(2), "chipnet"), pkhToAddress(pkh(3), "chipnet")],
  contribution: 200_000n,
  maxFee: 10_000n,
  stateCategory: CATEGORY,
  initiator: pkhToAddress(pkh(1), "chipnet"),
  treasury: "bchtest:zpn8rsua556gewluc0gf5mq4v343w8vc9vfcnq22v6",
};
const CHIPNET_GENESIS_HEADER = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4af1a93c5fffff001d01d3cd06";

function contractBytecode(p: V2FeeCircleParams) {
  const bytecode = createV2FeeCircleContract(p, new MockNetworkProvider()).lockingBytecode as string | Uint8Array;
  return typeof bytecode === "string" ? hexToBin(bytecode) : bytecode;
}

function genesisTx(p: V2FeeCircleParams = params, contract = contractBytecode(p)): Transaction {
  const token = (capability: "minting" | "none", commitment: string) => ({
    amount: 0n, category: hexToBin(p.stateCategory), nft: { capability, commitment: hexToBin(commitment) },
  });
  return {
    version: 2,
    locktime: 0,
    inputs: [{ outpointTransactionHash: hexToBin(p.stateCategory), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() }],
    outputs: [
      { lockingBytecode: contract, valueSatoshis: 1_000n, token: token("minting", v2FeeStateCommitment(0, false)) },
      ...p.members.map((_, i) => ({ lockingBytecode: contract, valueSatoshis: 1_000n, token: token("none", v2FeeReceiptCommitment(i, 0n)) })),
      ...v2FeeDiscoveryOutputs({
        covenant: "fee-v3-auto-reserve-closing",
        members: p.members,
        contribution: p.contribution,
        maxFee: p.maxFee,
        initiatorPkh: pkh(1),
        treasury: p.treasury,
      }),
      { lockingBytecode: (cashAddressToLockingBytecode(p.initiator) as { bytecode: Uint8Array }).bytecode, valueSatoshis: 50_000n },
    ],
  };
}

// The note stores the treasury script; a token-aware treasury address comes back in its plain P2PKH form.
const discovered = { ...params, treasury: "bchtest:qpn8rsua556gewluc0gf5mq4v343w8vc9vwjq7yvnf" };

describe("on-chain circle discovery", () => {
  it("round-trips the settings note", () => {
    const script = encodeV2FeeDiscoveryNote({
      covenant: "fee-v3-auto-reserve-closing", memberCount: 3, contribution: 200_000n, maxFee: 10_000n,
      initiatorPkh: pkh(1), treasuryLockingBytecode: new Uint8Array([0xa9, 0x14, ...pkh(9), 0x87]),
    });
    expect(script.length).toBeLessThanOrEqual(223);
    const note = decodeV2FeeDiscoveryNote(script)!;
    expect(note.memberCount).toBe(3);
    expect(note.contribution).toBe(200_000n);
    expect(note.maxFee).toBe(10_000n);
    expect(binToHex(note.initiatorPkh)).toBe(binToHex(pkh(1)));
    expect(decodeV2FeeDiscoveryNote(script.slice(0, -1))).toBeNull();
  });

  it("rebuilds the exact circle from its genesis transaction", () => {
    expect(parseV2FeeDiscoveryTransaction(genesisTx(), new MockNetworkProvider())).toEqual(discovered);
  });

  it("rejects a genesis whose tokens are not held by the derived covenant", () => {
    const forged = genesisTx(params, new Uint8Array([0xaa, 0x20, ...new Uint8Array(32), 0x87]));
    expect(parseV2FeeDiscoveryTransaction(forged, new MockNetworkProvider())).toBeNull();
  });

  it("rejects incorrect genesis state and receipt BCH backing", () => {
    const provider = new MockNetworkProvider();
    const wrongStateValue = genesisTx();
    wrongStateValue.outputs[0] = { ...wrongStateValue.outputs[0], valueSatoshis: 999n };
    expect(parseV2FeeDiscoveryTransaction(wrongStateValue, provider)).toBeNull();

    const wrongReceiptValue = genesisTx();
    wrongReceiptValue.outputs[1] = { ...wrongReceiptValue.outputs[1], valueSatoshis: 999n };
    expect(parseV2FeeDiscoveryTransaction(wrongReceiptValue, provider)).toBeNull();
  });

  it("rejects altered settings, markers or token commitments", () => {
    const provider = new MockNetworkProvider();
    const wrongMarker = genesisTx();
    wrongMarker.outputs[4] = { ...wrongMarker.outputs[4], valueSatoshis: 600n };
    expect(parseV2FeeDiscoveryTransaction(wrongMarker, provider)).toBeNull();

    const swapped = genesisTx();
    [swapped.outputs[4], swapped.outputs[5]] = [swapped.outputs[5], swapped.outputs[4]];
    expect(parseV2FeeDiscoveryTransaction(swapped, provider)).toBeNull();

    const wrongInput = genesisTx();
    wrongInput.inputs[0] = { ...wrongInput.inputs[0], outpointIndex: 1 };
    expect(parseV2FeeDiscoveryTransaction(wrongInput, provider)).toBeNull();
  });

  it("finds circles that list one of the wallet's addresses and ignores others", async () => {
    const tx = genesisTx();
    const raw = binToHex(encodeTransaction(tx));
    const txid = binToHex(hashTransactionUiOrder(encodeTransaction(tx))).toLowerCase();
    const scriptHash = (address: string) =>
      binToHex(sha256.hash((cashAddressToLockingBytecode(address) as { bytecode: Uint8Array }).bytecode).reverse());
    const histories: Record<string, unknown> = { [scriptHash(params.members[2])]: [{ tx_hash: txid, height: 1 }] };
    const provider = {
      performRequest: async (name: string, arg: string | number) => {
        if (name === "blockchain.block.header") return CHIPNET_GENESIS_HEADER;
        if (name === "blockchain.scripthash.get_history") return histories[arg as string] ?? [];
        return null;
      },
      getRawTransaction: async () => raw,
    } as unknown as NetworkProvider;
    expect(await discoverV2FeeCircles(provider, [params.members[2]])).toEqual([discovered]);
    expect(await discoverV2FeeCircles(provider, [pkhToAddress(pkh(7), "chipnet")])).toEqual([]);
  });  it("ignores unconfirmed genesis transactions until they have a block height", async () => {
    const tx = genesisTx();
    const raw = binToHex(encodeTransaction(tx));
    const txid = binToHex(hashTransactionUiOrder(encodeTransaction(tx))).toLowerCase();
    const address = params.members[2];
    let rawReads = 0;
    const provider = {
      performRequest: async (name: string) => {
        if (name === "blockchain.block.header") return CHIPNET_GENESIS_HEADER;
        if (name === "blockchain.scripthash.get_history") return [{ tx_hash: txid, height: 0 }];
        return null;
      },
      getRawTransaction: async () => { rawReads += 1; return raw; },
    } as unknown as NetworkProvider;
    expect(await discoverV2FeeCircles(provider, [address])).toEqual([]);
    expect(rawReads).toBe(0);
  });

  it("rejects raw transaction bytes that do not match the confirmed history txid", async () => {
    const tx = genesisTx();
    const raw = binToHex(encodeTransaction(tx));
    const address = params.members[2];
    const wrongTxid = "cd".repeat(32);
    const provider = {
      performRequest: async (name: string) => {
        if (name === "blockchain.block.header") return CHIPNET_GENESIS_HEADER;
        if (name === "blockchain.scripthash.get_history") return [{ tx_hash: wrongTxid, height: 1 }];
        return null;
      },
      getRawTransaction: async () => raw,
    } as unknown as NetworkProvider;
    expect(await discoverV2FeeCircles(provider, [address])).toEqual([]);
  });
  it("checks every wallet address before applying the global transaction scan limit", async () => {
    const tx = genesisTx();
    const raw = binToHex(encodeTransaction(tx));
    const actualTxid = binToHex(hashTransactionUiOrder(encodeTransaction(tx))).toLowerCase();
    const busyAddress = params.members[0];
    const circleAddress = params.members[2];
    const scriptHash = (address: string) =>
      binToHex(sha256.hash((cashAddressToLockingBytecode(address) as { bytecode: Uint8Array }).bytecode).reverse());
    const histories: Record<string, unknown> = {
      [scriptHash(busyAddress)]: [
        { tx_hash: "11".repeat(32), height: 10 },
        { tx_hash: "22".repeat(32), height: 11 },
      ],
      [scriptHash(circleAddress)]: [
        { tx_hash: actualTxid, height: 12 },
      ],
    };
    const provider = {
      performRequest: async (name: string, arg: string | number) => {
        if (name === "blockchain.block.header") return CHIPNET_GENESIS_HEADER;
        if (name === "blockchain.scripthash.get_history") return histories[arg as string] ?? [];
        return null;
      },
      getRawTransaction: async () => raw,
    } as unknown as NetworkProvider;
    expect(await discoverV2FeeCircles(provider, [busyAddress, circleAddress], 2)).toEqual([discovered]);
  });

});
