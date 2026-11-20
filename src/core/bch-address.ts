import { encodeCashAddress } from "@bitauth/libauth";

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
