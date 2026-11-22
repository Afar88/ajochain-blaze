import { describe, expect, it } from "vitest";
import { circleDisplayName, isFallbackCircleName, preferRealCircleName } from "./circle-display-name";

describe("circle display names", () => {
  it("shows a friendlier stand-in for circles found without a saved name", () => {
    expect(circleDisplayName("Found circle a9a3bca6")).toBe("Circle a9a3bca6");
    expect(circleDisplayName("Found circle A9A3BCA6")).toBe("Circle a9a3bca6");
  });

  it("keeps real names exactly as the creator set them", () => {
    expect(circleDisplayName("Family Ajo")).toBe("Family Ajo");
    expect(circleDisplayName("Found circle for mum")).toBe("Found circle for mum");
    expect(isFallbackCircleName("Found circle for mum")).toBe(false);
  });

  it("prefers a real saved name over the stand-in", () => {
    expect(preferRealCircleName("Found circle a9a3bca6", "Office savings")).toBe("Office savings");
    expect(preferRealCircleName("Office savings", "Found circle a9a3bca6")).toBe("Office savings");
    expect(preferRealCircleName("Found circle a9a3bca6", null)).toBe("Found circle a9a3bca6");
  });
});
