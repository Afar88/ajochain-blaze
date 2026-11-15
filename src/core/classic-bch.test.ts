import { describe, expect, it } from "vitest";
import { encodeCashAddress } from "@bitauth/libauth";
import {
  decodeClassicCircle,
  encodeClassicCircle,
  validateClassicCircle,
  type ClassicCircleParams,
} from "./classic-bch";
import {
  buildClassicInviteRoute,
  loadSavedClassicCircles,
  restoreClassicCircleFromInvite,
  saveClassicCircle,
  type StorageLike,
} from "./circle-account";

function address(payloadByte: number) {
  const encoded = encodeCashAddress({
    prefix: "bitcoincash",
    type: "p2pkh",
    payload: new Uint8Array(20).fill(payloadByte),
  });
  if (typeof encoded === "string") throw new Error(encoded);
  return encoded.address;
}

function circle(): ClassicCircleParams {
  return {
    version: 1,
    name: "Family Ajo",
    network: "mainnet",
    members: [address(1), address(2)],
    contribution: 100_000n,
    maxFee: 10_000n,
    stateCategory: "ab".repeat(32),
  };
}

class MemoryStorage implements StorageLike {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("Classic BCH circle parameters and invite links", () => {
  it("round-trips exact integer amounts and member order", () => {
    const params = circle();
    const decoded = decodeClassicCircle(encodeClassicCircle(params));
    expect(decoded.name).toBe(params.name);
    expect(decoded.members).toEqual(params.members);
    expect(decoded.contribution).toBe(100_000n);
    expect(decoded.maxFee).toBe(10_000n);
    expect(decoded.stateCategory).toBe(params.stateCategory);
  });

  it("rejects duplicate members and fee caps that would consume the recipient dust", () => {
    const params = circle();
    expect(() => validateClassicCircle({ ...params, members: [params.members[0], params.members[0]] }))
      .toThrow(/unique BCH address/);
    expect(() => validateClassicCircle({ ...params, maxFee: 199_001n }))
      .toThrow(/leave at least 1,000/);
  });

  it("rejects cross-network member addresses", () => {
    expect(() => validateClassicCircle({
      ...circle(),
      network: "chipnet",
    })).toThrow(/not on chipnet/);
  });
});

describe("browser-local circle account", () => {
  it("saves circles idempotently and restores an invite URL", () => {
    const storage = new MemoryStorage();
    const params = circle();
    const first = saveClassicCircle(storage, params, 100);
    const second = saveClassicCircle(storage, params, 200);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].savedAt).toBe(200);
    expect(loadSavedClassicCircles(storage)).toEqual(second);

    const route = buildClassicInviteRoute(params);
    const restored = restoreClassicCircleFromInvite("https://example.test/" + route);
    expect(restored.members).toEqual(params.members);
    expect(restored.name).toBe(params.name);
  });

  it("ignores corrupt local entries instead of trusting them as chain state", () => {
    const storage = new MemoryStorage();
    storage.setItem("ajochain-blaze:classic-circles:v1", JSON.stringify([
      { encoded: "not-a-circle", savedAt: 1 },
      { encoded: 42, savedAt: 2 },
    ]));
    expect(loadSavedClassicCircles(storage)).toEqual([]);
  });
});
