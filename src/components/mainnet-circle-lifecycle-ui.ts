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

export const CIRCLE_COMPLETE_MESSAGE = "This circle is complete.";
export const CIRCLE_CANCELLED_MESSAGE = "This circle was cancelled.";

type CircleFinishedState = {
  /** Latest on-chain read says every payout is done. */
  snapshotCompleted?: boolean | null;
  /** Latest on-chain read found the circle closed. */
  snapshotClosedAs?: "completed" | "cancelled" | null;
  /** Status saved on this phone from an earlier read (My circles). */
  savedStatus?: "active" | "completed" | "cancelled" | "unknown" | null;
};

/**
 * When a circle is finished (complete, closed or cancelled) there is nothing left
 * to deposit, pay out or cancel, so the action buttons are replaced by this line.
 * Returns null while the circle is still running.
 */
export function getCircleFinishedMessage(state: CircleFinishedState): string | null {
  if (state.snapshotClosedAs === "cancelled") return CIRCLE_CANCELLED_MESSAGE;
  if (state.snapshotClosedAs === "completed" || state.snapshotCompleted) return CIRCLE_COMPLETE_MESSAGE;
  // Only trust the saved status when no fresh read says otherwise.
  if (state.snapshotCompleted === false) return null;
  if (state.savedStatus === "cancelled") return CIRCLE_CANCELLED_MESSAGE;
  if (state.savedStatus === "completed") return CIRCLE_COMPLETE_MESSAGE;
  return null;
}
