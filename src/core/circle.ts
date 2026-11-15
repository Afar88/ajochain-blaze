import { CIRCLE_ASSETS, MIN_CIRCLE_MEMBERS, type CircleAsset } from "./member-ledger";

export type ContributionFrequency = "daily" | "weekly" | "monthly";

export interface CircleMemberDraft {
  name: string;
  walletAddress?: string;
}

export interface CircleDraftInput {
  name: string;
  asset: CircleAsset;
  contributionAmount: string;
  frequency: ContributionFrequency;
  members: CircleMemberDraft[];
}

export interface CircleDraftValidation {
  valid: boolean;
  errors: string[];
  needsWalletVerification: boolean;
}

/**
 * Validates a local-only circle proposal. It intentionally does not create a
 * contract, sign a transaction, or imply that participant wallets are verified.
 */
export function validateCircleDraft(input: CircleDraftInput): CircleDraftValidation {
  const errors: string[] = [];
  const name = input.name.trim();

  if (name.length < 3 || name.length > 40) {
    errors.push("Circle name must be between 3 and 40 characters.");
  }
  if (!CIRCLE_ASSETS.includes(input.asset)) {
    errors.push("Choose BCH or PUSD.");
  }
  if (!/^\\d+(?:\\.\\d+)?$/.test(input.contributionAmount.trim()) ||
      !/[1-9]/.test(input.contributionAmount.replace(/\\./g, ""))) {
    errors.push("Enter a contribution amount greater than zero.");
  }
  if (!["daily", "weekly", "monthly"].includes(input.frequency)) {
    errors.push("Choose a valid contribution schedule.");
  }
  if (input.members.length < MIN_CIRCLE_MEMBERS) {
    errors.push(`A circle needs at least ${MIN_CIRCLE_MEMBERS} members.`);
  }
  if (input.members.length > 50) {
    errors.push("A circle can have at most 50 members in this setup.");
  }

  const names = input.members.map((member) => member.name.trim().toLocaleLowerCase());
  if (names.some((memberName) => !memberName)) {
    errors.push("Every member needs a display name.");
  }
  if (new Set(names).size !== names.length) {
    errors.push("Member display names must be unique.");
  }

  const addresses = input.members
    .map((member) => member.walletAddress?.trim().toLowerCase())
    .filter((address): address is string => Boolean(address));
  if (new Set(addresses).size !== addresses.length) {
    errors.push("A wallet address cannot be assigned to more than one member.");
  }

  return {
    valid: errors.length === 0,
    errors,
    needsWalletVerification: input.members.some((member) => !member.walletAddress?.trim()),
  };
}
