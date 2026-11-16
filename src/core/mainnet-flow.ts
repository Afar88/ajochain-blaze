/**
 * Mainnet release gate.
 *
 * Evidence must be independently produced by the relevant verification step.
 * Pre-broadcast prerequisites are distinct from post-broadcast confirmation:
 * a transaction cannot require confirmation before it is allowed to broadcast.
 */
export const MAINNET_GATE_KEYS = [
  "networkIdentityVerified",
  "consensusVmVerified",
  "walletSessionVerified",
  "circleStateReconciled",
  "memberAccountingVerified",
  "contractAuditApproved",
  "tokenPolicyVerified",
  "transactionPlanReviewed",
  "signedTransactionInspected",
  "relayAndConfirmationVerified",
] as const;

export const MAINNET_PRE_BROADCAST_GATE_KEYS = [
  "networkIdentityVerified",
  "consensusVmVerified",
  "walletSessionVerified",
  "circleStateReconciled",
  "memberAccountingVerified",
  "contractAuditApproved",
  "tokenPolicyVerified",
  "transactionPlanReviewed",
  "signedTransactionInspected",
] as const;

export type MainnetGateKey = typeof MAINNET_GATE_KEYS[number];
export type MainnetGateEvidence = Record<MainnetGateKey, boolean>;

export const CLOSED_MAINNET_GATES: MainnetGateEvidence = {
  networkIdentityVerified: false,
  consensusVmVerified: false,
  walletSessionVerified: false,
  circleStateReconciled: false,
  memberAccountingVerified: false,
  contractAuditApproved: false,
  tokenPolicyVerified: false,
  transactionPlanReviewed: false,
  signedTransactionInspected: false,
  relayAndConfirmationVerified: false,
};

export const MAINNET_GATE_LABELS: Record<MainnetGateKey, string> = {
  networkIdentityVerified: "Mainnet chain identity independently verified",
  consensusVmVerified: "Current BCH Mainnet consensus VM independently validated",
  walletSessionVerified: "WizardConnect and Selene session independently verified",
  circleStateReconciled: "Circle state reconciled with confirmed chain data",
  memberAccountingVerified: "Every member receipt and contribution reconciled",
  contractAuditApproved: "Contract audit and adversarial review approved",
  tokenPolicyVerified: "BCH/CashToken category and token policy verified",
  transactionPlanReviewed: "Transaction plan and fee/change outputs reviewed",
  signedTransactionInspected: "Exact signed bytes decoded and compared with approved intent",
  relayAndConfirmationVerified: "Broadcast relay and independent confirmation verified",
};

export type MainnetFlowPhase =
  | "read-only"
  | "wallet-verification"
  | "state-reconciliation"
  | "transaction-review"
  | "signature-inspection"
  | "broadcast-eligible"
  | "confirmed";

export interface MainnetFlowSnapshot {
  phase: MainnetFlowPhase;
  gates: MainnetGateEvidence;
  /** All outstanding gates, including confirmation which happens after broadcast. */
  missing: MainnetGateKey[];
  /** Outstanding prerequisites which must pass before the first broadcast. */
  missingBeforeBroadcast: (typeof MAINNET_PRE_BROADCAST_GATE_KEYS)[number][];
  canBroadcast: boolean;
}

/**
 * Derives the safe Mainnet phase from verified evidence.
 *
 * Broadcast requires every pre-broadcast gate. Relay/confirmation is deliberately
 * excluded from canBroadcast because it can only be observed after broadcast.
 * The flow reaches "confirmed" only after independent confirmation evidence.
 */
export function evaluateMainnetFlow(
  evidence: Partial<MainnetGateEvidence> = {},
): MainnetFlowSnapshot {
  const gates = { ...CLOSED_MAINNET_GATES, ...evidence };
  const missing = MAINNET_GATE_KEYS.filter((key) => gates[key] !== true);
  const missingBeforeBroadcast = MAINNET_PRE_BROADCAST_GATE_KEYS.filter(
    (key) => gates[key] !== true,
  );
  const canBroadcast = missingBeforeBroadcast.length === 0;

  let phase: MainnetFlowPhase = "read-only";
  const walletReady = gates.networkIdentityVerified && gates.walletSessionVerified;
  const stateReady = walletReady && gates.circleStateReconciled && gates.memberAccountingVerified;
  const policyReady = stateReady && gates.contractAuditApproved && gates.tokenPolicyVerified;
  const planReady = policyReady && gates.transactionPlanReviewed;
  const signatureReady = planReady && gates.signedTransactionInspected;

  if (gates.networkIdentityVerified || gates.walletSessionVerified) {
    phase = "wallet-verification";
  }
  if (walletReady) phase = "state-reconciliation";
  if (policyReady) phase = "transaction-review";
  if (planReady) phase = "signature-inspection";
  if (canBroadcast && signatureReady) phase = "broadcast-eligible";
  if (canBroadcast && gates.relayAndConfirmationVerified) phase = "confirmed";

  return { phase, gates, missing, missingBeforeBroadcast, canBroadcast };
}

/** Reject Mainnet broadcast unless every pre-broadcast gate is satisfied. */
export function assertMainnetBroadcastEligible(
  evidence: Partial<MainnetGateEvidence>,
): void {
  const readiness = evaluateMainnetFlow(evidence);
  if (!readiness.canBroadcast) {
    const labels = readiness.missingBeforeBroadcast.map((key) => MAINNET_GATE_LABELS[key]);
    throw new Error("Mainnet broadcast blocked. Missing: " + labels.join("; "));
  }
}
