import { describe, expect, it } from "vitest";
import type { NetworkProvider } from "cashscript";
import { readCircleTransactionHistory } from "./chain-activity";

describe("circle transaction history source routing", () => {
  it("reads Chipnet history from the active Electrum provider and labels its confidence", async () => {
    const requests: Array<{ method: string; params: unknown[] }> = [];
    const provider = {
      getBlockHeight: async () => 900_123,
      performRequest: async (method: string, ...params: unknown[]) => {
        requests.push({ method, params });
        if (method === "blockchain.scripthash.get_history") return [];
        throw new Error("Unexpected Electrum method: " + method);
      },
    } as unknown as NetworkProvider;

    const result = await readCircleTransactionHistory(
      provider,
      "chipnet",
      ["76a914" + "11".repeat(20) + "88ac"],
    );

    expect(result).toMatchObject({
      network: "chipnet",
      tipHeight: 900_123,
      providerConfidence: 1,
      truncated: false,
      records: [],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("blockchain.scripthash.get_history");
    expect(requests[0].params[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects empty or duplicate contract/escrow script lists", async () => {
    const provider = {
      getBlockHeight: async () => 900_123,
      performRequest: async () => [],
    } as unknown as NetworkProvider;
    const script = "76a914" + "11".repeat(20) + "88ac";

    await expect(readCircleTransactionHistory(provider, "chipnet", []))
      .rejects.toThrow(/between one and eight unique/);
    await expect(readCircleTransactionHistory(provider, "chipnet", [script, script]))
      .rejects.toThrow(/between one and eight unique/);
  });

  it("fails closed when a Mainnet provider has no independent-quorum history reader", async () => {
    const provider = {
      getBlockHeight: async () => 900_123,
    } as unknown as NetworkProvider;

    await expect(readCircleTransactionHistory(
      provider,
      "mainnet",
      ["76a914" + "11".repeat(20) + "88ac"],
    )).rejects.toThrow(/quorum-verified script history/);
  });

  it("rejects invalid history limits before reading any provider", async () => {
    const provider = {
      getBlockHeight: async () => 900_123,
      performRequest: async () => [],
    } as unknown as NetworkProvider;

    await expect(readCircleTransactionHistory(provider, "chipnet", ["51"], 101))
      .rejects.toThrow(/between 1 and 100/);
  });
});
