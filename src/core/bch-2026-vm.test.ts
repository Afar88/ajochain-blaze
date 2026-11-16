import { describe, expect, it } from "vitest";
import {
  createVirtualMachineBCH2023,
  createVirtualMachineBch2026,
  hexToBin,
} from "@bitauth/libauth";

describe("active BCH 2026 consensus VM", () => {
  it("executes bounded OP_BEGIN/OP_UNTIL loops in signed-input verification", () => {
    // This small unlocking/locking script spends a 10,000-sat output.
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

    expect(createVirtualMachineBch2026().verify({ transaction, sourceOutputs })).toBe(true);
    expect(createVirtualMachineBCH2023().verify({ transaction, sourceOutputs })).not.toBe(true);
  });
});
