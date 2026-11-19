import { describe, expect, it } from "vitest";
import type { NetworkProvider, SpendableUtxo } from "cashscript";
import { binToHex, cashAddressToLockingBytecode } from "@bitauth/libauth";
import { planWalletConsolidation } from "./wallet-consolidation";
import { buildWizardSignRequest, deriveWizardConnectAddress, type WalletAddressEntry } from "./wizard-wallet";

const getPubkey = (child: number, index: bigint) => Uint8Array.from([0x02, child + 1, ...new Uint8Array(31).fill(Number(index) + 1)]);
const entry = (branch: "receive" | "change", index: number): WalletAddressEntry => ({
  branch, index, address: deriveWizardConnectAddress("hdwalletv1", getPubkey, "chipnet", branch, index)!,
});
const coin = (txByte: number, satoshis: bigint, token = false): SpendableUtxo => ({
  txid: txByte.toString(16).padStart(2, "0").repeat(32),
  vout: 0,
  satoshis,
  ...(token ? { token: { category: "aa".repeat(32), amount: 0n, nft: { capability: "none", commitment: "" } } } : {}),
} as SpendableUtxo);

function providerWith(map: Record<string, SpendableUtxo[]>): NetworkProvider {
  return {
    network: "chipnet",
    getUtxos: async (address: string) => {
      const encoded = cashAddressToLockingBytecode(address);
      if (typeof encoded === "string") throw new Error(encoded);
      return (map[address] ?? []).map((utxo) => ({ ...utxo, lockingBytecode: binToHex(encoded.bytecode) }));
    },
  } as unknown as NetworkProvider;
}

describe("wallet coin consolidation", () => {
  const receive0 = entry("receive", 0);
  const receive3 = entry("receive", 3);
  const change2 = entry("change", 2);
  const addresses = [receive0, receive3, change2];

  it("derives distinct receive and change addresses", () => {
    expect(new Set(addresses.map((a) => a.address)).size).toBe(3);
  });

  it("spends plain coins from receive and change addresses into one output with per-input paths", async () => {
    const provider = providerWith({
      [receive3.address]: [coin(1, 300_000n), coin(2, 5_000n, true)],
      [change2.address]: [coin(3, 100_000n)],
    });
    const plan = await planWalletConsolidation(provider, addresses, receive0.address);
    expect(plan.inputCount).toBe(2);
    expect(plan.totalSatoshis).toBe(400_000n);
    expect(plan.outputSatoshis).toBe(400_000n - plan.fee);
    expect([...plan.inputPaths.values()]).toEqual([{ branch: "receive", index: 3 }, { branch: "change", index: 2 }]);
    expect(plan.wc.transaction.outputs).toHaveLength(1);
    const request = buildWizardSignRequest(plan.wc, plan.walletInputs, plan.inputPaths, "Gather", 1);
    expect(request.inputPaths).toEqual([[0, "receive", 3], [1, "change", 2]]);
  });

  it("refuses foreign destinations, empty wallets and already-gathered coins", async () => {
    await expect(planWalletConsolidation(providerWith({}), addresses, "bchtest:qqqyhkrkrgrv4w0l3x7afnd7vsufrpwzuc83ecs8ye"))
      .rejects.toThrow(/not one of this wallet's addresses/);
    await expect(planWalletConsolidation(providerWith({}), addresses, receive0.address)).rejects.toThrow(/No plain BCH coins/);
    await expect(planWalletConsolidation(providerWith({ [receive0.address]: [coin(4, 50_000n)] }), addresses, receive0.address))
      .rejects.toThrow(/already in a single coin/);
  });

  it("rejects a signing map that misses a wallet input", () => {
    const wc = { transaction: { version: 2, locktime: 0, inputs: [{ outpointTransactionHash: new Uint8Array(32), outpointIndex: 0, unlockingBytecode: new Uint8Array(), sequenceNumber: 0xffffffff }], outputs: [{ valueSatoshis: 1000n, lockingBytecode: Uint8Array.from([0x51]) }] }, sourceOutputs: [{ valueSatoshis: 2000n, lockingBytecode: Uint8Array.from([0x51]) }] };
    expect(() => buildWizardSignRequest(wc, [0], new Map(), "Gather", 1)).toThrow(/Missing or invalid wallet path/);
  });
});
