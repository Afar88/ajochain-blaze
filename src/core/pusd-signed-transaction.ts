import {
  binToHex,
  createVirtualMachineBch2026,
  decodeTransactionBCH,
  getDustThreshold,
  hashTransaction,
  hexToBin,
} from "@bitauth/libauth";
import { PUSD_ASSET, isPusdCategoryId } from "./assets";

export interface PusdInputOutpoint {
  txid: string;
  vout: number;
}

export interface PusdSignedTransactionUnspentEvidence {
  /** Re-query chain state immediately before validation/broadcast. */
  isUnspent(outpoint: PusdInputOutpoint): Promise<boolean>;
}

export interface VerifySignedPusdTransactionOptions {
  signedTransactionHex: string;
  /** Raw previous transactions keyed by displayed (big-endian) txid. */
  rawPreviousTransactions: Readonly<Record<string, string>>;
  /** Scripts derived locally from the connected wallet's receive/change paths. */
  walletLockingBytecodes: readonly string[];
  recipientLockingBytecode: string;
  changeLockingBytecode: string;
  requiredPusdAmount: bigint;
  maxFeeSatoshis: bigint;
  unspentEvidence: PusdSignedTransactionUnspentEvidence;
}

export interface VerifiedPusdTransaction {
  txid: string;
  feeSatoshis: bigint;
  inputPusdAmount: bigint;
  recipientPusdAmount: bigint;
  changePusdAmount: bigint;
  inputCount: number;
  outputCount: number;
}

/**
 * Read a push-only P2PKH unlocking script. This intentionally rejects script
 * execution opcodes in a wallet-owned input's unlocking script.
 */
export function readPusdUnlockingPushes(script: Uint8Array): Uint8Array[] {
  const pushes: Uint8Array[] = [];
  let offset = 0;
  while (offset < script.length) {
    const opcode = script[offset++];
    let length: number;
    if (opcode <= 75) {
      length = opcode;
    } else if (opcode === 0x4c) {
      if (offset + 1 > script.length) throw new Error("Malformed wallet PUSHDATA1 unlocking script.");
      length = script[offset++];
    } else if (opcode === 0x4d) {
      if (offset + 2 > script.length) throw new Error("Malformed wallet PUSHDATA2 unlocking script.");
      length = script[offset] | (script[offset + 1] << 8);
      offset += 2;
    } else if (opcode === 0x4e) {
      if (offset + 4 > script.length) throw new Error("Malformed wallet PUSHDATA4 unlocking script.");
      length = new DataView(script.buffer, script.byteOffset + offset, 4).getUint32(0, true);
      offset += 4;
    } else {
      throw new Error("Wallet-owned P2PKH input contains a non-push unlocking opcode.");
    }
    if (offset + length > script.length) throw new Error("Wallet unlocking script push exceeds its available bytes.");
    pushes.push(script.slice(offset, offset + length));
    offset += length;
  }
  return pushes;
}

/** Require WizardConnect's SIGHASH_ALL | FORKID | UTXOS (0x61) wallet signature. */
export function assertRequiredPusdSighash(script: Uint8Array): void {
  const pushes = readPusdUnlockingPushes(script);
  if (pushes.length !== 2) {
    throw new Error("Wallet-owned P2PKH input must contain exactly a signature and public-key push.");
  }
  const signature = pushes[0];
  const publicKey = pushes[1];
  if (signature.length < 2 || signature[signature.length - 1] !== 0x61) {
    throw new Error("Wallet signature must use SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_UTXOS (0x61).");
  }
  if (publicKey.length !== 33 && publicKey.length !== 65) {
    throw new Error("Wallet-owned input did not contain a valid compressed or uncompressed public key.");
  }
}

const isHex = (value: string) => /^(?:[0-9a-f]{2})+$/i.test(value);

/**
 * Validate the exact signed BCH transaction against raw previous transactions.
 *
 * This executes the BCH 2026 authentication VM (including CashTokens consensus
 * checks) after independently resolving each input. It also enforces a narrow
 * PUSD transfer policy: only the requested recipient and this wallet's change
 * script may receive PUSD, no foreign token category/NFT is permitted, and BCH
 * change may only return to a wallet-derived script.
 *
 * The VM is stateless. The supplied unspent-state adapter must independently
 * query live chain state; this function fails closed if any check is unavailable.
 */
export async function verifySignedPusdTransaction(
  options: VerifySignedPusdTransactionOptions,
): Promise<VerifiedPusdTransaction> {
  const {
    signedTransactionHex,
    rawPreviousTransactions,
    walletLockingBytecodes,
    recipientLockingBytecode,
    changeLockingBytecode,
    requiredPusdAmount,
    maxFeeSatoshis,
    unspentEvidence,
  } = options;

  if (!isHex(signedTransactionHex)) {
    throw new Error("Signed transaction must be complete hexadecimal bytes.");
  }
  if (requiredPusdAmount <= 0n) {
    throw new Error("Requested PUSD amount must be greater than zero.");
  }
  if (maxFeeSatoshis < 0n) {
    throw new Error("Maximum transaction fee cannot be negative.");
  }
  if (!isHex(recipientLockingBytecode) || !isHex(changeLockingBytecode)) {
    throw new Error("Recipient and change locking bytecodes must be non-empty hexadecimal scripts.");
  }
  const walletScripts = new Set(
    walletLockingBytecodes.map((script) => script.toLowerCase()).filter(isHex),
  );
  if (walletScripts.size === 0 || !walletScripts.has(changeLockingBytecode.toLowerCase())) {
    throw new Error("Wallet-derived locking scripts are missing or do not include the change script.");
  }

  const transactionBytes = hexToBin(signedTransactionHex);
  const transaction = decodeTransactionBCH(transactionBytes);
  if (typeof transaction === "string") {
    throw new Error("Signed transaction failed CashTokens-aware BCH decoding: " + transaction);
  }
  if (transaction.inputs.length === 0 || transaction.outputs.length === 0) {
    throw new Error("Signed transaction must contain at least one input and one output.");
  }

  const sourceOutputs: typeof transaction.outputs = [];
  const seenOutpoints = new Set<string>();
  let inputSatoshis = 0n;
  let inputPusdAmount = 0n;

  for (const [inputIndex, input] of transaction.inputs.entries()) {
    // libauth decodes outpoint hashes in display (RPC) order, the same order API txids use.
    const outpointBytes = binToHex(input.outpointTransactionHash).toLowerCase();
    const txid = outpointBytes;
    const outpoint = { txid, vout: input.outpointIndex };
    if (!/^[0-9a-f]{64}$/.test(txid) ||
        !Number.isSafeInteger(outpoint.vout) || outpoint.vout < 0) {
      throw new Error("Signed transaction input " + inputIndex + " has an invalid outpoint.");
    }
    const outpointKey = txid + ":" + outpoint.vout;
    if (seenOutpoints.has(outpointKey)) {
      throw new Error("Signed transaction contains a duplicate input outpoint.");
    }
    seenOutpoints.add(outpointKey);

    const rawHex = rawPreviousTransactions[txid] ??
      rawPreviousTransactions[outpointBytes] ??
      rawPreviousTransactions[txid.toUpperCase()] ??
      rawPreviousTransactions[outpointBytes.toUpperCase()];
    if (!rawHex || !isHex(rawHex)) {
      throw new Error("Raw previous transaction is missing or malformed for input " + inputIndex + ".");
    }
    const previousBytes = hexToBin(rawHex);
    const previousTransaction = decodeTransactionBCH(previousBytes);
    if (typeof previousTransaction === "string") {
      throw new Error("Previous transaction for input " + inputIndex + " failed BCH/CashTokens decoding: " + previousTransaction);
    }

    const actualPreviousTxid = hashTransaction(previousBytes).toLowerCase();
    if (actualPreviousTxid !== txid) {
      throw new Error("Previous transaction hash does not match input " + inputIndex + ".");
    }
    const sourceOutput = previousTransaction.outputs[outpoint.vout];
    if (!sourceOutput) {
      throw new Error("Previous transaction output index does not exist for input " + inputIndex + ".");
    }
    const sourceScript = binToHex(sourceOutput.lockingBytecode).toLowerCase();
    if (!walletScripts.has(sourceScript)) {
      throw new Error("Input " + inputIndex + " is not locked to a locally derived wallet script.");
    }
    if (/^76a914[0-9a-f]{40}88ac$/.test(sourceScript)) {
      assertRequiredPusdSighash(input.unlockingBytecode);
    }

    if (sourceOutput.token) {
      const category = binToHex(sourceOutput.token.category).toLowerCase();
      if (!isPusdCategoryId(category) || category !== PUSD_ASSET.categoryId) {
        throw new Error("Input " + inputIndex + " contains an unsupported CashToken category.");
      }
      if (sourceOutput.token.nft) {
        throw new Error("NFT-bearing inputs are not supported by this fungible PUSD transfer.");
      }
      if (sourceOutput.token.amount <= 0n) {
        throw new Error("Input " + inputIndex + " has an invalid PUSD amount.");
      }
      inputPusdAmount += sourceOutput.token.amount;
    }

    if (sourceOutput.valueSatoshis <= 0n) {
      throw new Error("Input " + inputIndex + " has no BCH carrier value.");
    }
    inputSatoshis += sourceOutput.valueSatoshis;
    sourceOutputs.push(sourceOutput);

    // This is a separate stateful check. A raw previous transaction does not
    // prove that the referenced output remains unspent.
    const unspent = await unspentEvidence.isUnspent(outpoint);
    if (unspent !== true) {
      throw new Error("Input " + inputIndex + " is spent or its unspent state is unavailable.");
    }
  }

  if (inputPusdAmount < requiredPusdAmount) {
    throw new Error("Verified PUSD inputs do not cover the requested amount.");
  }

  const expectedChangeAmount = inputPusdAmount - requiredPusdAmount;
  let recipientPusdAmount = 0n;
  let changePusdAmount = 0n;
  let recipientPusdOutputs = 0;
  let changePusdOutputs = 0;
  let outputSatoshis = 0n;

  for (const [outputIndex, output] of transaction.outputs.entries()) {
    outputSatoshis += output.valueSatoshis;
    const script = binToHex(output.lockingBytecode).toLowerCase();

    if (output.token) {
      const category = binToHex(output.token.category).toLowerCase();
      if (!isPusdCategoryId(category) || category !== PUSD_ASSET.categoryId) {
        throw new Error("Output " + outputIndex + " creates or transfers an unsupported CashToken category.");
      }
      if (output.token.nft) {
        throw new Error("Output " + outputIndex + " contains an unsupported NFT.");
      }
      if (output.token.amount <= 0n) {
        throw new Error("Output " + outputIndex + " has an invalid PUSD amount.");
      }
      const minimumCarrier = getDustThreshold(output);
      if (output.valueSatoshis < minimumCarrier) {
        throw new Error("PUSD token output " + outputIndex + " carrier is below the serialized-output dust threshold of " + minimumCarrier + " sats.");
      }

      if (script === recipientLockingBytecode.toLowerCase()) {
        recipientPusdAmount += output.token.amount;
        recipientPusdOutputs += 1;
      } else if (script === changeLockingBytecode.toLowerCase()) {
        changePusdAmount += output.token.amount;
        changePusdOutputs += 1;
      } else {
        throw new Error("PUSD output " + outputIndex + " is not directed to the approved recipient or wallet change script.");
      }
    } else {
      if (!walletScripts.has(script)) {
        throw new Error("BCH-only output " + outputIndex + " is not directed to a wallet-derived change script.");
      }
      const minimumCarrier = getDustThreshold(output);
      if (output.valueSatoshis < minimumCarrier) {
        throw new Error("BCH change output " + outputIndex + " is below the serialized-output dust threshold of " + minimumCarrier + " sats.");
      }
    }
  }

  if (recipientPusdAmount !== requiredPusdAmount || recipientPusdOutputs !== 1) {
    throw new Error("Signed transaction does not pay the exact requested PUSD amount to the approved recipient.");
  }
  if (changePusdAmount !== expectedChangeAmount ||
      changePusdOutputs !== (expectedChangeAmount > 0n ? 1 : 0)) {
    throw new Error("Signed transaction does not return the exact PUSD remainder to the wallet change script.");
  }
  if (recipientPusdOutputs + changePusdOutputs !==
      transaction.outputs.filter((output) => output.token !== undefined).length) {
    throw new Error("Signed transaction contains an unaccounted token output.");
  }

  const feeSatoshis = inputSatoshis - outputSatoshis;
  if (feeSatoshis < 0n) {
    throw new Error("Signed transaction creates BCH value.");
  }
  if (feeSatoshis > maxFeeSatoshis) {
    throw new Error("Signed transaction fee exceeds the approved maximum.");
  }

  // Libauth's BCH 2023 VM performs transaction-level CashTokens conservation,
  // consensus checks and every input's unlocking/locking script evaluation.
  const vmResult = createVirtualMachineBch2026().verify({
    transaction,
    sourceOutputs,
  });
  if (vmResult !== true) {
    throw new Error("Signed BCH/CashTokens transaction failed virtual-machine validation: " + vmResult);
  }

  return {
    txid: hashTransaction(transactionBytes),
    feeSatoshis,
    inputPusdAmount,
    recipientPusdAmount,
    changePusdAmount,
    inputCount: transaction.inputs.length,
    outputCount: transaction.outputs.length,
  };
}
