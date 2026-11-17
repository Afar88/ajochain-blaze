import { describe, expect, it } from "vitest";
import {
  assertP2pkhWalletInputCoverage,
  assertRequiredWalletSighash,
  readPushOnlyUnlockingScript,
} from "./wizard-wallet";

function push(value: Uint8Array): Uint8Array {
  if (value.length <= 75) return Uint8Array.from([value.length, ...value]);
  if (value.length <= 0xff) return Uint8Array.from([0x4c, value.length, ...value]);
  throw new Error("Test helper supports short pushes only.");
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
}

describe("WizardConnect wallet-input coverage", () => {
  const p2pkh = hexToBytes("76a914" + "11".repeat(20) + "88ac");
  const p2sh32 = hexToBytes("aa20" + "22".repeat(32) + "87");

  it("requires every P2PKH funding input to be included in the wallet signing request", () => {
    expect(() => assertP2pkhWalletInputCoverage(
      [{ lockingBytecode: p2pkh }, { lockingBytecode: p2sh32 }],
      [0],
    )).not.toThrow();
    expect(() => assertP2pkhWalletInputCoverage(
      [{ lockingBytecode: p2pkh }, { lockingBytecode: p2pkh }],
      [0],
    )).toThrow(/P2PKH funding input 1 is missing/);
  });

  it("does not classify covenant P2SH inputs as wallet P2PKH funding inputs", () => {
    expect(() => assertP2pkhWalletInputCoverage(
      [{ lockingBytecode: p2sh32 }],
      [],
    )).not.toThrow();
  });
});

describe("WizardConnect signed input inspection", () => {
  const signature = Uint8Array.from([0x30, 0x01, 0x61]);
  const publicKey = new Uint8Array(33).fill(2);
  const validScript = Uint8Array.from([...push(signature), ...push(publicKey)]);

  it("parses P2PKH signature and public-key pushes", () => {
    expect(readPushOnlyUnlockingScript(validScript)).toHaveLength(2);
    expect(() => assertRequiredWalletSighash(validScript)).not.toThrow();
  });

  it("rejects a weaker signature hash flag", () => {
    const weakSignature = Uint8Array.from([0x30, 0x01, 0x41]);
    const weakScript = Uint8Array.from([...push(weakSignature), ...push(publicKey)]);
    expect(() => assertRequiredWalletSighash(weakScript)).toThrow(/0x61/);
  });

  it("rejects non-push unlocking opcodes", () => {
    expect(() => readPushOnlyUnlockingScript(Uint8Array.from([0xac]))).toThrow(/non-push opcode/);
  });

  it("rejects malformed push lengths and unexpected push counts", () => {
    expect(() => readPushOnlyUnlockingScript(Uint8Array.from([0x4c]))).toThrow(/PUSHDATA1/);
    expect(() => assertRequiredWalletSighash(push(signature))).toThrow(/exactly a signature and public-key/);
  });
});

describe("WizardConnect covenant-input sighash inspection", () => {
  const publicKey = new Uint8Array(33).fill(2);
  const redeemScript = Uint8Array.from([0x51]);
  function derSignature(sighash: number): Uint8Array {
    return Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, sighash]);
  }
  function covenantUnlockingScript(signature: Uint8Array): Uint8Array {
    return Uint8Array.from([...push(publicKey), ...push(signature), ...push(redeemScript)]);
  }
  it("accepts a covenant signature using WizardConnect's required 0x61 flag", () => {
    expect(() => assertRequiredContractWalletSighash(covenantUnlockingScript(derSignature(0x61)))).not.toThrow();
  });
  it("rejects a covenant signature that omits SIGHASH_UTXOS", () => {
    expect(() => assertRequiredContractWalletSighash(covenantUnlockingScript(derSignature(0x41)))).toThrow(/0x61/);
  });
  it("does not mistake bytes inside the redeem-script push for a signature argument", () => {
    const unlocking = Uint8Array.from([...push(publicKey), ...push(derSignature(0x41))]);
    expect(() => assertRequiredContractWalletSighash(unlocking)).toThrow(/missing its transaction signature argument/);
  });
});
