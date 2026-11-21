import { describe, expect, it } from "vitest";
import { readUnconfirmedCircleCategories, recordDiscoveredCircleConfirmations } from "./unconfirmed-circles";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

describe("circles waiting for their first confirmation", () => {
  it("remembers an unconfirmed circle and forgets it once a scan sees it mined", () => {
    const storage = memoryStorage();
    const category = "AB".repeat(32);
    recordDiscoveredCircleConfirmations(storage, [{ stateCategory: category, confirmed: false }]);
    expect(readUnconfirmedCircleCategories(storage).has(category.toLowerCase())).toBe(true);
    recordDiscoveredCircleConfirmations(storage, [{ stateCategory: category, confirmed: true }]);
    expect(readUnconfirmedCircleCategories(storage).size).toBe(0);
  });

  it("ignores malformed stored values", () => {
    const storage = memoryStorage();
    storage.setItem("ajochain-blaze:unconfirmed-discovered-circles:v1", JSON.stringify(["nope", 3]));
    expect(readUnconfirmedCircleCategories(storage).size).toBe(0);
  });
});
