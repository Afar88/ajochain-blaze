import { beforeEach, describe, expect, it } from "vitest";
import { forgetRememberedSnapshots, recallSnapshot, rememberSnapshot } from "./remembered-snapshots";

describe("remembered circle details", () => {
  beforeEach(() => forgetRememberedSnapshots());

  it("returns the last details for a circle and nothing for an unknown one", () => {
    rememberSnapshot("circle-a", { round: 2 });
    expect(recallSnapshot<{ round: number }>("circle-a")).toEqual({ round: 2 });
    expect(recallSnapshot("circle-b")).toBeNull();
    expect(recallSnapshot(null)).toBeNull();
  });

  it("keeps only the most recent circles", () => {
    for (let index = 0; index < 40; index += 1) rememberSnapshot("circle-" + index, index);
    expect(recallSnapshot("circle-0")).toBeNull();
    expect(recallSnapshot("circle-39")).toBe(39);
  });
});
