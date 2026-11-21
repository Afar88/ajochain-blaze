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

describe("fresh wallet connection", () => {
  it("clears the saved pairing even when no manager is running", () => {
    expect(source).toContain("try { clearSavedWizardSession(); } catch");
  });

  it("timeout stops the relay so the page cannot flip back to reconnecting", () => {
    const body = source.slice(source.indexOf("private startConnectionWatchdog("), source.indexOf("private isCurrent("));
    expect(body).toContain("this.cleanup(mgr, relay, false)");
    expect(body).toContain("this.mgr = null");
  });
});

describe("coming back from Selene", () => {
  it("restarts a stalled saved session on a fresh relay when the page returns", () => {
    const body = source.slice(source.indexOf("resumeAfterBackground(): boolean"), source.indexOf("retrySavedSession(): boolean"));
    expect(body).toContain("if (this.autoResumePaused) return false;");
    expect(body).toContain("this.state === 'reconnecting'");
    expect(body).toContain("return this.retrySavedSession();");
    expect(source).toContain("if (wasAway) wallet.resumeAfterBackground();");
  });

  it("retries a timed-out saved session once before asking the user", () => {
    const body = source.slice(source.indexOf("private startConnectionWatchdog("), source.indexOf("private isCurrent("));
    expect(body).toContain("existing && !this.autoRetryUsed && !this.autoResumePaused");
    expect(body).toContain("this.autoRetryUsed = true;");
    expect(source).toContain("this.autoRetryUsed = false;\n      this.state = 'connected';");
  });
});
