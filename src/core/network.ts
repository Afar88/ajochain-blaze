import { decodeCashAddress } from "@bitauth/libauth";

export type NetworkId = "mainnet" | "chipnet";

export interface NetworkConfig {
  id: NetworkId;
  label: string;
  cashAddressPrefix: "bitcoincash" | "bchtest";
  explorerBaseUrl: string;
  broadcastEnabled: false;
}

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  mainnet: {
    id: "mainnet",
    label: "Bitcoin Cash Mainnet",
    cashAddressPrefix: "bitcoincash",
    explorerBaseUrl: "https://explorer.bitcoin.com/bch",
    broadcastEnabled: false,
  },
  chipnet: {
    id: "chipnet",
    label: "Bitcoin Cash Chipnet",
    cashAddressPrefix: "bchtest",
    explorerBaseUrl: "https://chipnet.chaingraph.cash",
    broadcastEnabled: false,
  },
};

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