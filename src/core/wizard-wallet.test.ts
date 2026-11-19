import { describe, expect, it } from "vitest";
import { decodeCashAddress } from "@bitauth/libauth";
import {
  wizardRelayStatusMessage,
  isCurrentReceiveAddressConfirmed,
  buildWizardSignRequest,
  assertP2pkhWalletInputCoverage,
  assertRequiredContractWalletSighash,
  assertRequiredWalletSighash,
  readPushOnlyUnlockingScript,
  deriveWizardConnectReceiveAddress,
  findWizardConnectReceiveIndex,
  wizardConnectReceiveAddressIndexes,
  WIZARDCONNECT_RECEIVE_CHILD_INDEX,
} from "./wizard-wallet";

function push(value: Uint8Array): Uint8Array {
  if (value.length <= 75) return Uint8Array.from([value.length, ...value]);
  if (value.length <= 0xff) return Uint8Array.from([0x4c, value.length, ...value]);
  throw new Error("Test helper supports short pushes only.");
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
}

describe("WizardConnect live receive-address derivation", () => {
  const publicKey = Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x11)]);

  it("derives the receive child (path index 0) from the active hdwalletv1 xpub", () => {
    const calls: Array<[number, bigint]> = [];
    const address = deriveWizardConnectReceiveAddress(
      "hdwalletv1",
      (childIndex, addressIndex) => {
        calls.push([childIndex, addressIndex]);
        return publicKey;
      },
      "chipnet",
      7,
    );
    expect(WIZARDCONNECT_RECEIVE_CHILD_INDEX).toBe(0);
    expect(calls).toEqual([[0, 7n]]);
    expect(address).toMatch(/^bchtest:/);
  });

  it("uses the same public key but the correct network-specific CashAddress prefix", () => {
    const getPubkey = () => publicKey;
    const chipnet = deriveWizardConnectReceiveAddress("hdwalletv1", getPubkey, "chipnet", 0);
    const mainnet = deriveWizardConnectReceiveAddress("hdwalletv1", getPubkey, "mainnet", 0);
    expect(chipnet).toMatch(/^bchtest:/);
    expect(mainnet).toMatch(/^bitcoincash:/);
    const chipnetDecoded = decodeCashAddress(chipnet!);
    const mainnetDecoded = decodeCashAddress(mainnet!);
    expect(typeof chipnetDecoded).not.toBe("string");
    expect(typeof mainnetDecoded).not.toBe("string");
    if (typeof chipnetDecoded === "string" || typeof mainnetDecoded === "string") return;
    expect(Array.from(chipnetDecoded.payload)).toEqual(Array.from(mainnetDecoded.payload));
  });

  it("does not return an address from another protocol or a missing session xpub", () => {
    const getPubkey = () => publicKey;
    expect(deriveWizardConnectReceiveAddress("walletconnect", getPubkey, "chipnet", 0)).toBeNull();
    expect(deriveWizardConnectReceiveAddress(null, getPubkey, "chipnet", 0)).toBeNull();
    expect(deriveWizardConnectReceiveAddress("hdwalletv1", null, "chipnet", 0)).toBeNull();
  });

  it("rejects invalid child keys and invalid address indexes", () => {
    expect(deriveWizardConnectReceiveAddress("hdwalletv1", () => new Uint8Array(32), "chipnet", 0)).toBeNull();
    expect(deriveWizardConnectReceiveAddress("hdwalletv1", () => Uint8Array.from([0x04, ...new Uint8Array(32)]), "chipnet", 0)).toBeNull();
    expect(deriveWizardConnectReceiveAddress("hdwalletv1", () => publicKey, "chipnet", -1)).toBeNull();
  });
});

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

  it("accepts OP_0 and small-integer opcodes as push-only values", () => {
    expect(readPushOnlyUnlockingScript(Uint8Array.from([0x00, 0x4f, 0x51, 0x60])))
      .toEqual([
        new Uint8Array(),
        Uint8Array.from([0x81]),
        Uint8Array.from([0x01]),
        Uint8Array.from([0x10]),
      ]);
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

describe("WizardConnect current receive-address confirmation", () => {
  it("confirms only the exact address that was explicitly matched", () => {
    expect(isCurrentReceiveAddressConfirmed("bitcoincash:abc", "bitcoincash:abc")).toBe(true);
    expect(isCurrentReceiveAddressConfirmed("bitcoincash:abc", "bitcoincash:def")).toBe(false);
  });

  it("treats CashAddress letter casing as equivalent", () => {
    expect(isCurrentReceiveAddressConfirmed("BITCOINCASH:ABC", "bitcoincash:abc")).toBe(true);
  });

  it("does not treat an unconfirmed or unavailable address as confirmed", () => {
    expect(isCurrentReceiveAddressConfirmed("bitcoincash:abc", null)).toBe(false);
    expect(isCurrentReceiveAddressConfirmed(null, "bitcoincash:abc")).toBe(false);
  });
});


describe("WizardConnect wallet address scanning", () => {
  it("covers every receive index up to the selected one, without gaps", () => {
    expect(wizardConnectReceiveAddressIndexes(50, 250)).toEqual(
      Array.from({ length: 251 }, (_, index) => index),
    );
  });

  it("does not duplicate the selected index when it is already in the scan window", () => {
    expect(wizardConnectReceiveAddressIndexes(50, 4)).toEqual(
      Array.from({ length: 51 }, (_, index) => index),
    );
  });

  it("rejects unreasonable receive-index ranges", () => {
    expect(() => wizardConnectReceiveAddressIndexes(10001, 4)).toThrow(/outside the supported range/);
    expect(() => wizardConnectReceiveAddressIndexes(50, -1)).toThrow(/outside the supported range/);
  });
});


describe("WizardConnect Selene address matching", () => {
  const keyFor = (index: bigint) => Uint8Array.from([0x02, ...new Uint8Array(32).fill(Number(index) + 1)]);
  const getPubkey = (_child: number, index: bigint) => keyFor(index);
  const chipnetAt = (index: number) => deriveWizardConnectReceiveAddress("hdwalletv1", getPubkey, "chipnet", index)!;
  const mainnetAt = (index: number) => deriveWizardConnectReceiveAddress("hdwalletv1", getPubkey, "mainnet", index)!;

  it("finds a rotated receive address", () => {
    expect(findWizardConnectReceiveIndex(chipnetAt(4), "hdwalletv1", getPubkey, "chipnet")).toBe(4);
  });

  it("accepts an address pasted without its prefix or in upper case", () => {
    expect(findWizardConnectReceiveIndex(chipnetAt(3).split(":")[1], "hdwalletv1", getPubkey, "chipnet")).toBe(3);
    expect(findWizardConnectReceiveIndex(" " + chipnetAt(2).toUpperCase() + " ", "hdwalletv1", getPubkey, "chipnet")).toBe(2);
  });

  it("explains a network mismatch instead of reporting no match", () => {
    expect(() => findWizardConnectReceiveIndex(chipnetAt(1), "hdwalletv1", getPubkey, "mainnet"))
      .toThrow(/Chipnet address, but the site is set to Mainnet/);
    expect(() => findWizardConnectReceiveIndex(mainnetAt(1), "hdwalletv1", getPubkey, "chipnet"))
      .toThrow(/Mainnet address, but the site is set to Chipnet/);
  });

  it("rejects invalid input and returns null for another wallet", () => {
    expect(() => findWizardConnectReceiveIndex("bchtest:notanaddress", "hdwalletv1", getPubkey, "chipnet"))
      .toThrow(/not a valid Bitcoin Cash address/);
    const otherWallet = deriveWizardConnectReceiveAddress("hdwalletv1", () => Uint8Array.from([0x03, ...new Uint8Array(32).fill(0xee)]), "chipnet", 0)!;
    expect(findWizardConnectReceiveIndex(otherWallet, "hdwalletv1", getPubkey, "chipnet", 10)).toBeNull();
    expect(findWizardConnectReceiveIndex("", "hdwalletv1", getPubkey, "chipnet")).toBeNull();
  });
});
