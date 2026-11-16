import { decodeCashAddress } from "@bitauth/libauth";
import { NETWORKS, type NetworkId } from "./network-config";
export { NETWORKS, type NetworkId, type NetworkConfig } from "./network-config";

export function isAddressForNetwork(address: string, network: NetworkId): boolean {
  const normalized = address.trim().toLowerCase();
  const decoded = decodeCashAddress(normalized);
  return typeof decoded !== "string" &&
    decoded.prefix === NETWORKS[network].cashAddressPrefix &&
    (decoded.type === "p2pkh" || decoded.type === "p2sh" ||
      decoded.type === "p2pkhWithTokens" || decoded.type === "p2shWithTokens");
}

export function formatBch(satoshis: bigint): string {
  const negative = satoshis < 0n;
  const absolute = negative ? -satoshis : satoshis;
  const whole = absolute / 100_000_000n;
  const fraction = (absolute % 100_000_000n).toString().padStart(8, "0");
  return `${negative ? "-" : ""}${whole}.${fraction} BCH`;
}
