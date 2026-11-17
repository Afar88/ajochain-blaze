import { describe, expect, it } from "vitest";
import {
  getCircleWorkspacesForNetwork,
  getDefaultCircleWorkspace,
  resolveCircleWorkspaceForNetwork,
} from "./circle-network-options";

describe("network-specific circle workspaces", () => {
  it("shows only BCH and PUSD Mainnet workspaces on Mainnet", () => {
    expect(getCircleWorkspacesForNetwork("mainnet")).toEqual(["bch-mainnet", "pusd-mainnet"]);
  });

  it("shows only Fair-round and Classic BCH workspaces on Chipnet", () => {
    expect(getCircleWorkspacesForNetwork("chipnet")).toEqual(["bch-fair-round", "bch-classic"]);
  });

  it("chooses a default workspace for the active network", () => {
    expect(getDefaultCircleWorkspace("mainnet")).toBe("bch-mainnet");
    expect(getDefaultCircleWorkspace("chipnet")).toBe("bch-fair-round");
  });

  it("preserves a compatible choice and replaces a cross-network choice", () => {
    expect(resolveCircleWorkspaceForNetwork("pusd-mainnet", "mainnet")).toBe("pusd-mainnet");
    expect(resolveCircleWorkspaceForNetwork("bch-classic", "chipnet")).toBe("bch-classic");
    expect(resolveCircleWorkspaceForNetwork("bch-classic", "mainnet")).toBe("bch-mainnet");
    expect(resolveCircleWorkspaceForNetwork("pusd-mainnet", "chipnet")).toBe("bch-fair-round");
  });
});
