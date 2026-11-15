import { describe, expect, it, vi } from "vitest";
import { binToHex, encodeTransactionBCH, hashTransaction, hexToBin } from "@bitauth/libauth";
import { PUSD_ASSET } from "./assets";
import { verifySignedPusdTransaction } from "./pusd-signed-transaction";

const walletScript = "76a914" + "11".repeat(20) + "88ac";
const recipientScript = "76a914" + "22".repeat(20) + "88ac";
const attackerScript = "76a914" + "33".repeat(20) + "88ac";
const reverseHex = (value: string) => value.match(/../g)!.reverse().join("");

function previousOutput(script = walletScript) {
  const raw = encodeTransactionBCH({
    version: 2,
    locktime: 0,
    inputs: [{
      outpointTransactionHash: new Uint8Array(32),
      outpointIndex: 0xffffffff,
      sequenceNumber: 0xffffffff,
      unlockingBytecode: hexToBin("01"),
    }],
    outputs: [{
      valueSatoshis: 3000n,
      lockingBytecode: hexToBin(script),
      token: { category: hexToBin(PUSD_ASSET.categoryId), amount: 100n },
    }],
  });
  return { rawHex: binToHex(raw), txid: hashTransaction(raw) };
}

function signedSpend(outputScript = recipientScript, outputAmount = 90n, outputSatoshis = 2000n, previousScript = walletScript) {
  const previous = previousOutput(previousScript);
  const signed = encodeTransactionBCH({
    version: 2,
    locktime: 0,
    inputs: [{
      outpointTransactionHash: hexToBin(reverseHex(previous.txid)),
      outpointIndex: 0,
      sequenceNumber: 0xffffffff,
      unlockingBytecode: new Uint8Array(),
    }],
    outputs: [{
      valueSatoshis: 1000n,
      lockingBytecode: hexToBin(outputScript),
      token: { category: hexToBin(PUSD_ASSET.categoryId), amount: outputAmount },
    }, ...(outputAmount < 100n ? [{
      valueSatoshis: 1000n,
      lockingBytecode: hexToBin(walletScript),
      token: { category: hexToBin(PUSD_ASSET.categoryId), amount: 100n - outputAmount },
    }] : [])],
  });
  return {
    previous,
    signedHex: binToHex(signed),
  };
}

const verify = (options: {
  signedHex: string;
  previous: ReturnType<typeof previousOutput>;
  walletScripts?: string[];
  recipientScript?: string;
  requiredAmount?: bigint;
  isUnspent?: () => Promise<boolean>;
}) => verifySignedPusdTransaction({
  signedTransactionHex: options.signedHex,
  rawPreviousTransactions: { [options.previous.txid]: options.previous.rawHex },
  walletLockingBytecodes: options.walletScripts ?? [walletScript],
  recipientLockingBytecode: options.recipientScript ?? recipientScript,
  changeLockingBytecode: walletScript,
  requiredPusdAmount: options.requiredAmount ?? 90n,
  maxFeeSatoshis: 1000n,
  unspentEvidence: { isUnspent: options.isUnspent ?? (async () => true) },
});

describe("verifySignedPusdTransaction", () => {
  it("rejects incomplete signed transaction hex", async () => {
    const fixture = signedSpend();
    await expect(verify({
      signedHex: "not-hex",
      previous: fixture.previous,
    })).rejects.toThrow(/complete hexadecimal/);
  });

  it("requires raw previous transaction data for each input", async () => {
    const fixture = signedSpend();
    await expect(verifySignedPusdTransaction({
      signedTransactionHex: fixture.signedHex,
      rawPreviousTransactions: {},
      walletLockingBytecodes: [walletScript],
      recipientLockingBytecode: recipientScript,
      changeLockingBytecode: walletScript,
      requiredPusdAmount: 90n,
      maxFeeSatoshis: 1000n,
      unspentEvidence: { isUnspent: async () => true },
    })).rejects.toThrow(/Raw previous transaction is missing/);
  });

  it("rejects inputs whose raw prevout is not controlled by the wallet scripts", async () => {
    const fixture = signedSpend(recipientScript, 90n, 2000n, attackerScript);
    const isUnspent = vi.fn().mockResolvedValue(true);
    await expect(verify({
      signedHex: fixture.signedHex,
      previous: fixture.previous,
      isUnspent,
    })).rejects.toThrow(/not locked to a locally derived wallet script/);
    expect(isUnspent).not.toHaveBeenCalled();
  });

  it("rechecks unspent status and fails closed for spent outputs", async () => {
    const fixture = signedSpend();
    await expect(verify({
      signedHex: fixture.signedHex,
      previous: fixture.previous,
      isUnspent: async () => false,
    })).rejects.toThrow(/spent or its unspent state is unavailable/);
  });

  it("rejects a PUSD output sent to an unapproved script", async () => {
    const fixture = signedSpend(attackerScript);
    await expect(verify({
      signedHex: fixture.signedHex,
      previous: fixture.previous,
    })).rejects.toThrow(/not directed to the approved recipient/);
  });

  it("rejects zero-value, negative-fee, or unaffordable PUSD plans before script execution", async () => {
    const fixture = signedSpend(recipientScript, 90n, 2100n);
    await expect(verify({
      signedHex: fixture.signedHex,
      previous: fixture.previous,
      requiredAmount: 0n,
    })).rejects.toThrow(/greater than zero/);
    await expect(verify({
      signedHex: fixture.signedHex,
      previous: fixture.previous,
    })).rejects.toThrow(/creates BCH value/);
  });

  it("executes BCH 2023 scripts after prevouts and PUSD intent pass", async () => {
    const fixture = signedSpend();
    await expect(verify({
      signedHex: fixture.signedHex,
      previous: fixture.previous,
    })).rejects.toThrow(/failed virtual-machine validation/);
  });
});
