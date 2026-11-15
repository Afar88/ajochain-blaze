import { describe, expect, it } from "vitest";
import { validateCircleDraft, type CircleDraftInput } from "./circle";

const validDraft: CircleDraftInput = {
  name: "Family Savings",
  asset: "BCH",
  contributionAmount: "0.01",
  frequency: "weekly",
  members: [{ name: "Ada" }, { name: "Tobi" }],
};

describe("circle draft validation", () => {
  it("accepts a valid two-member BCH circle draft", () => {
    expect(validateCircleDraft(validDraft)).toMatchObject({
      valid: true,
      errors: [],
      needsWalletVerification: true,
    });
  });

  it("enforces the two-member minimum", () => {
    expect(validateCircleDraft({ ...validDraft, members: [{ name: "Ada" }] }).errors)
      .toContain("A circle needs at least 2 members.");
  });

  it("rejects zero, negative and malformed contribution amounts", () => {
    for (const amount of ["0", "0.000", "-1", "1e3", "abc", ""]) {
      expect(validateCircleDraft({ ...validDraft, contributionAmount: amount }).valid).toBe(false);
    }
  });

  it("accepts BCH and PUSD assets", () => {
    expect(validateCircleDraft({ ...validDraft, asset: "PUSD" }).valid).toBe(true);
    expect(validateCircleDraft({ ...validDraft, asset: "BCH" }).valid).toBe(true);
  });

  it("rejects duplicate member names and wallet addresses", () => {
    expect(validateCircleDraft({
      ...validDraft,
      members: [{ name: "Ada" }, { name: " ada " }],
    }).errors).toContain("Member display names must be unique.");

    expect(validateCircleDraft({
      ...validDraft,
      members: [
        { name: "Ada", walletAddress: "bitcoincash:qabc" },
        { name: "Tobi", walletAddress: "BITCOINCASH:QABC" },
      ],
    }).errors).toContain("A wallet address cannot be assigned to more than one member.");
  });

  it("requires wallet verification when participant wallets are missing", () => {
    expect(validateCircleDraft(validDraft).needsWalletVerification).toBe(true);
    expect(validateCircleDraft({
      ...validDraft,
      members: [
        { name: "Ada", walletAddress: "bitcoincash:qone" },
        { name: "Tobi", walletAddress: "bitcoincash:qtwo" },
      ],
    }).needsWalletVerification).toBe(false);
  });
});
