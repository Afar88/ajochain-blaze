export type CircleAsset = "BCH" | "PUSD";

export interface MemberPayment {
  paymentId: string;
  memberId: string;
  walletAddress: string;
  periodId: string;
  asset: CircleAsset;
  amountBaseUnits: bigint;
}

export interface MemberBalance {
  memberId: string;
  walletAddress: string;
  asset: CircleAsset;
  creditedBaseUnits: bigint;
  /** Credit currently available toward the next unpaid round. */
  currentRoundCreditBaseUnits: bigint;
  /** Excess credit retained for this member's later rounds only. */
  leftoverBaseUnits: bigint;
  /** Total credit consumed by completed payouts. */
  contributedBaseUnits: bigint;
  paymentIds: string[];
}

export type LedgerResult =
  | { ok: true; duplicate: boolean; balances: MemberBalance[] }
  | { ok: false; reason: string };

export type PayoutResult =
  | { ok: true; balances: MemberBalance[] }
  | { ok: false; reason: string };

/** Add a verified member payment. Multiple partial payments in one round are allowed. */
export function applyMemberPayment(
  current: MemberBalance[],
  payment: MemberPayment,
  contributionDueBaseUnits: bigint,
): LedgerResult {
  const walletAddress = payment.walletAddress.trim().toLowerCase();
  if (!payment.paymentId.trim() || !payment.memberId.trim() || !walletAddress || !payment.periodId.trim()) {
    return { ok: false, reason: "Missing payment identity" };
  }
  if (payment.amountBaseUnits <= 0n || contributionDueBaseUnits <= 0n) {
    return { ok: false, reason: "Amounts must be positive" };
  }

  const paymentKey = `${payment.periodId}:${payment.paymentId}`;
  const existing = current.find(
    (entry) => entry.memberId === payment.memberId.trim() &&
      entry.walletAddress.trim().toLowerCase() === walletAddress &&
      entry.asset === payment.asset,
  );
  if (existing?.paymentIds.includes(paymentKey)) {
    return { ok: true, duplicate: true, balances: current };
  }

  const available = (existing?.currentRoundCreditBaseUnits ?? 0n) +
    (existing?.leftoverBaseUnits ?? 0n) + payment.amountBaseUnits;
  const currentRoundCredit = available >= contributionDueBaseUnits
    ? contributionDueBaseUnits
    : available;
  const leftover = available - currentRoundCredit;

  const next: MemberBalance = {
    memberId: payment.memberId.trim(),
    walletAddress,
    asset: payment.asset,
    creditedBaseUnits: (existing?.creditedBaseUnits ?? 0n) + payment.amountBaseUnits,
    currentRoundCreditBaseUnits: currentRoundCredit,
    leftoverBaseUnits: leftover,
    contributedBaseUnits: existing?.contributedBaseUnits ?? 0n,
    paymentIds: [...(existing?.paymentIds ?? []), paymentKey],
  };
  return {
    ok: true,
    duplicate: false,
    balances: [...current.filter((entry) => entry !== existing), next],
  };
}

/**
 * Apply one completed payout round. Every registered member must independently
 * have a full round contribution. Excess credit rolls forward only for its owner.
 */
export function applyMemberPayout(
  current: MemberBalance[],
  registeredMembers: Array<{ memberId: string; walletAddress: string }>,
  asset: CircleAsset,
  contributionDueBaseUnits: bigint,
): PayoutResult {
  if (contributionDueBaseUnits <= 0n) return { ok: false, reason: "Contribution must be positive" };
  if (registeredMembers.length < MIN_CIRCLE_MEMBERS) return { ok: false, reason: "A circle needs at least two members" };

  const matched = registeredMembers.map((member) => current.find((entry) =>
    entry.memberId === member.memberId &&
    entry.walletAddress.trim().toLowerCase() === member.walletAddress.trim().toLowerCase() &&
    entry.asset === asset,
  ));
  if (matched.some((entry) => !entry || entry.currentRoundCreditBaseUnits < contributionDueBaseUnits)) {
    return { ok: false, reason: "Payout blocked: every member must fund their own contribution for this round" };
  }

  const balances = current.map((entry) => {
    if (entry.asset !== asset) return entry;
    const isRegistered = registeredMembers.some((member) =>
      member.memberId === entry.memberId &&
      member.walletAddress.trim().toLowerCase() === entry.walletAddress.trim().toLowerCase(),
    );
    if (!isRegistered) return entry;
    const remainingAfterRound = entry.currentRoundCreditBaseUnits - contributionDueBaseUnits + entry.leftoverBaseUnits;
    const nextRoundCredit = remainingAfterRound >= contributionDueBaseUnits
      ? contributionDueBaseUnits
      : remainingAfterRound;
    return {
      ...entry,
      currentRoundCreditBaseUnits: nextRoundCredit,
      leftoverBaseUnits: remainingAfterRound - nextRoundCredit,
      contributedBaseUnits: entry.contributedBaseUnits + contributionDueBaseUnits,
    };
  });
  return { ok: true, balances };
}

export const MIN_CIRCLE_MEMBERS = 2;
export const CIRCLE_ASSETS: readonly CircleAsset[] = ["BCH", "PUSD"];
