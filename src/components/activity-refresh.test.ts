import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./activity-refresh";

describe("activity reads are capped", () => {
  it("never runs more than the limit at once and keeps order", async () => {
    let running = 0;
    let peak = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5 * (8 - value)));
      running -= 1;
      return value * 10;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(result).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });
});
