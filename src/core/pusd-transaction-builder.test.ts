import { describe, expect, it } from "vitest";
import { PUSD_ASSET } from "./assets";
import { buildPusdTransferPlan } from "./pusd-transaction-builder";
import type { AuthenticatedPusdUtxo } from "./pusd-utxo";

const walletScript = "76a914" + "11".repeat(20) + "88ac";
const recipientScript = "76a914" + "22".repeat(20) + "88ac";

function utxo(digit: string, amount: bigint, satoshis: bigint): AuthenticatedPusdUtxo {
  const id = digit.repeat(64);
  return {
    txid: id,
    vout: 0,
    satoshis,
    lockingBytecode: walletScript,
    token: { category: PUSD_ASSET.categoryId, amount },
    provenance: {
      rawTransactionVerified: true,
      txid: id,
      vout: 0,
      unspentChecked: true,
    },
  };
}

const build = (authenticatedUtxos: AuthenticatedPusdUtxo[], requiredPusdAmount = 90n, maxFeeSatoshis = 1000n) =>
  buildPusdTransferPlan({
    authenticatedUtxos,
    requiredPusdAmount,
    recipientLockingBytecode: recipientScript,
    changeLockingBytecode: walletScript,
    feeRateSatoshisPerKb: 1000n,
    maxFeeSatoshis,
  });

describe("buildPusdTransferPlan", () => {
  it("plans recipient and PUSD change outputs with carrier and BCH fee accounting", () => {
    const plan = build([utxo("a", 100n, 3000n)]);
    expect(plan.transaction.inputs).toHaveLength(1);
    expect(plan.transaction.outputs.filter((output) => output.token)).toHaveLength(2);
    expect(plan.recipientPusdAmount).toBe(90n);
    expect(plan.changePusdAmount).toBe(10n);
    expect(plan.transaction.outputs[0].valueSatoshis).toBe(plan.recipientCarrierSatoshis);
    expect(plan.transaction.outputs[1].valueSatoshis).toBe(plan.changeCarrierSatoshis);
    expect(plan.minerFeeSatoshis).toBeGreaterThan(0n);
    expect(plan.minerFeeSatoshis).toBeLessThanOrEqual(1000n);
    expect(plan.sourceOutputs).toHaveLength(1);
    expect(plan.walletInputs).toEqual([0]);
  });

  it("selects another authenticated PUSD input when carrier value is insufficient", () => {
    const first = utxo("a", 100n, 900n);
    const second = utxo("b", 20n, 2000n);
    const plan = build([first, second], 90n);
    expect(plan.selectedUtxos).toHaveLength(2);
    expect(plan.changePusdAmount).toBe(30n);
  });

  it("rejects when PUSD amount is insufficient", () => {
    expect(() => build([utxo("a", 50n, 3000n)], 90n)).toThrow(/Insufficient authenticated PUSD balance/);
  });

  it("rejects when token carrier and fee value cannot cover required outputs", () => {
    expect(() => build([utxo("a", 100n, 500n)], 90n)).toThrow(/not provide enough BCH carrier and fee value/);
  });

  it("rejects a fee above the approved maximum", () => {
    expect(() => build([utxo("a", 100n, 3000n)], 90n, 1n)).toThrow(/within the approved maximum fee/);
  });

  it("rejects UTXOs without matching raw-transaction and unspent provenance", () => {
    const candidate = utxo("a", 100n, 3000n);
    candidate.provenance = { ...candidate.provenance, unspentChecked: false as never };
    expect(() => build([candidate])).toThrow(/provenance/);
  });

  it("rejects change scripts that are not the verified wallet input script", () => {
    expect(() => buildPusdTransferPlan({
      authenticatedUtxos: [utxo("a", 100n, 3000n)],
      requiredPusdAmount: 90n,
      recipientLockingBytecode: recipientScript,
      changeLockingBytecode: recipientScript,
      feeRateSatoshisPerKb: 1000n,
      maxFeeSatoshis: 1000n,
    })).toThrow(/different/);
  });
});
