import { describe, expect, it } from "vitest";
import { applyMemberPayment, applyMemberPayout, MIN_CIRCLE_MEMBERS } from "./member-ledger";
import type { MemberBalance, MemberPayment } from "./member-ledger";

const payment: MemberPayment = {
  paymentId: "tx-001", memberId: "member-a", walletAddress: "bitcoincash:qmember",
  periodId: "round-1", asset: "BCH", amountBaseUnits: 150n,
};
const members = [
  { memberId: "member-a", walletAddress: "bitcoincash:qmember" },
  { memberId: "member-b", walletAddress: "bitcoincash:qother" },
];
function addMemberB(current: MemberBalance[], paymentId = "tx-b1") {
  const result = applyMemberPayment(current, {
    ...payment, paymentId, periodId: paymentId, memberId: "member-b", walletAddress: "bitcoincash:qother", amountBaseUnits: 100n,
  }, 100n);
  if (!result.ok) throw new Error(result.reason);
  return result.balances;
}

describe("member contribution and payout accounting", () => {
  it("tracks each member's own credit and leftover", () => {
    const result = applyMemberPayment([], payment, 100n);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.balances[0].creditedBaseUnits).toBe(150n);
      expect(result.balances[0].currentRoundCreditBaseUnits).toBe(100n);
      expect(result.balances[0].leftoverBaseUnits).toBe(50n);
    }
  });

  it("allows partial top-ups within the same round", () => {
    const first = applyMemberPayment([], { ...payment, amountBaseUnits: 40n }, 100n);
    if (!first.ok) throw new Error(first.reason);
    const second = applyMemberPayment(first.balances, { ...payment, paymentId: "tx-002", amountBaseUnits: 60n }, 100n);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.balances[0].currentRoundCreditBaseUnits).toBe(100n);
  });

  it("does not credit a retried payment twice", () => {
    const first = applyMemberPayment([], payment, 100n);
    if (!first.ok) throw new Error(first.reason);
    const retry = applyMemberPayment(first.balances, payment, 100n);
    expect(retry).toMatchObject({ ok: true, duplicate: true });
    if (retry.ok) expect(retry.balances[0].creditedBaseUnits).toBe(150n);
  });

  it("does not let one transaction credit two different members", () => {
    const first = applyMemberPayment([], payment, 100n);
    if (!first.ok) throw new Error(first.reason);
    const replay = applyMemberPayment(first.balances, {
      ...payment, memberId: "member-b", walletAddress: "bitcoincash:qother",
    }, 100n);
    expect(replay).toMatchObject({ ok: true, duplicate: true });
    if (replay.ok) expect(replay.balances).toHaveLength(1);
  });

  it("does not credit the same transaction again under a different period label", () => {
    const first = applyMemberPayment([], payment, 100n);
    if (!first.ok) throw new Error(first.reason);
    const retry = applyMemberPayment(first.balances, {
      ...payment, periodId: "round-2",
    }, 100n);
    expect(retry).toMatchObject({ ok: true, duplicate: true });
  });

  it("treats upper- and lower-case CashAddress forms as the same wallet", () => {
    const first = applyMemberPayment([], payment, 100n);
    if (!first.ok) throw new Error(first.reason);
    const retry = applyMemberPayment(first.balances, { ...payment, walletAddress: "BITCOINCASH:QMEMBER" }, 100n);
    expect(retry).toMatchObject({ ok: true, duplicate: true });
  });

  it("rejects blank payment identity and non-positive amounts", () => {
    expect(applyMemberPayment([], { ...payment, paymentId: " " }, 100n))
      .toMatchObject({ ok: false, reason: "Missing payment identity" });
    expect(applyMemberPayment([], { ...payment, amountBaseUnits: 0n }, 100n))
      .toMatchObject({ ok: false, reason: "Amounts must be positive" });
  });

  it("rejects duplicate registered member identities in a payout", () => {
    const first = applyMemberPayment([], payment, 100n);
    if (!first.ok) throw new Error(first.reason);
    const duplicateMembers = [members[0], { ...members[0] }];
    expect(applyMemberPayout(first.balances, duplicateMembers, "BCH", 100n))
      .toMatchObject({ ok: false, reason: "Registered members must have unique identities and wallets" });
  });

  it("blocks payout when even one member has not funded their own round", () => {
    const first = applyMemberPayment([], payment, 100n);
    if (!first.ok) throw new Error(first.reason);
    expect(applyMemberPayout(first.balances, members, "BCH", 100n))
      .toMatchObject({ ok: false, reason: "Payout blocked: every member must fund their own contribution for this round" });
  });

  it("requires the recipient to contribute again after receiving the first payout", () => {
    const first = applyMemberPayment([], payment, 100n);
    if (!first.ok) throw new Error(first.reason);
    const bothFunded = addMemberB(first.balances);
    const roundOne = applyMemberPayout(bothFunded, members, "BCH", 100n);
    expect(roundOne.ok).toBe(true);
    if (!roundOne.ok) return;
    expect(roundOne.balances.find((b) => b.memberId === "member-a")?.currentRoundCreditBaseUnits).toBe(50n);
    expect(applyMemberPayout(roundOne.balances, members, "BCH", 100n)).toMatchObject({ ok: false });
    const next = applyMemberPayment(roundOne.balances, { ...payment, paymentId: "tx-a2", periodId: "round-2", amountBaseUnits: 50n }, 100n);
    if (!next.ok) throw new Error(next.reason);
    const nextBoth = addMemberB(next.balances, "tx-b2");
    const secondPayout = applyMemberPayout(nextBoth, members, "BCH", 100n);
    expect(secondPayout.ok, secondPayout.ok ? undefined : secondPayout.reason).toBe(true);
  });

  it("keeps overpayment credit with the same member across payouts", () => {
    const a = applyMemberPayment([], { ...payment, amountBaseUnits: 250n }, 100n);
    if (!a.ok) throw new Error(a.reason);
    const both = addMemberB(a.balances);
    const paid = applyMemberPayout(both, members, "BCH", 100n);
    expect(paid.ok).toBe(true);
    if (paid.ok) {
      const aBalance = paid.balances.find((b) => b.memberId === "member-a")!;
      expect(aBalance.currentRoundCreditBaseUnits).toBe(100n);
      expect(aBalance.leftoverBaseUnits).toBe(50n);
    }
  });

  it("keeps different members separate and minimum circle size at two", () => {
    const first = applyMemberPayment([], payment, 100n);
    if (!first.ok) throw new Error(first.reason);
    const second = addMemberB(first.balances);
    expect(second).toHaveLength(2);
    expect(MIN_CIRCLE_MEMBERS).toBe(2);
  });
});
