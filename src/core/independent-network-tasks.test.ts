import { describe, expect, it, vi } from "vitest";
import { settleIndependentTasks } from "./independent-network-tasks";

describe("independent network discovery", () => {
  it("publishes Mainnet results while Chipnet is still pending", async () => {
    let finishChipnet!: (value: string) => void;
    const mainnetSettled = vi.fn();
    let aggregateSettled = false;
    const combined = settleIndependentTasks(
      () => new Promise<string>((resolve) => { finishChipnet = resolve; }),
      async () => ({ found: 1 }),
      undefined,
      mainnetSettled,
    );
    void combined.then(() => { aggregateSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mainnetSettled).toHaveBeenCalledWith({ status: "fulfilled", value: { found: 1 } });
    expect(aggregateSettled).toBe(false);
    finishChipnet("done");
    await combined;
    expect(aggregateSettled).toBe(true);
  });

  it("keeps Mainnet discovery running when Chipnet discovery fails", async () => {
    const saveMainnetCircle = vi.fn(async () => "saved");

    const [chipnet, mainnet] = await settleIndependentTasks(
      async () => {
        throw new Error("Chipnet provider unavailable");
      },
      saveMainnetCircle,
    );

    expect(chipnet.status).toBe("rejected");
    expect(mainnet).toEqual({ status: "fulfilled", value: "saved" });
    expect(saveMainnetCircle).toHaveBeenCalledOnce();
  });
});
