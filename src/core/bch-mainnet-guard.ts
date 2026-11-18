/**
 * Mainnet BCH transaction kill-switch.
 *
 * BCH V3 now has a read-only signed-transaction preflight on Mainnet. This is
 * not an approved submission/relay path. Keep this constant false until the
 * exact deployed covenant artifacts, provider trust model, Selene/WizardConnect
 * lifecycle, and production operations have independent evidence and written
 * release approval. Never make this user-controlled.
 */
export const BCH_MAINNET_OPERATIONS_ENABLED = false as const;

export function assertBchTransactionBroadcastAllowed(network: "mainnet" | "chipnet"): void {
  if (network === "mainnet" && !BCH_MAINNET_OPERATIONS_ENABLED) {
    throw new Error(
      "BCH Mainnet broadcasting is still locked. V3 has read-only signed-transaction verification, " +
      "but no approved production submission/relay path. Independent covenant audit, provider-operator " +
      "verification, real Selene/WizardConnect lifecycle tests and operational release approval remain " +
      "required. Use Chipnet for real transaction-flow testing.",
    );
  }
}
