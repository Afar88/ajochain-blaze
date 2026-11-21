import { PUSD_ASSET, isPusdCategoryId } from "./assets";
import type { PusdUtxo } from "./pusd-utxo";

export interface PusdProviderSnapshot {
  providerId: string;
  network: "mainnet";
  address: string;
  category: string;
  tipHeight: number;
  tipHash: string;
  observedAtMs: number;
  paginationComplete: boolean;
  utxos: PusdUtxo[];
}

export interface PusdProviderPolicy {
  expectedAddress: string;
  nowMs: number;
  maxAgeMs: number;
  minTipHeight: number;
}

const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;

/**
 * Validate normalized provider data before it can reach UTXO selection.
 * This does not authenticate the provider or independently prove prevout
 * contents/unspent status; callers must perform those checks separately.
 */
export function validatePusdProviderSnapshot(
  snapshot: PusdProviderSnapshot,
  policy: PusdProviderPolicy,
): PusdUtxo[] {
  if (!snapshot.providerId.trim()) throw new Error("PUSD provider identity is missing.");
  if (snapshot.network !== "mainnet") throw new Error("PUSD provider returned the wrong network.");
  if (snapshot.address !== policy.expectedAddress) throw new Error("PUSD provider response is for a different address.");
  if (!isPusdCategoryId(snapshot.category) || snapshot.category !== PUSD_ASSET.categoryId) {
    throw new Error("PUSD provider returned the wrong token category.");
  }
  if (!Number.isSafeInteger(snapshot.tipHeight) || snapshot.tipHeight < policy.minTipHeight) {
    throw new Error("PUSD provider chain tip is behind the accepted minimum.");
  }
  if (!/^[0-9a-f]{64}$/i.test(snapshot.tipHash)) throw new Error("PUSD provider chain tip hash is invalid.");
  // Phones and servers rarely share an exact clock. Accept a server time up to
  // two minutes ahead of this device so a slow phone clock doesn't hide PUSD.
  if (!Number.isFinite(snapshot.observedAtMs) || snapshot.observedAtMs > policy.nowMs + MAX_CLOCK_SKEW_MS ||
      policy.nowMs - snapshot.observedAtMs > policy.maxAgeMs) {
    throw new Error("PUSD provider snapshot is stale or has an invalid observation time.");
  }
  if (!snapshot.paginationComplete) throw new Error("PUSD provider pagination is incomplete.");
  if (!Array.isArray(snapshot.utxos)) throw new Error("PUSD provider UTXO list is invalid.");

  const seen = new Set<string>();
  for (const utxo of snapshot.utxos) {
    if (!/^[0-9a-f]{64}$/i.test(utxo.txid) || !Number.isSafeInteger(utxo.vout) || utxo.vout < 0) {
      throw new Error("PUSD provider returned an invalid outpoint.");
    }
    const outpoint = utxo.txid.toLowerCase() + ":" + utxo.vout;
    if (seen.has(outpoint)) throw new Error("PUSD provider returned duplicate outpoints.");
    seen.add(outpoint);
    if (utxo.satoshis <= 0n) throw new Error("PUSD provider returned an invalid BCH carrier value.");
    if (!utxo.token || !isPusdCategoryId(utxo.token.category) || utxo.token.category !== snapshot.category) {
      throw new Error("PUSD provider returned a UTXO with an unexpected token category.");
    }
    if (utxo.token.nft) throw new Error("PUSD NFT-bearing UTXOs are not supported by the plain-transfer flow.");
    if (utxo.token.amount <= 0n) throw new Error("PUSD provider returned an invalid token amount.");
  }
  return snapshot.utxos;
}
