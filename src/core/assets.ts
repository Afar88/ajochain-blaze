import type { CircleAsset } from "./member-ledger";

/**
 * Canonical ParyonUSD CashToken identity from the issuer's published token
 * page. This is a mainnet category; it is not a Chipnet/testnet token ID.
 */
export const PUSD_ASSET = {
  symbol: "PUSD",
  name: "ParyonUSD",
  network: "mainnet",
  decimals: 2,
  categoryId: "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544",
} as const;

export const ASSET_DECIMALS: Record<CircleAsset, number> = {
  BCH: 8,
  PUSD: PUSD_ASSET.decimals,
};

export const CASH_TOKEN_MAX_AMOUNT = 9_223_372_036_854_775_807n;

/** Parse a human amount into exact integer base units; never uses floating point. */
export function parseAssetAmount(asset: CircleAsset, value: string): bigint {
  const decimals = ASSET_DECIMALS[asset];
  const normalized = value.trim();
  const match = /^(0|[1-9]\\d*)(?:\\.(\\d+))?$/.exec(normalized);
  if (!match) throw new Error("Enter a valid positive decimal amount.");
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error(`${asset} supports at most ${decimals} decimal places.`);
  }
  const whole = BigInt(match[1]);
  const fractional = BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  const units = whole * (10n ** BigInt(decimals)) + fractional;
  if (units <= 0n) throw new Error("Amount must be greater than zero.");
  if (asset === "PUSD" && units > CASH_TOKEN_MAX_AMOUNT) {
    throw new Error("PUSD amount exceeds the CashTokens fungible amount limit.");
  }
  return units;
}

export function formatAssetAmount(asset: CircleAsset, baseUnits: bigint): string {
  if (baseUnits < 0n) throw new Error("Amount cannot be negative.");
  const decimals = ASSET_DECIMALS[asset];
  const scale = 10n ** BigInt(decimals);
  const whole = baseUnits / scale;
  const fraction = (baseUnits % scale).toString().padStart(decimals, "0");
  return decimals === 0 ? whole.toString() : `${whole}.${fraction}`;
}

/** Exact canonical category ID comparison; callers must normalize byte order first. */
export function isPusdCategoryId(categoryId: string): boolean {
  return /^[0-9a-f]{64}$/i.test(categoryId) &&
    categoryId.toLowerCase() === PUSD_ASSET.categoryId;
}

export function isAssetAvailableOnNetwork(asset: CircleAsset, network: "mainnet" | "chipnet"): boolean {
  return asset === "BCH" || (asset === "PUSD" && network === PUSD_ASSET.network);
}
