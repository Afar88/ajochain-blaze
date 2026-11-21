import { describe, expect, it } from "vitest";
import {
  ensureSavedCircleMetadata,
  filterSavedCirclesByNetwork,
  filterSavedCirclesByStatus,
  readSavedCircleMetadata,
  updateSavedCircleChainStatus,
  updateSavedCircleProgress,
  type SavedCircleDescriptor,
} from "./saved-circle-status";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

const mainnet: SavedCircleDescriptor = {
  id: "v2:mainnet-circle",
  encoded: "original-mainnet-encoded-payload",
  network: "mainnet",
  kind: "bch-mainnet",
  name: "Mainnet group",
  asset: "BCH",
  contribution: "200000",
  memberCount: 5,
};
const chipnet: SavedCircleDescriptor = {
  ...mainnet,
  id: "v2:chipnet-circle",
  encoded: "original-chipnet-encoded-payload",
  network: "chipnet",
  kind: "v2-fee",
  name: "Chipnet group",
};

describe("saved circle network and lifecycle filters", () => {
  it("shows only records for the currently selected network", () => {
    const records = ensureSavedCircleMetadata(memoryStorage(), [mainnet, chipnet]);
    expect(filterSavedCirclesByNetwork(records, "mainnet").map((circle) => circle.id))
      .toEqual([mainnet.id]);
    expect(filterSavedCirclesByNetwork(records, "chipnet").map((circle) => circle.id))
      .toEqual([chipnet.id]);
  });

  it("keeps records Unknown until a read-only chain check completes", () => {
    const storage = memoryStorage();
    const [record] = ensureSavedCircleMetadata(storage, [mainnet]);
    expect(record.status).toBe("unknown");
    expect(record.completedAt).toBeNull();
    expect(filterSavedCirclesByStatus([record], "active")).toHaveLength(1);
    expect(filterSavedCirclesByStatus([record], "completed")).toHaveLength(0);
  });

  it("moves a circle into Completed when the chain reader reports completion", () => {
    const storage = memoryStorage();
    ensureSavedCircleMetadata(storage, [mainnet]);
    const updated = updateSavedCircleProgress(storage, mainnet, 5, true, 1_800_000_000_000);
    expect(updated.status).toBe("completed");
    expect(updated.completedAt).toBe(1_800_000_000_000);
    expect(filterSavedCirclesByStatus([updated], "active")).toHaveLength(0);
    expect(filterSavedCirclesByStatus([updated], "completed")).toHaveLength(1);
  });

  it("does not fabricate a completion timestamp when a reader has no block time", () => {
    const storage = memoryStorage();
    ensureSavedCircleMetadata(storage, [mainnet]);
    const completed = updateSavedCircleProgress(storage, mainnet, 5, true);
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeNull();
  });

  it("upgrades a saved Active/Unknown circle to Completed from on-chain state", () => {
    const storage = memoryStorage();
    ensureSavedCircleMetadata(storage, [mainnet]);
    updateSavedCircleChainStatus(storage, mainnet, "active", 2, null, 1_800_000_000_000);
    const completed = updateSavedCircleChainStatus(storage, mainnet, "completed", 5, 1_800_000_100_000, 1_800_000_100_001);
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBe(1_800_000_100_000);
    expect(filterSavedCirclesByStatus([completed], "active")).toHaveLength(0);
    expect(filterSavedCirclesByStatus([completed], "completed")).toHaveLength(1);
  });

  it("saves Cancelled in the Completed tab with its own status label", () => {
    const storage = memoryStorage();
    ensureSavedCircleMetadata(storage, [mainnet]);
    const cancelled = updateSavedCircleChainStatus(storage, mainnet, "cancelled", 5, null, 1_800_000_200_000);
    expect(cancelled.status).toBe("cancelled");
    expect(filterSavedCirclesByStatus([cancelled], "active")).toHaveLength(0);
    expect(filterSavedCirclesByStatus([cancelled], "completed")).toHaveLength(1);
  });

  it("clears a stale local completion time when the chain cannot supply a block time", () => {
    const storage = memoryStorage();
    ensureSavedCircleMetadata(storage, [mainnet]);
    updateSavedCircleChainStatus(storage, mainnet, "completed", 5, 1_800_000_000_000);
    const updated = updateSavedCircleChainStatus(storage, mainnet, "completed", 5, null, 1_800_000_100_000);
    expect(updated.completedAt).toBeNull();
  });

  it("keeps a saved Completed result when a later check fails or times out", () => {
    const storage = memoryStorage();
    ensureSavedCircleMetadata(storage, [mainnet]);
    updateSavedCircleChainStatus(storage, mainnet, "completed", 5, 1_800_000_000_000);
    const unknown = updateSavedCircleChainStatus(storage, mainnet, "unknown", null, null, 1_800_000_500_000);
    expect(unknown.status).toBe("completed");
    expect(unknown.completedAt).toBe(1_800_000_000_000);
    expect(unknown.round).toBe(5);
    expect(unknown.checkedAt).toBe(1_800_000_500_000);
    expect(filterSavedCirclesByStatus([unknown], "active")).toHaveLength(0);
    expect(filterSavedCirclesByStatus([unknown], "completed")).toHaveLength(1);
  });

  it("keeps a saved Cancelled result when a later check fails or times out", () => {
    const storage = memoryStorage();
    ensureSavedCircleMetadata(storage, [mainnet]);
    updateSavedCircleChainStatus(storage, mainnet, "cancelled", 5, 1_800_000_000_000);
    const unknown = updateSavedCircleChainStatus(storage, mainnet, "unknown", null, null, 1_800_000_600_000);
    expect(unknown.status).toBe("cancelled");
    expect(unknown.completedAt).toBe(1_800_000_000_000);
    expect(unknown.checkedAt).toBe(1_800_000_600_000);
  });

  it("stores Unknown after a failed read when nothing final was saved before", () => {
    const storage = memoryStorage();
    ensureSavedCircleMetadata(storage, [mainnet]);
    updateSavedCircleChainStatus(storage, mainnet, "active", 2, null, 1_800_000_000_000);
    const unknown = updateSavedCircleChainStatus(storage, mainnet, "unknown", null, null, 1_800_000_500_000);
    expect(unknown.status).toBe("unknown");
    expect(unknown.checkedAt).toBe(1_800_000_500_000);
    expect(filterSavedCirclesByStatus([unknown], "active")).toHaveLength(1);
  });

  it("does not let a legacy progress refresh relabel an already Cancelled circle as Completed", () => {
    const storage = memoryStorage();
    ensureSavedCircleMetadata(storage, [mainnet]);
    updateSavedCircleChainStatus(storage, mainnet, "cancelled", 5, null);
    const refreshed = updateSavedCircleProgress(storage, mainnet, 5, true, 1_800_000_800_000);
    expect(refreshed.status).toBe("cancelled");
  });

  it("keeps the original encoded circle payload unchanged during metadata updates", () => {
    const storage = memoryStorage();
    ensureSavedCircleMetadata(storage, [mainnet]);
    updateSavedCircleProgress(storage, mainnet, 2, false, 1_800_000_000_000);
    expect(readSavedCircleMetadata(storage)[0].encoded).toBe(mainnet.encoded);
  });

  it("never rewrites legacy saved-circle entries while adding lifecycle metadata", () => {
    const storage = memoryStorage();
    const legacyEntry = JSON.stringify([{ encoded: mainnet.encoded, savedAt: 123 }]);
    storage.setItem("legacy-classic-circles", legacyEntry);

    ensureSavedCircleMetadata(storage, [mainnet]);
    updateSavedCircleProgress(storage, mainnet, 2, false, 1_800_000_000_000);

    expect(storage.getItem("legacy-classic-circles")).toBe(legacyEntry);
  });

  it("returns a completed circle to Active when a fresh chain read is not complete", () => {
    const storage = memoryStorage();
    ensureSavedCircleMetadata(storage, [mainnet]);
    updateSavedCircleProgress(storage, mainnet, 2, true, 1_800_000_000_000);
    const updated = updateSavedCircleProgress(storage, mainnet, 2, false, 1_800_000_000_001);
    expect(updated.status).toBe("active");
    expect(updated.completedAt).toBeNull();
  });
});
