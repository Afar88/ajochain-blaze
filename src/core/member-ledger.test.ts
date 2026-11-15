import { describe, expect, it } from "vitest";
import { applyMemberPayment, MIN_CIRCLE_MEMBERS } from "./member-ledger";
import type { MemberPayment } from "./member-ledger";

const payment: MemberPayment = {
  paymentId: "tx-001",
  memberId: "member-a",
  walletAddress: "bitcoincash:qmember",
  periodId: "week-1",
  asset: "BCH",
  amountBaseUnits: 150n,
};

describe("member contribution ledger", () => {
  it("tracks each member's contribution and leftover credit", () => {
    const result = applyMemberPayment([], payment, 100n);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.balances[0].creditedBaseUnits).toBe(150n);
      expect(result.balances[0].contributedBaseUnits).toBe(100n);
      expect(result.balances[0].leftoverBaseUnits).toBe(50n);
    }
  });

  it("does not credit a retried payment twice", () => {
    const first = applyMemberPayment([], payment, 100n);
    if (!first.ok) throw new Error(first.reason);
    const retry = applyMemberPayment(first.balances, payment, 100n);
    expect(retry).toMatchObject({ ok: true, duplicate: true });
    if (retry.ok) expect(retry.balances[0].creditedBaseUnits).toBe(150n);
  });

  it("rejects a second payment for the same member and period", () => {
    const first = applyMemberPayment([], payment, 100n);
    if (!first.ok) throw new Error(first.reason);
    const second = applyMemberPayment(first.balances, { ...payment, paymentId: "tx-002" }, 100n);
    expect(second).toMatchObject({ ok: false, reason: "Contribution period already credited" });
  });

  it("does not confuse the same payment identifier across different periods", () => {
    const first = applyMemberPayment([], payment, 100n);
    if (!first.ok) throw new Error(first.reason);
    const nextPeriod = applyMemberPayment(
      first.balances,
      { ...payment, periodId: "week-2" },
      100n,
    );
    expect(nextPeriod.ok).toBe(true);
    if (nextPeriod.ok) {
      expect(nextPeriod.duplicate).toBe(false);
      expect(nextPeriod.balances[0].paymentIds).toEqual(["week-1:tx-001", "week-2:tx-001"]);
    }
  });

  it("keeps different members separate", () => {
    const first = applyMemberPayment([], payment, 100n);
    if (!first.ok) throw new Error(first.reason);
    const second = applyMemberPayment(first.balances, {
      ...payment, paymentId: "tx-002", memberId: "member-b", walletAddress: "bitcoincash:qother",
    }, 100n);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.balances).toHaveLength(2);
  });

  it("treats upper- and lower-case CashAddress forms as the same wallet", () => {
    const first = applyMemberPayment([], payment, 100n);
    if (!first.ok) throw new Error(first.reason);
    const retry = applyMemberPayment(first.balances, {
      ...payment, walletAddress: "BITCOINCASH:QMEMBER",
    }, 100n);
    expect(retry).toMatchObject({ ok: true, duplicate: true });
    if (retry.ok) expect(retry.balances).toHaveLength(1);
  });

  it("rejects blank payment identity fields", () => {
    expect(applyMemberPayment([], { ...payment, paymentId: " " }, 100n))
      .toMatchObject({ ok: false, reason: "Missing payment identity" });
  });

  it("rejects zero or negative contribution amounts", () => {
    expect(applyMemberPayment([], { ...payment, amountBaseUnits: 0n }, 100n))
      .toMatchObject({ ok: false, reason: "Amounts must be positive" });
    expect(applyMemberPayment([], payment, 0n))
      .toMatchObject({ ok: false, reason: "Amounts must be positive" });
  });

  it("sets the minimum circle size to two", () => expect(MIN_CIRCLE_MEMBERS).toBe(2));
});
