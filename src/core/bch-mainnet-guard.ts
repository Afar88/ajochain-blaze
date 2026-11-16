/**
 * Mainnet BCH transaction kill-switch.
 *
 * Classic BCH construction is ported and can be exercised on Chipnet. Mainnet
 * planning/read-only inspection may be used for review, but this constant must
 * stay false until the contract, network adapter and wallet-signing path have
 * independent evidence and an approved release. Never make this user-controlled.
 */
export const BCH_MAINNET_OPERATIONS_ENABLED = false as const;

export function assertBchTransactionBroadcastAllowed(network: "mainnet" | "chipnet"): void {
  if (network === "mainnet" && !BCH_MAINNET_OPERATIONS_ENABLED) {
    throw new Error(
      "BCH Mainnet broadcasting is still locked. The Classic covenant and transaction " +
      "adapter need independent security review and a real-wallet end-to-end release test. " +
      "Use Chipnet to test circle creation, contributions and payouts.",
    );
  }
}
