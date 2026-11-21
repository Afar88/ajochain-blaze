import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copy-text";

const originalNavigator = globalThis.navigator;

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true });
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("uses the Clipboard API when it works", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText } }, configurable: true });
    await expect(copyText("bitcoincash:zabc")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("bitcoincash:zabc");
  });

  it("returns false for empty text", async () => {
    await expect(copyText("")).resolves.toBe(false);
  });

  it("does not throw when the Clipboard API rejects and no document exists", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"));
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText } }, configurable: true });
    const result = await copyText("x");
    expect(typeof result).toBe("boolean");
  });
});
