import {
  binToHex,
  decodeTransactionBCH,
  hashTransaction,
  hexToBin,
} from "@bitauth/libauth";
import { PUSD_ASSET, isPusdCategoryId } from "./assets";
import type { PusdUtxo } from "./pusd-utxo";

export interface PusdOutpoint {
  txid: string;
  vout: number;
}

export interface PusdUnspentEvidence {
  /** Must be produced by the configured chain-state adapter, not provider JSON copied by the caller. */
  isUnspent(outpoint: PusdOutpoint): Promise<boolean>;
}

export interface AuthenticatedPusdUtxo extends PusdUtxo {
  lockingBytecode: string;
  provenance: {
    rawTransactionVerified: true;
    txid: string;
    vout: number;
    unspentChecked: true;
  };
}

export interface AuthenticatePusdUtxoOptions {
  outpoint: PusdOutpoint;
  rawPreviousTransactionHex: string;
  expectedLockingBytecode: string;
  unspentEvidence: PusdUnspentEvidence;
}

/**
 * Authenticate a candidate PUSD UTXO against the exact raw previous transaction.
 *
 * This proves the raw transaction hash, output index, output script/value/token
 * data, and a separately supplied unspent-state check. It does not authenticate
 * the provider or establish wallet ownership by itself: callers must supply the
 * locally derived expected locking bytecode and a chain-state adapter whose
 * trust model is documented and independently reviewed.
 */
export async function authenticatePusdUtxo(
  options: AuthenticatePusdUtxoOptions,
): Promise<AuthenticatedPusdUtxo> {
  const { outpoint, rawPreviousTransactionHex, expectedLockingBytecode, unspentEvidence } = options;

  if (!/^[0-9a-f]{64}$/i.test(outpoint.txid) ||
      !Number.isSafeInteger(outpoint.vout) || outpoint.vout < 0) {
    throw new Error("Candidate UTXO has an invalid outpoint.");
  }
  if (!/^(?:[0-9a-f]{2})+$/i.test(rawPreviousTransactionHex)) {
    throw new Error("Previous transaction must be complete raw hexadecimal bytes.");
  }
  if (!/^(?:[0-9a-f]{2})*$/i.test(expectedLockingBytecode)) {
    throw new Error("Expected wallet locking bytecode is malformed.");
  }

  const rawBytes = hexToBin(rawPreviousTransactionHex);
  const decoded = decodeTransactionBCH(rawBytes);
  if (typeof decoded === "string") {
    throw new Error("Previous transaction failed CashTokens-aware decoding: " + decoded);
  }

  const actualTxid = hashTransaction(rawBytes).toLowerCase();
  if (actualTxid !== outpoint.txid.toLowerCase()) {
    throw new Error("Previous transaction hash does not match the requested outpoint.");
  }

  const output = decoded.outputs[outpoint.vout];
  if (!output) throw new Error("Requested output index does not exist in the previous transaction.");

  const lockingBytecode = binToHex(output.lockingBytecode);
  if (lockingBytecode !== expectedLockingBytecode.toLowerCase()) {
    throw new Error("Previous output is not locked to the connected wallet's expected script.");
  }

  let token: PusdUtxo["token"];
  if (output.token) {
    const category = binToHex(output.token.category).toLowerCase();
    if (!isPusdCategoryId(category) || category !== PUSD_ASSET.categoryId) {
      throw new Error("Previous output contains an unexpected CashToken category.");
    }
    if (output.token.nft) {
      throw new Error("NFT-bearing PUSD outputs are not supported by the plain fungible transfer flow.");
    }
    if (output.token.amount <= 0n) {
      throw new Error("Previous output contains an invalid PUSD amount.");
    }
    token = { category, amount: output.token.amount };
  } else {
    throw new Error("Previous output does not contain PUSD.");
  }

  if (output.valueSatoshis <= 0n) {
    throw new Error("Previous output has no BCH carrier value.");
  }

  // Recheck state only after the candidate's raw provenance has been verified.
  // A transaction inclusion proof alone is not proof that an output is unspent.
  const isUnspent = await unspentEvidence.isUnspent({
    txid: actualTxid,
    vout: outpoint.vout,
  });
  if (isUnspent !== true) {
    throw new Error("Candidate PUSD outpoint is spent or its unspent status cannot be established.");
  }

  return {
    txid: actualTxid,
    vout: outpoint.vout,
    satoshis: output.valueSatoshis,
    token,
    lockingBytecode,
    provenance: {
      rawTransactionVerified: true,
      txid: actualTxid,
      vout: outpoint.vout,
      unspentChecked: true,
    },
  };
}
