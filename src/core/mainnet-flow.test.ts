import { describe, expect, it } from "vitest";
import {
  assertMainnetBroadcastEligible,
  CLOSED_MAINNET_GATES,
  evaluateMainnetFlow,
  MAINNET_GATE_KEYS,
  MAINNET_PRE_BROADCAST_GATE_KEYS,
} from "./mainnet-flow";

describe("mainnet release flow", () => {
  it("starts read-only with every gate closed", () => {
    const result = evaluateMainnetFlow();
    expect(result.phase).toBe("read-only");
    expect(result.canBroadcast).toBe(false);
    expect(result.missing).toHaveLength(MAINNET_GATE_KEYS.length);
    expect(result.missingBeforeBroadcast).toHaveLength(MAINNET_PRE_BROADCAST_GATE_KEYS.length);
  });

  it("never treats wallet connection alone as mainnet readiness", () => {
    const result = evaluateMainnetFlow({ walletSessionVerified: true });
    expect(result.phase).toBe("wallet-verification");
    expect(result.canBroadcast).toBe(false);
  });

  it("blocks when any pre-broadcast release gate is missing", () => {
    const almostReady = { ...CLOSED_MAINNET_GATES };
    for (const key of MAINNET_GATE_KEYS) almostReady[key] = true;
    almostReady.contractAuditApproved = false;
    expect(() => assertMainnetBroadcastEligible(almostReady))
      .toThrow(/Mainnet broadcast blocked/);
  });

  it("allows broadcast eligibility when every pre-broadcast gate passes", () => {
    const evidence = { ...CLOSED_MAINNET_GATES };
    for (const key of MAINNET_PRE_BROADCAST_GATE_KEYS) evidence[key] = true;
    const readiness = evaluateMainnetFlow(evidence);
    expect(readiness.canBroadcast).toBe(true);
    expect(readiness.phase).toBe("broadcast-eligible");
    expect(readiness.missing).toEqual(["relayAndConfirmationVerified"]);
    expect(readiness.missingBeforeBroadcast).toEqual([]);
    expect(() => assertMainnetBroadcastEligible(evidence)).not.toThrow();
  });

  it("requires independent post-broadcast confirmation before reporting confirmed", () => {
    const evidence = { ...CLOSED_MAINNET_GATES };
    for (const key of MAINNET_GATE_KEYS) evidence[key] = true;
    const readiness = evaluateMainnetFlow(evidence);
    expect(readiness.canBroadcast).toBe(true);
    expect(readiness.phase).toBe("confirmed");
    expect(readiness.missing).toEqual([]);
  });

  it("does not allow truthy non-boolean evidence to open a gate", () => {
    const result = evaluateMainnetFlow({
      walletSessionVerified: "yes" as unknown as boolean,
    });
    expect(result.canBroadcast).toBe(false);
    expect(result.missing).toContain("walletSessionVerified");
  });

  it("does not skip required Mainnet phases when evidence arrives out of order", () => {
    expect(evaluateMainnetFlow({ transactionPlanReviewed: true }).phase).toBe("read-only");
    expect(evaluateMainnetFlow({
      circleStateReconciled: true,
      memberAccountingVerified: true,
      contractAuditApproved: true,
      tokenPolicyVerified: true,
    }).phase).toBe("read-only");
    expect(evaluateMainnetFlow({
      networkIdentityVerified: true,
      walletSessionVerified: true,
      transactionPlanReviewed: true,
    }).phase).toBe("state-reconciliation");
  });

  it("keeps transaction review blocked until the active BCH consensus VM is verified", () => {
    const evidence = { ...CLOSED_MAINNET_GATES };
    for (const key of MAINNET_PRE_BROADCAST_GATE_KEYS) evidence[key] = true;
    evidence.consensusVmVerified = false;
    expect(evaluateMainnetFlow(evidence).canBroadcast).toBe(false);
    expect(evaluateMainnetFlow(evidence).missingBeforeBroadcast)
      .toContain("consensusVmVerified");
    expect(() => assertMainnetBroadcastEligible(evidence))
      .toThrow(/Current BCH Mainnet consensus VM/);
  });
});
