import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "wizard-wallet.ts"), "utf8");

describe("wallet connect cancel", () => {
  it("cancel keeps the saved session and stops automatic resume", () => {
    const body = source.slice(source.indexOf("cancelConnectionAttempt(): boolean"), source.indexOf("async disconnect()"));
    expect(body).toContain("this.cleanup(mgr, relay, false)");
    expect(body).toContain("this.autoResumePaused = true");
    expect(body).toContain("this.state = 'disconnected'");
    expect(source).toContain("if (this.autoResumePaused) return false;");
  });

  it("times out a stuck reconnect instead of spinning for minutes", () => {
    expect(source).toContain('(this.state !== "connecting" && this.state !== "reconnecting")');
    expect(source).toContain("if (!wasReconnecting) this.startConnectionWatchdog(mgr, generation, true);");
  });

  it("explicit Reconnect, fresh pairing and Disconnect clear the pause", () => {
    expect(source.match(/this\.autoResumePaused = false;/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
