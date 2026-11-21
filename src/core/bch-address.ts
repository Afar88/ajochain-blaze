import { decodeCashAddress, encodeCashAddress } from "@bitauth/libauth";

export type Net = "mainnet" | "chipnet";

/** Encode a P2PKH public-key hash as a BCH CashAddress for the selected network. */
export function pkhToAddress(pkh: Uint8Array, network: Net): string {
  if (!(pkh instanceof Uint8Array) || pkh.length !== 20) {
    throw new Error("A BCH P2PKH address requires a 20-byte public-key hash.");
  }
  const prefix = network === "mainnet" ? "bitcoincash" : "bchtest";
  const result = encodeCashAddress({ prefix, type: "p2pkh", payload: pkh });
  if (typeof result === "string") throw new Error(`Could not encode BCH address: ${result}`);
  return result.address;
}

/** Encode an existing public-key hash as the CashTokens-aware P2PKH form. */
export function pkhToTokenAwareAddress(pkh: Uint8Array, network: Net): string {
  if (!(pkh instanceof Uint8Array) || pkh.length !== 20) {
    throw new Error("A CashTokens-aware P2PKH address requires a 20-byte public-key hash.");
  }
  const prefix = network === "mainnet" ? "bitcoincash" : "bchtest";
  const result = encodeCashAddress({ prefix, type: "p2pkhWithTokens", payload: pkh });
  if (typeof result === "string") throw new Error("Could not encode CashTokens-aware BCH address: " + result);
  return result.address;
}

/**
 * Display helper: show a plain P2PKH address in its CashTokens (z) form.
 * Same key and same coins; only the written form changes. Anything that is
 * not a valid P2PKH CashAddress is returned unchanged.
 */
export function toCashTokenAddress(address: string | null | undefined): string {
  if (!address) return address ?? "";
  const decoded = decodeCashAddress(address.trim());
  if (typeof decoded === "string" || decoded.type !== "p2pkh") return address;
  const result = encodeCashAddress({ prefix: decoded.prefix, type: "p2pkhWithTokens", payload: decoded.payload });
  return typeof result === "string" ? address : result.address;
}
