import { describe, expect, it } from "vitest";
import { checkCircleStatusesWithLimits, classifyCircleStatus, countCircleStatuses, shouldAutoHideDiscoveryMessage } from "./on-chain-circle-status";

describe("on-chain circle status classification", () => {
  it("classifies an unspent state with remaining rounds as Active", () => {
    expect(classifyCircleStatus({ round: 1, completed: false, stateVerified: true })).toEqual({
      status: "active", round: 1, completedAt: null,
    });
  });

  it("keeps a missing or unverified state NFT Unknown rather than guessing Active", () => {
    expect(classifyCircleStatus({ round: null, completed: false, stateVerified: false }).status).toBe("unknown");
    expect(classifyCircleStatus({ round: 1, completed: false }).status).toBe("unknown");
  });

  it("classifies a final payout as Completed and carries its block time", () => {
    expect(classifyCircleStatus({
      round: 5, completed: true, closedAs: "completed", completedAt: 1_800_000_000_000,
    })).toEqual({
      status: "completed", round: 5, completedAt: 1_800_000_000_000,
    });
  });

  it("classifies the explicit refund/cancel path as Cancelled", () => {
    expect(classifyCircleStatus({
      round: 5, completed: true, closedAs: "cancelled",
    })).toEqual({ status: "cancelled", round: 5, completedAt: null });
  });

  it("does not infer Completed when a status read fails", async () => {
    const [entry] = await checkCircleStatusesWithLimits(["circle-a"], async () => {
      throw new Error("provider unavailable");
    });
    expect(entry.result.status).toBe("unknown");
    expect(entry.result.status).not.toBe("completed");
  });

  it("checks circles with bounded concurrency and preserves source order", async () => {
    let inFlight = 0;
    let maximumInFlight = 0;
    const items = ["active", "completed", "cancelled", "unavailable"];
    const results = await checkCircleStatusesWithLimits(items, async (item) => {
      inFlight++;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 3));
      inFlight--;
      if (item === "unavailable") throw new Error("provider offline");
      if (item === "completed") return { round: 5, completed: true, closedAs: "completed" as const };
      if (item === "cancelled") return { round: 5, completed: true, closedAs: "cancelled" as const };
      return { round: 1, completed: false };
    }, { concurrency: 2, requestTimeoutMs: 100, overallTimeoutMs: 500 });
    expect(maximumInFlight).toBeLessThanOrEqual(2);
    expect(results.map((entry) => entry.result.status)).toEqual([
      "active", "completed", "cancelled", "unknown",
    ]);
  });

  it("times out an unresponsive chain read as Unknown", async () => {
    const [entry] = await checkCircleStatusesWithLimits(["slow"], () => new Promise(() => undefined), {
      concurrency: 1, requestTimeoutMs: 5, overallTimeoutMs: 10,
    });
    expect(entry.result.status).toBe("unknown");
  });

  it("keeps Unknown in Active and Cancelled in Completed counts", () => {
    expect(countCircleStatuses([
      { status: "active" as const },
      { status: "unknown" as const },
      { status: "completed" as const },
      { status: "cancelled" as const },
    ])).toEqual({ active: 2, completed: 2, cancelled: 1 });
  });
});

describe("discovery status message visibility", () => {
  it("hides after successful checks but persists for timeout or error", () => {
    expect(shouldAutoHideDiscoveryMessage(["success", "success"])).toBe(true);
    expect(shouldAutoHideDiscoveryMessage(["success", "timeout"])).toBe(false);
    expect(shouldAutoHideDiscoveryMessage(["success", "error"])).toBe(false);
    expect(shouldAutoHideDiscoveryMessage(["checking", "success"])).toBe(false);
  });
});
