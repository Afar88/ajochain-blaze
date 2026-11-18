import { describe, expect, it } from "vitest";
import {
  dedupeSavedV2FeeCircleMenuRecords,
  dedupeSavedV2FeeCircleRecords,
  getV2FeeCircleRecordIdentity,
} from "./v2-fee-circle-records";

function encode(value: Record<string, unknown>) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

const circle = {
  version: 2,
  covenant: "fee-v3-auto-reserve-guarded",
  name: "Our Ajo",
  network: "chipnet",
  members: ["bchtest:member-one", "bchtest:member-two"],
  contribution: "200000",
  maxFee: "10000",
  stateCategory: "ab".repeat(32),
  initiator: "bchtest:member-one",
  treasury: "bchtest:treasury",
};

describe("V2 saved-circle identity", () => {
  it("deduplicates equivalent invites even when labels differ", () => {
    const older = encode(circle);
    const newer = encode({ ...circle, name: "Our Ajo Group" });
    const result = dedupeSavedV2FeeCircleRecords([
      { encoded: older, savedAt: 100 },
      { encoded: newer, savedAt: 200 },
    ]);
    expect(result).toEqual([{ encoded: newer, savedAt: 200 }]);
    expect(getV2FeeCircleRecordIdentity(older)?.key)
      .toBe(getV2FeeCircleRecordIdentity(newer)?.key);
  });

  it("keeps distinct circles even when they have the same display name", () => {
    const first = encode(circle);
    const second = encode({ ...circle, stateCategory: "cd".repeat(32) });
    const result = dedupeSavedV2FeeCircleRecords([
      { encoded: first, savedAt: 100 },
      { encoded: second, savedAt: 200 },
    ]);
    expect(result).toHaveLength(2);
  });

  it("shows only the newest shortcut when separate circles share a name", () => {
    const older = encode(circle);
    const newer = encode({ ...circle, name: "  OUR   AJO  ", stateCategory: "cd".repeat(32) });
    expect(dedupeSavedV2FeeCircleMenuRecords([
      { encoded: older, savedAt: 100 },
      { encoded: newer, savedAt: 200 },
    ])).toEqual([{ encoded: newer, savedAt: 200 }]);
  });

  it("uses constructor arguments as part of the contract identity", () => {
    const first = encode(circle);
    const second = encode({ ...circle, contribution: "300000" });
    expect(getV2FeeCircleRecordIdentity(first)?.key)
      .not.toBe(getV2FeeCircleRecordIdentity(second)?.key);
  });

  it("ignores malformed and incomplete saved entries", () => {
    expect(getV2FeeCircleRecordIdentity("not-an-invite")).toBeNull();
    expect(dedupeSavedV2FeeCircleRecords([
      { encoded: "not-an-invite", savedAt: 100 },
      { encoded: encode({ ...circle, stateCategory: "bad" }), savedAt: 200 },
      { encoded: encode(circle), savedAt: 300 },
    ])).toHaveLength(1);
  });
});
