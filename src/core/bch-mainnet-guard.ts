/**
 * Mainnet BCH transaction kill-switch.
 *
 * Classic BCH construction is ported and can be exercised on Chipnet. Mainnet
 * planning/read-only inspection may be used for review, but this constant must
 * stay false until the contract, network adapter and wallet-signing path have
 * independent evidence and an approved release. Never make this user-controlled.
 */
export const BCH_MAINNET_OPERATIONS_ENABLED = false as const;

/**
 * Release gate for the V3 BCH Mainnet circle workspace only (create, pay,
 * payout, cancel). The server enforces its own BCH_MAINNET_CIRCLE_BROADCAST_ENABLED
 * gate and full verification before relaying. Classic BCH stays locked above.
 */
export const BCH_MAINNET_CIRCLE_SEND_ENABLED = true as const;

export function assertBchTransactionBroadcastAllowed(network: "mainnet" | "chipnet"): void {
  if (network === "mainnet" && !BCH_MAINNET_OPERATIONS_ENABLED) {
    throw new Error(
      "BCH Mainnet broadcasting is still locked. The Classic covenant and transaction " +
      "adapter need independent security review and a real-wallet end-to-end release test. " +
      "Use Chipnet to test circle creation, contributions and payouts.",
    );
  }
}
