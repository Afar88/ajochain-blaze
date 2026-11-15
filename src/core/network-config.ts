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
