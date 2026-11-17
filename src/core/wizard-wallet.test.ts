import { describe, expect, it } from "vitest";
import {
  wizardRelayStatusMessage,
  buildWizardSignRequest,
  assertP2pkhWalletInputCoverage,
  assertRequiredContractWalletSighash,
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
    // Minimal canonical DER ECDSA structure plus BCH's trailing sighash byte.
    return Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, sighash]);
  }

  function covenantUnlockingScript(signature: Uint8Array): Uint8Array {
    return Uint8Array.from([...push(publicKey), ...push(signature), ...push(redeemScript)]);
  }

  it("accepts a contract signature using WizardConnect's required 0x61 flag", () => {
    expect(() => assertRequiredContractWalletSighash(covenantUnlockingScript(derSignature(0x61))))
      .not.toThrow();
  });

  it("rejects a contract signature that omits SIGHASH_UTXOS", () => {
    expect(() => assertRequiredContractWalletSighash(covenantUnlockingScript(derSignature(0x41))))
      .toThrow(/0x61/);
  });

  it("does not mistake bytes inside the redeem-script push for a signature argument", () => {
    const unlocking = Uint8Array.from([...push(publicKey), ...push(derSignature(0x41))]);
    expect(() => assertRequiredContractWalletSighash(unlocking))
      .toThrow(/missing its transaction signature argument/);
  });

  it("accepts Selene's 64-byte Schnorr signature with the required 0x61 sighash", () => {
    const schnorr = Uint8Array.from([...new Uint8Array(64).fill(0x55), 0x61]);
    expect(() => assertRequiredContractWalletSighash(covenantUnlockingScript(schnorr)))
      .not.toThrow();
  });

  it("rejects a Schnorr covenant signature with a weaker sighash flag", () => {
    const schnorr = Uint8Array.from([...new Uint8Array(64).fill(0x55), 0x41]);
    expect(() => assertRequiredContractWalletSighash(covenantUnlockingScript(schnorr)))
      .toThrow(/0x61/);
  });

  it("rejects malformed DER-looking ABI pushes rather than treating them as signatures", () => {
    const malformed = Uint8Array.from([0x30, 0x06, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01, 0x61]);
    expect(() => assertRequiredContractWalletSighash(covenantUnlockingScript(malformed)))
      .toThrow(/missing its transaction signature argument/);
  });
});


describe("WizardConnect relay recovery messaging", () => {
  it("shows temporary subscription closures as recoverable reconnects", () => {
    expect(wizardRelayStatusMessage("reconnecting", "Subscription closed"))
      .toContain("AjoChain is retrying automatically");
  });

  it("shows mobile/background relay interruptions without discarding the session", () => {
    expect(wizardRelayStatusMessage("disconnected"))
      .toContain("return after Selene");
  });

  it("clears the interruption message after the relay reconnects", () => {
    expect(wizardRelayStatusMessage("connected")).toBeNull();
  });
});


describe("WizardConnect sign-request serialization", () => {
  it("encodes transaction bytes as raw hex and removes native BigInts before relay JSON", () => {
    const transaction = {
      version: 2,
      locktime: 0,
      inputs: [{
        outpointTransactionHash: new Uint8Array(32).fill(7),
        outpointIndex: 1,
        unlockingBytecode: new Uint8Array(),
        sequenceNumber: 0xffffffff,
      }],
      outputs: [{
        valueSatoshis: 1_000n,
        lockingBytecode: Uint8Array.from([0x51]),
      }],
    };
    const sourceOutputs = [{
      valueSatoshis: 2_000n,
      lockingBytecode: Uint8Array.from([0x76, 0xa9, 0x14, ...new Uint8Array(20), 0x88, 0xac]),
    }];

    const request = buildWizardSignRequest(
      { transaction, sourceOutputs },
      [0],
      3,
      "Create Ajo circle",
      123,
    );

    expect(typeof request.transaction.transaction).toBe("string");
    expect(request.transaction.transaction).toMatch(/^[0-9a-f]+$/i);
    expect(request.transaction.sourceOutputs).toHaveLength(1);
    expect(typeof request.transaction.sourceOutputs[0].valueSatoshis).toBe("string");
    expect(() => JSON.stringify(request)).not.toThrow();
  });

  it("preserves CashScript covenant metadata so Selene can sign cancel inputs", () => {
    const transaction = {
      version: 2,
      locktime: 0,
      inputs: [{
        outpointTransactionHash: new Uint8Array(32).fill(9),
        outpointIndex: 0,
        unlockingBytecode: Uint8Array.from([0x01, 0x00]),
        sequenceNumber: 0xffffffff,
      }],
      outputs: [{ valueSatoshis: 1_000n, lockingBytecode: Uint8Array.from([0x51]) }],
    };
    const sourceOutputs = [{
      valueSatoshis: 1_000n,
      lockingBytecode: Uint8Array.from([0xaa, 0x20, ...new Uint8Array(32).fill(1), 0x87]),
      unlockingBytecode: Uint8Array.from([0x01, 0x00]),
      contract: {
        abiFunction: {
          name: "cancel",
          inputs: [
            { name: "initiatorPk", type: "pubkey" },
            { name: "initiatorSig", type: "sig" },
          ],
        },
        redeemScript: Uint8Array.from([0x51, 0x52]),
        artifact: { contractName: "AjoCircleV3AutoReserve" },
      },
    }];

    const request = buildWizardSignRequest(
      { transaction, sourceOutputs },
      [0],
      2,
      "Cancel circle and refund members",
      456,
    );
    const serializedContract = request.transaction.sourceOutputs[0].contract;
    expect(serializedContract.abiFunction.name).toBe("cancel");
    expect(serializedContract.abiFunction.inputs[1].type).toBe("sig");
    expect(serializedContract.redeemScript).toBe("5152");
    expect(serializedContract.artifact.contractName).toBe("AjoCircleV3AutoReserve");
    expect(() => JSON.stringify(request)).not.toThrow();
  });

  it("rejects incomplete transactions before a wallet prompt is attempted", () => {
    expect(() => buildWizardSignRequest(
      { transaction: { inputs: [], outputs: [] }, sourceOutputs: [] },
      [0],
      0,
      "Create Ajo circle",
      123,
    )).toThrow(/Invalid wallet signing input index/);
  });
});
