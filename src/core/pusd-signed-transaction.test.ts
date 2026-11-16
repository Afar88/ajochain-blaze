import { describe, expect, it, vi } from "vitest";
import { binToHex, encodeTransactionBCH, hashTransaction, hexToBin } from "@bitauth/libauth";
import { PUSD_ASSET } from "./assets";
import { assertRequiredPusdSighash, verifySignedPusdTransaction } from "./pusd-signed-transaction";

const walletScript = "76a914" + "11".repeat(20) + "88ac";
const recipientScript = "76a914" + "22".repeat(20) + "88ac";
const attackerScript = "76a914" + "33".repeat(20) + "88ac";
const reverseHex = (value: string) => value.match(/../g)!.reverse().join("");

const dummyP2pkhUnlocking = () => {
  const signature = new Uint8Array([0x30, 0x01, 0x01, 0x61]);
  const publicKey = new Uint8Array(33).fill(2);
  return hexToBin([
    signature.length.toString(16).padStart(2, "0"),
    binToHex(signature),
    publicKey.length.toString(16).padStart(2, "0"),
    binToHex(publicKey),
  ].join(""));
};

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

function signedSpend(outputScript = recipientScript, outputAmount = 90n, outputSatoshis = 1000n, previousScript = walletScript) {
  const previous = previousOutput(previousScript);
  const signed = encodeTransactionBCH({
    version: 2,
    locktime: 0,
    inputs: [{
      outpointTransactionHash: hexToBin(reverseHex(previous.txid)),
      outpointIndex: 0,
      sequenceNumber: 0xffffffff,
      unlockingBytecode: dummyP2pkhUnlocking(),
    }],
    outputs: [{
      valueSatoshis: BigInt(outputSatoshis),
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
  it("requires the WizardConnect 0x61 sighash on wallet P2PKH inputs", () => {
    const signature = new Uint8Array([0x30, 0x01, 0x01, 0x61]);
    const publicKey = new Uint8Array(33).fill(2);
    const script = hexToBin(signature.length.toString(16).padStart(2, "0") + binToHex(signature) +
      publicKey.length.toString(16).padStart(2, "0") + binToHex(publicKey));
    expect(() => assertRequiredPusdSighash(script)).not.toThrow();
    const weakSignature = new Uint8Array([0x30, 0x01, 0x01, 0x41]);
    const weakScript = hexToBin(weakSignature.length.toString(16).padStart(2, "0") + binToHex(weakSignature) +
      publicKey.length.toString(16).padStart(2, "0") + binToHex(publicKey));
    expect(() => assertRequiredPusdSighash(weakScript)).toThrow(/0x61/);
    expect(() => assertRequiredPusdSighash(hexToBin("51"))).toThrow(/exactly a signature and public-key/);
  });

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

  it("rejects PUSD token outputs below the serialized CashTokens dust threshold", async () => {
    const fixture = signedSpend(recipientScript, 90n, 500n);
    await expect(verify({
      signedHex: fixture.signedHex,
      previous: fixture.previous,
    })).rejects.toThrow(/carrier is below the serialized-output dust threshold/);
  });

  it("rejects BCH-only change outputs below the serialized-output dust threshold", async () => {
    const previous = previousOutput();
    const signed = encodeTransactionBCH({
      version: 2,
      locktime: 0,
      inputs: [{
        outpointTransactionHash: hexToBin(reverseHex(previous.txid)),
        outpointIndex: 0,
        sequenceNumber: 0xffffffff,
        unlockingBytecode: dummyP2pkhUnlocking(),
      }],
      outputs: [
        {
          valueSatoshis: 1000n,
          lockingBytecode: hexToBin(recipientScript),
          token: { category: hexToBin(PUSD_ASSET.categoryId), amount: 100n },
        },
        { valueSatoshis: 500n, lockingBytecode: hexToBin(walletScript) },
      ],
    });
    await expect(verify({
      signedHex: binToHex(signed),
      previous,
      requiredAmount: 100n,
    })).rejects.toThrow(/BCH change output 1 is below the serialized-output dust threshold/);
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

  it("executes the active BCH 2026 VM after prevouts and PUSD intent pass", async () => {
    const loopScript = "6576667551";
    const fixture = signedSpend(recipientScript, 90n, 1000n, loopScript);
    await expect(verify({
      signedHex: fixture.signedHex,
      previous: fixture.previous,
      walletScripts: [loopScript, walletScript],
    })).rejects.toThrow(/failed virtual-machine validation/);
  });

  it("accepts a wallet-controlled PUSD input whose prevout uses BCH 2026 bounded loops", async () => {
    const loopScript = "6576667551"; // OP_BEGIN OP_DUP OP_UNTIL OP_DROP OP_1
    const previousBytes = encodeTransactionBCH({
      version: 2,
      locktime: 0,
      inputs: [{
        outpointTransactionHash: new Uint8Array(32),
        outpointIndex: 0xffffffff,
        sequenceNumber: 0xffffffff,
        unlockingBytecode: hexToBin("51"),
      }],
      outputs: [{
        valueSatoshis: 10_000n,
        lockingBytecode: hexToBin(loopScript),
        token: { category: hexToBin(PUSD_ASSET.categoryId), amount: 100n },
      }],
    });
    const previousHex = binToHex(previousBytes);
    const previousTxid = hashTransaction(previousBytes);
    const spendingBytes = encodeTransactionBCH({
      version: 2,
      locktime: 0,
      inputs: [{
        outpointTransactionHash: hexToBin(reverseHex(previousTxid)),
        outpointIndex: 0,
        sequenceNumber: 0xffffffff,
        unlockingBytecode: hexToBin("51"),
      }],
      outputs: [{
        valueSatoshis: 9_000n,
        lockingBytecode: hexToBin(recipientScript),
        token: { category: hexToBin(PUSD_ASSET.categoryId), amount: 100n },
      }],
    });

    await expect(verifySignedPusdTransaction({
      signedTransactionHex: binToHex(spendingBytes),
      rawPreviousTransactions: { [previousTxid]: previousHex },
      walletLockingBytecodes: [loopScript, walletScript],
      recipientLockingBytecode: recipientScript,
      changeLockingBytecode: walletScript,
      requiredPusdAmount: 100n,
      maxFeeSatoshis: 1_000n,
      unspentEvidence: { isUnspent: async () => true },
    })).resolves.toMatchObject({
      inputPusdAmount: 100n,
      recipientPusdAmount: 100n,
      feeSatoshis: 1_000n,
    });
  });
});
