import { describe, expect, it } from "vitest";
import {
  binToHex,
  createVirtualMachineBCH2023,
  createVirtualMachineBch2026,
  encodeTransactionBCH,
  hexToBin,
} from "@bitauth/libauth";
import { verifySignedTransaction } from "./wizard-wallet";

function loopSpend() {
  // OP_BEGIN OP_DUP OP_UNTIL OP_DROP OP_1 exits after one truthy iteration.
  const transaction = {
    version: 2,
    locktime: 0,
    inputs: [{
      outpointTransactionHash: new Uint8Array(32).fill(0xab),
      outpointIndex: 0,
      sequenceNumber: 0xffffffff,
      unlockingBytecode: hexToBin("51"),
    }],
    outputs: [{
      valueSatoshis: 9_000n,
      lockingBytecode: hexToBin("51"),
    }],
  };
  const sourceOutputs = [{
    valueSatoshis: 10_000n,
    lockingBytecode: hexToBin("6576667551"),
  }];
  return { transaction, sourceOutputs, signedHex: binToHex(encodeTransactionBCH(transaction)) };
}

describe("active BCH 2026 consensus VM", () => {
  it("executes bounded OP_BEGIN/OP_UNTIL loops and rejects them under the 2023 VM", () => {
    const { transaction, sourceOutputs } = loopSpend();
    expect(createVirtualMachineBch2026().verify({ transaction, sourceOutputs })).toBe(true);
    expect(createVirtualMachineBCH2023().verify({ transaction, sourceOutputs })).not.toBe(true);
  });

  it("uses BCH 2026 consensus verification in the wallet signed-transaction path", () => {
    const { transaction, sourceOutputs, signedHex } = loopSpend();
    expect(verifySignedTransaction(signedHex, transaction, sourceOutputs)).toMatchObject({
      version: transaction.version,
      locktime: transaction.locktime,
      inputs: transaction.inputs,
      outputs: transaction.outputs,
    });
  });

  it("rejects signed wallet transactions without exact previous-output data", () => {
    const { transaction, signedHex } = loopSpend();
    expect(() => verifySignedTransaction(signedHex, transaction, []))
      .toThrow(/Exact previous-output data is missing/);
  });
});
