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
  contributedBaseUnits: bigint;
  leftoverBaseUnits: bigint;
  paymentIds: string[];
}

export type LedgerResult =
  | { ok: true; duplicate: boolean; balances: MemberBalance[] }
  | { ok: false; reason: string };

/**
 * Applies one confirmed contribution to the individual member's ledger.
 * Payment IDs are namespaced by period for safe retries. A period can be
 * credited only once per member, wallet and asset. Amounts stay in base units.
 */
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
    (entry) => entry.memberId === payment.memberId &&
      entry.walletAddress.trim().toLowerCase() === walletAddress &&
      entry.asset === payment.asset,
  );

  if (existing?.paymentIds.includes(paymentKey)) {
    return { ok: true, duplicate: true, balances: current };
  }

  const periodAlreadyCredited = current.some(
    (entry) => entry.memberId === payment.memberId &&
      entry.walletAddress === payment.walletAddress &&
      entry.asset === payment.asset &&
      entry.paymentIds.some((id) => id.startsWith(`${payment.periodId}:`)),
  );
  if (periodAlreadyCredited) {
    return { ok: false, reason: "Contribution period already credited" };
  }

  const priorCredit = existing?.leftoverBaseUnits ?? 0n;
  const available = priorCredit + payment.amountBaseUnits;
  const contributed = available >= contributionDueBaseUnits
    ? contributionDueBaseUnits
    : available;
  const leftover = available - contributed;

  const next: MemberBalance = {
    memberId: payment.memberId,
    walletAddress,
    asset: payment.asset,
    creditedBaseUnits: (existing?.creditedBaseUnits ?? 0n) + payment.amountBaseUnits,
    contributedBaseUnits: (existing?.contributedBaseUnits ?? 0n) + contributed,
    leftoverBaseUnits: leftover,
    paymentIds: [...(existing?.paymentIds ?? []), paymentKey],
  };

  return {
    ok: true,
    duplicate: false,
    balances: [...current.filter((entry) => entry !== existing), next],
  };
}

export const MIN_CIRCLE_MEMBERS = 2;
export const CIRCLE_ASSETS: readonly CircleAsset[] = ["BCH", "PUSD"];
