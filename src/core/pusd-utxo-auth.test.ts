import { describe, expect, it, vi } from "vitest";
import {
  binToHex,
  encodeTransactionBCH,
  hashTransaction,
  hexToBin,
} from "@bitauth/libauth";
import { PUSD_ASSET } from "./assets";
import { authenticatePusdUtxo } from "./pusd-utxo-auth";

const ownerScript = "76a914" + "11".repeat(20) + "88ac";
const otherScript = "76a914" + "22".repeat(20) + "88ac";

function fixture(tokenCategory: string = PUSD_ASSET.categoryId) {
  const transaction = {
    version: 2,
    locktime: 0,
    inputs: [{
      outpointTransactionHash: new Uint8Array(32),
      outpointIndex: 0xffffffff,
      sequenceNumber: 0xffffffff,
      unlockingBytecode: hexToBin("01"),
    }],
    outputs: [{
      valueSatoshis: 1500n,
      lockingBytecode: hexToBin(ownerScript),
      token: { category: hexToBin(tokenCategory), amount: 125n },
    }, {
      valueSatoshis: 1000n,
      lockingBytecode: hexToBin(otherScript),
    }],
  };
  const raw = encodeTransactionBCH(transaction);
  return { rawHex: binToHex(raw), txid: hashTransaction(raw) };
}

describe("authenticatePusdUtxo", () => {
  it("authenticates raw prevout hash, script, PUSD category and unspent status", async () => {
    const f = fixture();
    const isUnspent = vi.fn().mockResolvedValue(true);
    const result = await authenticatePusdUtxo({
      outpoint: { txid: f.txid, vout: 0 },
      rawPreviousTransactionHex: f.rawHex,
      expectedLockingBytecode: ownerScript,
      unspentEvidence: { isUnspent },
    });
    expect(result).toMatchObject({
      txid: f.txid,
      vout: 0,
      satoshis: 1500n,
      token: { category: PUSD_ASSET.categoryId, amount: 125n },
      lockingBytecode: ownerScript,
      provenance: { rawTransactionVerified: true, unspentChecked: true },
    });
    expect(isUnspent).toHaveBeenCalledWith({ txid: f.txid, vout: 0 });
  });

  it("rejects a forged txid and never queries unspent state for it", async () => {
    const f = fixture();
    const isUnspent = vi.fn().mockResolvedValue(true);
    await expect(authenticatePusdUtxo({
      outpoint: { txid: "ff".repeat(32), vout: 0 },
      rawPreviousTransactionHex: f.rawHex,
      expectedLockingBytecode: ownerScript,
      unspentEvidence: { isUnspent },
    })).rejects.toThrow(/hash does not match/);
    expect(isUnspent).not.toHaveBeenCalled();
  });

  it("rejects an output script not controlled by the expected wallet script", async () => {
    const f = fixture();
    await expect(authenticatePusdUtxo({
      outpoint: { txid: f.txid, vout: 0 },
      rawPreviousTransactionHex: f.rawHex,
      expectedLockingBytecode: otherScript,
      unspentEvidence: { isUnspent: async () => true },
    })).rejects.toThrow(/expected script/);
  });

  it("rejects wrong token category, missing PUSD and nonexistent output indexes", async () => {
    const wrong = fixture("00".repeat(32));
    await expect(authenticatePusdUtxo({
      outpoint: { txid: wrong.txid, vout: 0 },
      rawPreviousTransactionHex: wrong.rawHex,
      expectedLockingBytecode: ownerScript,
      unspentEvidence: { isUnspent: async () => true },
    })).rejects.toThrow(/unexpected CashToken category/);

    const f = fixture();
    await expect(authenticatePusdUtxo({
      outpoint: { txid: f.txid, vout: 1 },
      rawPreviousTransactionHex: f.rawHex,
      expectedLockingBytecode: otherScript,
      unspentEvidence: { isUnspent: async () => true },
    })).rejects.toThrow(/does not contain PUSD/);
    await expect(authenticatePusdUtxo({
      outpoint: { txid: f.txid, vout: 9 },
      rawPreviousTransactionHex: f.rawHex,
      expectedLockingBytecode: ownerScript,
      unspentEvidence: { isUnspent: async () => true },
    })).rejects.toThrow(/index does not exist/);
  });

  it("fails closed when the outpoint is spent or unspent status is unavailable", async () => {
    const f = fixture();
    await expect(authenticatePusdUtxo({
      outpoint: { txid: f.txid, vout: 0 },
      rawPreviousTransactionHex: f.rawHex,
      expectedLockingBytecode: ownerScript,
      unspentEvidence: { isUnspent: async () => false },
    })).rejects.toThrow(/spent or its unspent status/);
    await expect(authenticatePusdUtxo({
      outpoint: { txid: f.txid, vout: 0 },
      rawPreviousTransactionHex: f.rawHex,
      expectedLockingBytecode: ownerScript,
      unspentEvidence: { isUnspent: async () => { throw new Error("provider unavailable"); } },
    })).rejects.toThrow(/provider unavailable/);
  });

  it("rejects malformed raw transaction hex", async () => {
    await expect(authenticatePusdUtxo({
      outpoint: { txid: "aa".repeat(32), vout: 0 },
      rawPreviousTransactionHex: "not-hex",
      expectedLockingBytecode: ownerScript,
      unspentEvidence: { isUnspent: async () => true },
    })).rejects.toThrow(/raw hexadecimal/);
  });
});
