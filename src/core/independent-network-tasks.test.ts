import { describe, expect, it, vi } from "vitest";
import { settleIndependentTasks } from "./independent-network-tasks";

describe("independent network discovery", () => {
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
