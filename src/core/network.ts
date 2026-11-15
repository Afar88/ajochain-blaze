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
  const prefix = NETWORKS[network].cashAddressPrefix;
  return normalized.startsWith(prefix + ":") || normalized.startsWith(prefix);
}

export function formatBch(satoshis: bigint): string {
  const negative = satoshis < 0n;
  const absolute = negative ? -satoshis : satoshis;
  const whole = absolute / 100_000_000n;
  const fraction = (absolute % 100_000_000n).toString().padStart(8, "0");
  return `${negative ? "-" : ""}${whole}.${fraction} BCH`;
}