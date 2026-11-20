import { describe, expect, it } from "vitest";
import {
  CIRCLE_CANCELLATION_UNAVAILABLE_REASON,
  CIRCLE_PAYOUT_NOT_READY_REASON,
  CIRCLE_STATUS_CHECKING_REASON,
  CIRCLE_WALLET_REQUIRED_REASON,
  getCancellationDisabledReason,
  getDepositDisabledReason,
  getPayoutDisabledReason,
  shouldRenderCircleCreation,
} from "./mainnet-circle-lifecycle-ui";

describe("Mainnet circle lifecycle action reasons", () => {
  it("explains that status is still being checked before a snapshot exists", () => {
    expect(getPayoutDisabledReason({
      hasStatus: false, walletConnected: true, payoutReady: false,
    })).toBe(CIRCLE_STATUS_CHECKING_REASON);
    expect(getCancellationDisabledReason({
      hasStatus: false, walletConnected: true, cancellationAllowed: false,
    })).toBe(CIRCLE_STATUS_CHECKING_REASON);
  });

  it("explains when Selene must be connected", () => {
    expect(getDepositDisabledReason(false)).toBe(CIRCLE_WALLET_REQUIRED_REASON);
    expect(getPayoutDisabledReason({
      hasStatus: true, walletConnected: false, payoutReady: true,
    })).toBe(CIRCLE_WALLET_REQUIRED_REASON);
    expect(getCancellationDisabledReason({
      hasStatus: true, walletConnected: false, cancellationAllowed: true,
    })).toBe(CIRCLE_WALLET_REQUIRED_REASON);
  });

  it("explains why payout and cancellation are unavailable", () => {
    expect(getPayoutDisabledReason({
      hasStatus: true, walletConnected: true, payoutReady: false,
    })).toBe(CIRCLE_PAYOUT_NOT_READY_REASON);
    expect(getCancellationDisabledReason({
      hasStatus: true, walletConnected: true, cancellationAllowed: false,
    })).toBe(CIRCLE_CANCELLATION_UNAVAILABLE_REASON);
  });

  it("returns no reason when an action is otherwise available", () => {
    expect(getPayoutDisabledReason({
      hasStatus: true, walletConnected: true, payoutReady: true,
    })).toBeNull();
    expect(getCancellationDisabledReason({
      hasStatus: true, walletConnected: true, cancellationAllowed: true,
    })).toBeNull();
    expect(getDepositDisabledReason(true)).toBeNull();
  });
});

describe("Mainnet circle create-form visibility", () => {
  it("hides the create form and preview while a circle is open", () => {
    expect(shouldRenderCircleCreation(true)).toBe(false);
  });

  it("shows the create form again after the open circle is closed", () => {
    expect(shouldRenderCircleCreation(false)).toBe(true);
  });
});
