import {
  encodeTransactionBCH,
  getDustThreshold,
  hexToBin,
} from "@bitauth/libauth";
import { CASH_TOKEN_MAX_AMOUNT, PUSD_ASSET } from "./assets";
import type { AuthenticatedPusdUtxo } from "./pusd-utxo";

const MAX_TRANSACTION_INPUTS = 50;
const MAX_UNLOCKING_BYTECODE_LENGTH = 108;

export interface PusdTransferPlanOptions {
  authenticatedUtxos: readonly AuthenticatedPusdUtxo[];
  requiredPusdAmount: bigint;
  recipientLockingBytecode: string;
  changeLockingBytecode: string;
  feeRateSatoshisPerKb: bigint;
  maxFeeSatoshis: bigint;
}

export interface PusdTransferPlan {
  transaction: {
    version: number;
    locktime: number;
    inputs: Array<{
      outpointTransactionHash: Uint8Array;
      outpointIndex: number;
      sequenceNumber: number;
      unlockingBytecode: Uint8Array;
    }>;
    outputs: Array<{
      valueSatoshis: bigint;
      lockingBytecode: Uint8Array;
      token?: { category: Uint8Array; amount: bigint };
    }>;
  };
  sourceOutputs: Array<{
    valueSatoshis: bigint;
    lockingBytecode: Uint8Array;
    token: { category: Uint8Array; amount: bigint };
  }>;
  walletInputs: number[];
  selectedUtxos: AuthenticatedPusdUtxo[];
  recipientPusdAmount: bigint;
  changePusdAmount: bigint;
  recipientCarrierSatoshis: bigint;
  changeCarrierSatoshis: bigint;
  minerFeeSatoshis: bigint;
  estimatedSizeBytes: number;
  feeRateSatoshisPerKb: bigint;
}

/** Display-order transaction IDs are serialized in reverse byte order in inputs. */
function outpointHashBytes(txid: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error("PUSD input contains an invalid transaction ID.");
  return hexToBin(txid.match(/../g)!.reverse().join(""));
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function assertAuthenticated(utxo: AuthenticatedPusdUtxo): void {
  if (utxo.provenance?.rawTransactionVerified !== true ||
      utxo.provenance?.unspentChecked !== true ||
      utxo.provenance.txid.toLowerCase() !== utxo.txid.toLowerCase() ||
      utxo.provenance.vout !== utxo.vout) {
    throw new Error("PUSD input has no matching raw-transaction and unspent-state provenance.");
  }
  if (!utxo.lockingBytecode || !/^(?:[0-9a-f]{2})+$/i.test(utxo.lockingBytecode)) {
    throw new Error("PUSD input is missing its verified wallet locking script.");
  }
  if (!utxo.token || utxo.token.category !== PUSD_ASSET.categoryId ||
      utxo.token.amount <= 0n || utxo.token.amount > CASH_TOKEN_MAX_AMOUNT || utxo.token.nft) {
    throw new Error("PUSD input contains an unsupported token category, amount or NFT.");
  }
  if (utxo.satoshis <= 0n) throw new Error("PUSD input has no BCH carrier value.");
}

function createTokenOutput(lockingBytecode: string, amount: bigint) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(lockingBytecode)) {
    throw new Error("Recipient or change locking bytecode is malformed.");
  }
  const output = {
    valueSatoshis: 0n,
    lockingBytecode: hexToBin(lockingBytecode),
    token: {
      category: hexToBin(PUSD_ASSET.categoryId),
      amount,
    },
  };
  return { ...output, valueSatoshis: getDustThreshold(output) };
}

function createUnsignedInputs(utxos: readonly AuthenticatedPusdUtxo[]) {
  return utxos.map((utxo) => ({
    outpointTransactionHash: outpointHashBytes(utxo.txid),
    outpointIndex: utxo.vout,
    sequenceNumber: 0xffffffff,
    unlockingBytecode: new Uint8Array(),
  }));
}

function estimateTransactionSize(
  utxos: readonly AuthenticatedPusdUtxo[],
  outputs: PusdTransferPlan["transaction"]["outputs"],
): number {
  const inputs = createUnsignedInputs(utxos).map((input) => ({
    ...input,
    unlockingBytecode: new Uint8Array(MAX_UNLOCKING_BYTECODE_LENGTH),
  }));
  return encodeTransactionBCH({
    version: 2,
    locktime: 0,
    inputs,
    outputs,
  }).length;
}

/**
 * Construct a standard P2PKH PUSD transfer using only authenticated PUSD UTXOs.
 *
 * CashTokens carrier minimums are calculated from the complete serialized output
 * (including token prefix) using Libauth's dust calculation. Miner fees are
 * estimated against a conservative 108-byte P2PKH unlocking script per input.
 * BCH-only UTXOs are intentionally not mixed into this first release path.
 */
export function buildPusdTransferPlan(options: PusdTransferPlanOptions): PusdTransferPlan {
  const {
    authenticatedUtxos,
    requiredPusdAmount,
    recipientLockingBytecode,
    changeLockingBytecode,
    feeRateSatoshisPerKb,
    maxFeeSatoshis,
  } = options;

  if (requiredPusdAmount <= 0n || requiredPusdAmount > CASH_TOKEN_MAX_AMOUNT) {
    throw new Error("Requested PUSD amount is outside the CashTokens fungible amount range.");
  }
  if (feeRateSatoshisPerKb <= 0n || feeRateSatoshisPerKb > 1_000_000n) {
    throw new Error("Fee rate must be between 1 and 1000000 satoshis per kilobyte.");
  }
  if (maxFeeSatoshis < 0n) throw new Error("Maximum miner fee cannot be negative.");
  if (recipientLockingBytecode.toLowerCase() === changeLockingBytecode.toLowerCase()) {
    throw new Error("Recipient and wallet change locking scripts must be different.");
  }

  const candidates = [...authenticatedUtxos];
  const seen = new Set<string>();
  for (const utxo of candidates) {
    assertAuthenticated(utxo);
    const key = utxo.txid.toLowerCase() + ":" + utxo.vout;
    if (seen.has(key)) throw new Error("PUSD transfer contains duplicate input outpoints.");
    seen.add(key);
  }
  if (candidates.length === 0) throw new Error("No authenticated PUSD UTXOs are available.");
  candidates.sort((a, b) => {
    if (a.token!.amount !== b.token!.amount) return a.token!.amount < b.token!.amount ? -1 : 1;
    const keyA = a.txid.toLowerCase() + ":" + a.vout;
    const keyB = b.txid.toLowerCase() + ":" + b.vout;
    return keyA.localeCompare(keyB);
  });

  const recipientOutput = createTokenOutput(recipientLockingBytecode, requiredPusdAmount);
  const changeDustOutput = createTokenOutput(changeLockingBytecode, 1n);
  const bchChangeDustOutput = {
    valueSatoshis: 0n,
    lockingBytecode: hexToBin(changeLockingBytecode),
  };
  const bchChangeDust = getDustThreshold(bchChangeDustOutput);

  const selected: AuthenticatedPusdUtxo[] = [];
  let totalTokens = 0n;
  let totalCarrier = 0n;
  let finalOutputs: PusdTransferPlan["transaction"]["outputs"] | null = null;
  let finalFee = 0n;
  let finalSize = 0;

  for (const utxo of candidates) {
    selected.push(utxo);
    totalTokens += utxo.token!.amount;
    totalCarrier += utxo.satoshis;
    if (selected.length > MAX_TRANSACTION_INPUTS) {
      throw new Error("PUSD transfer exceeds the 50-input planning limit. Consolidate UTXOs first.");
    }
    if (totalTokens < requiredPusdAmount) continue;

    const tokenChange = totalTokens - requiredPusdAmount;
    const tokenOutputs = tokenChange > 0n
      ? [recipientOutput, createTokenOutput(changeLockingBytecode, tokenChange)]
      : [recipientOutput];
    const requiredCarrier = tokenOutputs.reduce((sum, output) => sum + output.valueSatoshis, 0n);
    const changeOutputs = [...tokenOutputs, bchChangeDustOutput];
    const estimatedSizeWithBchChange = estimateTransactionSize(selected, changeOutputs);
    const estimatedFeeWithBchChange = ceilDiv(
      BigInt(estimatedSizeWithBchChange) * feeRateSatoshisPerKb,
      1000n,
    );
    const bchRemainder = totalCarrier - requiredCarrier - estimatedFeeWithBchChange;

    if (bchRemainder >= bchChangeDust) {
      finalOutputs = [
        ...tokenOutputs,
        { ...bchChangeDustOutput, valueSatoshis: bchRemainder },
      ];
      finalFee = estimatedFeeWithBchChange;
      finalSize = estimatedSizeWithBchChange;
    } else {
      const estimatedSizeWithoutBchChange = estimateTransactionSize(selected, tokenOutputs);
      const minimumFeeWithoutChange = ceilDiv(
        BigInt(estimatedSizeWithoutBchChange) * feeRateSatoshisPerKb,
        1000n,
      );
      const actualFee = totalCarrier - requiredCarrier;
      if (actualFee < minimumFeeWithoutChange) continue;
      finalOutputs = tokenOutputs;
      finalFee = actualFee;
      finalSize = estimatedSizeWithoutBchChange;
    }

    if (finalFee <= maxFeeSatoshis) break;
    finalOutputs = null;
  }

  if (!finalOutputs) {
    if (totalTokens < requiredPusdAmount) {
      throw new Error("Insufficient authenticated PUSD balance for this transfer.");
    }
    throw new Error("PUSD UTXOs do not provide enough BCH carrier and fee value within the approved maximum fee.");
  }

  const tokenChangeAmount = totalTokens - requiredPusdAmount;
  const inputs = createUnsignedInputs(selected);
  const sourceOutputs = selected.map((utxo) => ({
    valueSatoshis: utxo.satoshis,
    lockingBytecode: hexToBin(utxo.lockingBytecode),
    token: {
      category: hexToBin(PUSD_ASSET.categoryId),
      amount: utxo.token!.amount,
    },
  }));

  return {
    transaction: {
      version: 2,
      locktime: 0,
      inputs,
      outputs: finalOutputs,
    },
    sourceOutputs,
    walletInputs: inputs.map((_, index) => index),
    selectedUtxos: selected,
    recipientPusdAmount: requiredPusdAmount,
    changePusdAmount: tokenChangeAmount,
    recipientCarrierSatoshis: recipientOutput.valueSatoshis,
    changeCarrierSatoshis: tokenChangeAmount > 0n ? changeDustOutput.valueSatoshis : 0n,
    minerFeeSatoshis: finalFee,
    estimatedSizeBytes: finalSize,
    feeRateSatoshisPerKb,
  };
}
