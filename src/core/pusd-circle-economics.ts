import { CASH_TOKEN_MAX_AMOUNT } from "./assets";

export interface PusdCircleEconomics {
  memberCount: number;
  contribution: bigint;
  grossPot: bigint;
  projectFee: bigint;
  firstPayoutReserve: bigint;
  firstRecipientPayout: bigint;
  finalRecipientPayout: bigint;
}

/**
 * Calculate the covenant's exact per-round PUSD amounts in raw CashToken
 * units. The fee is floor(gross pot / 100); the non-final recipient reserves
 * one next contribution; the final recipient reserves nothing.
 */
export function calculatePusdCircleEconomics(
  memberCount: number,
  contribution: bigint,
): PusdCircleEconomics {
  if (!Number.isSafeInteger(memberCount) || memberCount < 2 || memberCount > 5) {
    throw new Error("A PUSD circle needs between 2 and 5 members.");
  }
  if (contribution <= 0n || contribution > CASH_TOKEN_MAX_AMOUNT) {
    throw new Error("PUSD contribution is outside the CashTokens fungible amount range.");
  }
  const grossPot = BigInt(memberCount) * contribution;
  if (grossPot > CASH_TOKEN_MAX_AMOUNT) {
    throw new Error("Gross PUSD pot exceeds the CashTokens fungible amount limit.");
  }
  const projectFee = grossPot / 100n;
  if (projectFee < 1n) {
    throw new Error("The 1% project fee must be at least one raw PUSD unit (0.01 PUSD).");
  }
  const firstPayoutReserve = contribution;
  const firstRecipientPayout = grossPot - projectFee - firstPayoutReserve;
  const finalRecipientPayout = grossPot - projectFee;
  if (firstRecipientPayout <= 0n || finalRecipientPayout <= 0n) {
    throw new Error("PUSD contribution is too small after the project fee and next-round reserve.");
  }
  return {
    memberCount,
    contribution,
    grossPot,
    projectFee,
    firstPayoutReserve,
    firstRecipientPayout,
    finalRecipientPayout,
  };
}
