import { CASH_TOKEN_MAX_AMOUNT, PUSD_ASSET, isPusdCategoryId } from "./assets";

export interface PusdUtxo {
  txid: string;
  vout: number;
  satoshis: bigint;
  token?: {
    category: string;
    amount: bigint;
    nft?: { capability: "none" | "mutable" | "minting"; commitment: string };
  };
  lockingBytecode?: string;
}

export interface PusdInputPlan {
  inputs: PusdUtxo[];
  totalTokenAmount: bigint;
  tokenChange: bigint;
  requiredTokenAmount: bigint;
}

/** Select exact-category, fungible-only PUSD UTXOs from fresh provider data. */
export function planPusdInputs(utxos: PusdUtxo[], requiredTokenAmount: bigint): PusdInputPlan {
  if (requiredTokenAmount <= 0n || requiredTokenAmount > CASH_TOKEN_MAX_AMOUNT) {
    throw new Error("Requested PUSD amount is outside the CashTokens fungible amount range.");
  }

  const seen = new Set<string>();
  const candidates: PusdUtxo[] = [];
  for (const utxo of utxos) {
    if (!/^[0-9a-f]{64}$/i.test(utxo.txid) || !Number.isSafeInteger(utxo.vout) || utxo.vout < 0) {
      throw new Error("UTXO has an invalid outpoint.");
    }
    const outpoint = utxo.txid.toLowerCase() + ":" + utxo.vout;
    if (seen.has(outpoint)) throw new Error("Duplicate UTXO outpoint in PUSD selection.");
    seen.add(outpoint);

    if (!utxo.token || !isPusdCategoryId(utxo.token.category)) continue;
    if (utxo.token.nft) {
      throw new Error("PUSD input contains an NFT; refusing to select a mixed fungible/NFT UTXO.");
    }
    if (utxo.token.amount <= 0n || utxo.token.amount > CASH_TOKEN_MAX_AMOUNT) {
      throw new Error("PUSD UTXO has an invalid fungible token amount.");
    }
    if (utxo.satoshis < 0n) throw new Error("UTXO BCH carrier value cannot be negative.");
    candidates.push(utxo);
  }

  // Deterministic smallest-sufficient selection reduces unnecessary token change.
  candidates.sort((a, b) => {
    if (a.token!.amount < b.token!.amount) return -1;
    if (a.token!.amount > b.token!.amount) return 1;
    const keyA = a.txid.toLowerCase() + ":" + a.vout;
    const keyB = b.txid.toLowerCase() + ":" + b.vout;
    return keyA.localeCompare(keyB);
  });

  const inputs: PusdUtxo[] = [];
  let totalTokenAmount = 0n;
  for (const utxo of candidates) {
    inputs.push(utxo);
    totalTokenAmount += utxo.token!.amount;
    if (totalTokenAmount >= requiredTokenAmount) break;
  }

  if (totalTokenAmount < requiredTokenAmount) {
    throw new Error("Insufficient verified PUSD balance for this contribution.");
  }

  return {
    inputs,
    totalTokenAmount,
    tokenChange: totalTokenAmount - requiredTokenAmount,
    requiredTokenAmount,
  };
}

export function assertPusdCategory(category: string): void {
  if (!isPusdCategoryId(category)) {
    throw new Error("Unexpected CashToken category. Expected ParyonUSD " + PUSD_ASSET.categoryId + ".");
  }
}
