import { describe, expect, it } from "vitest";
import {
  ensureSavedCircleMetadata,
  filterSavedCirclesByNetwork,
  filterSavedCirclesByStatus,
  readSavedCircleMetadata,
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

  it("treats records without lifecycle metadata as Active until chain state is checked", () => {
    const storage = memoryStorage();
    const [record] = ensureSavedCircleMetadata(storage, [mainnet]);
    expect(record.status).toBe("active");
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

  it("keeps the original encoded circle payload unchanged during metadata updates", () => {
    const storage = memoryStorage();
    ensureSavedCircleMetadata(storage, [mainnet]);
    updateSavedCircleProgress(storage, mainnet, 2, false, 1_800_000_000_000);
    expect(readSavedCircleMetadata(storage)[0].encoded).toBe(mainnet.encoded);
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
