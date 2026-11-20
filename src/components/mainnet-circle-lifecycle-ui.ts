export const CIRCLE_STATUS_CHECKING_REASON = "Checking circle status…";
export const CIRCLE_WALLET_REQUIRED_REASON = "Connect Selene to continue.";
export const CIRCLE_PAYOUT_NOT_READY_REASON = "Payout unlocks when every member has paid this round.";
export const CIRCLE_CANCELLATION_UNAVAILABLE_REASON =
  "Cancellation is only possible before anyone pays in round 1.";

type LifecycleButtonReasonState = {
  hasStatus: boolean;
  walletConnected: boolean;
};

export function getPayoutDisabledReason(
  state: LifecycleButtonReasonState & { payoutReady: boolean },
): string | null {
  if (!state.hasStatus) return CIRCLE_STATUS_CHECKING_REASON;
  if (!state.walletConnected) return CIRCLE_WALLET_REQUIRED_REASON;
  if (!state.payoutReady) return CIRCLE_PAYOUT_NOT_READY_REASON;
  return null;
}

export function getCancellationDisabledReason(
  state: LifecycleButtonReasonState & { cancellationAllowed: boolean },
): string | null {
  if (!state.hasStatus) return CIRCLE_STATUS_CHECKING_REASON;
  if (!state.walletConnected) return CIRCLE_WALLET_REQUIRED_REASON;
  if (!state.cancellationAllowed) return CIRCLE_CANCELLATION_UNAVAILABLE_REASON;
  return null;
}

export function getDepositDisabledReason(walletConnected: boolean): string | null {
  return walletConnected ? null : CIRCLE_WALLET_REQUIRED_REASON;
}

/** Creation UI is shown only after the open circle has been closed. */
export function shouldRenderCircleCreation(isCircleOpen: boolean): boolean {
  return !isCircleOpen;
}
