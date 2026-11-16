/**
 * PUSD mainnet spend kill-switch.
 *
 * This is intentionally a compile-time false constant, not an environment or
 * local-storage setting. Do not change it until every item in
 * docs/PUSD_MAINNET_RELEASE_CHECKLIST.md has independent evidence and review.
 * Read-only display and transaction construction experiments are not authority
 * to sign or broadcast real-value transactions.
 */
export const PUSD_MAINNET_SPENDING_ENABLED = false as const;

export interface PusdMainnetSpendContext {
  network: "mainnet" | "chipnet";
  asset: "PUSD" | "BCH";
}

/** Fail closed for every PUSD spend while the mainnet release is unapproved. */
export function assertPusdMainnetSpendingAllowed(context: PusdMainnetSpendContext): void {
  if (context.asset === "PUSD" && context.network === "mainnet" &&
      !PUSD_MAINNET_SPENDING_ENABLED) {
    throw new Error(
      "PUSD mainnet spending is disabled: raw CashTokens verification, authenticated UTXO provenance, independent security review, and release approval are incomplete.",
    );
  }
}
