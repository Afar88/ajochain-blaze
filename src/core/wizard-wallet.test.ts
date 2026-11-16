import { describe, expect, it } from "vitest";
import {
  assertRequiredWalletSighash,
  readPushOnlyUnlockingScript,
} from "./wizard-wallet";

function push(value: Uint8Array): Uint8Array {
  if (value.length <= 75) return Uint8Array.from([value.length, ...value]);
  if (value.length <= 0xff) return Uint8Array.from([0x4c, value.length, ...value]);
  throw new Error("Test helper supports short pushes only.");
}

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
