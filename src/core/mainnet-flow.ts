/**
 * Mainnet release gate.
 *
 * This is deliberately fail-closed: a UI selection or wallet connection alone
 * can never authorize a mainnet transaction. Every evidence item must be
 * independently produced by the relevant verification step.
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
  missing: MainnetGateKey[];
  canBroadcast: boolean;
}

/**
 * Derives the only safe mainnet phase from verified evidence.
 * Broadcast remains unavailable until all release gates are true and the
 * exact transaction has been reviewed and signed bytes independently checked.
 */
export function evaluateMainnetFlow(
  evidence: Partial<MainnetGateEvidence> = {},
): MainnetFlowSnapshot {
  const gates = { ...CLOSED_MAINNET_GATES, ...evidence };
  const missing = MAINNET_GATE_KEYS.filter((key) => gates[key] !== true);
  const canBroadcast = missing.length === 0;

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
  if (canBroadcast && signatureReady && gates.relayAndConfirmationVerified) {
    phase = "broadcast-eligible";
  }

  return { phase, gates, missing, canBroadcast };
}

/** Explicitly reject broadcast unless the complete release evidence is present. */
export function assertMainnetBroadcastEligible(
  evidence: Partial<MainnetGateEvidence>,
): void {
  const readiness = evaluateMainnetFlow(evidence);
  if (!readiness.canBroadcast) {
    const labels = readiness.missing.map((key) => MAINNET_GATE_LABELS[key]);
    throw new Error("Mainnet broadcast blocked. Missing: " + labels.join("; "));
  }
}
