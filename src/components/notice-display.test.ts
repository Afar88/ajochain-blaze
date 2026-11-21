import { describe, expect, it } from "vitest";
import { noticeAutoClears } from "./notice-display";

describe("which workspace messages fade", () => {
  it("fades short confirmations", () => {
    for (const text of [
      "Member 1 address copied.",
      "Invite link copied. Share it with your circle members.",
      "V2 fee-circle invite copied.",
      "Your wallet matches Member 2.",
      "Saved on this phone. Not a live circle yet.",
      "BCH Mainnet circle status refreshed from the blockchain.",
    ]) expect(noticeAutoClears(text)).toBe(true);
  });

  it("keeps messages with a transaction ID, a link or a next step", () => {
    for (const text of [
      "Contribution broadcast. Transaction ID: " + "ab".repeat(32),
      "Invite link: https://example.org/#/join?c=abc",
      "Copy is unavailable in this browser. Invite route: #/classic/abc",
      "Local draft loaded. Confirm the member addresses and prepare a fresh Mainnet preview.",
      "Copy is unavailable. Select the address and copy it manually.",
      "Circle invite restored. Check the latest circle details before continuing.",
      "Sending your member contribution approval request to Selene…",
    ]) expect(noticeAutoClears(text)).toBe(false);
  });

  it("never fades an empty message timer", () => {
    expect(noticeAutoClears("")).toBe(false);
  });
});
