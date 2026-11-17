import type { NetworkId } from "./network-config";

export type CircleWorkspaceId = "bch-mainnet" | "pusd-mainnet" | "bch-fair-round" | "bch-classic";

/** Circle workspaces are isolated by chain so a test circle is never offered on Mainnet. */
export function getCircleWorkspacesForNetwork(network: NetworkId): readonly CircleWorkspaceId[] {
  return network === "mainnet"
    ? ["bch-mainnet", "pusd-mainnet"]
    : ["bch-fair-round", "bch-classic"];
}

export function getDefaultCircleWorkspace(network: NetworkId): CircleWorkspaceId {
  return network === "mainnet" ? "bch-mainnet" : "bch-fair-round";
}

/** Keep a user's choice when it belongs to the new network; otherwise select its safe default. */
export function resolveCircleWorkspaceForNetwork(
  current: CircleWorkspaceId,
  network: NetworkId,
): CircleWorkspaceId {
  const available = getCircleWorkspacesForNetwork(network);
  return available.includes(current) ? current : getDefaultCircleWorkspace(network);
}
