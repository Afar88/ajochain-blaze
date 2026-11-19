import { MAINNET_PROJECT_TREASURY_ADDRESS } from "./project-treasury";
import {
  planV2FeeGenesis,
  validateV2FeeCircleDraft,
  type V2FeeCircleDraft,
} from "./v2-fee-bch";

/**
 * Mainnet-only BCH V3 auto-reserve circle draft.
 * The selected immutable V3 covenant is shared with the tested Chipnet
 * implementation, but Mainnet construction always pins the shared treasury.
 */
export type BchMainnetCircleDraft = Omit<V2FeeCircleDraft, "network" | "covenant" | "treasury">;

export function createBchMainnetCircleDraft(
  input: BchMainnetCircleDraft,
): V2FeeCircleDraft {
  const draft: V2FeeCircleDraft = {
    ...input,
    version: 2,
    network: "mainnet",
    covenant: "fee-v3-auto-reserve-mainnet",
    treasury: MAINNET_PROJECT_TREASURY_ADDRESS,
  };
  validateV2FeeCircleDraft(draft);
  return draft;
}

/**
 * Prepare an unsigned BCH Mainnet genesis transaction plan.
 * Signing and broadcasting are separate workspace actions; the server verifies
 * the signed transaction before the one-shot BCH relay. This function itself
 * does not sign or broadcast and does not alter the BCH/PUSD feature guards.
 */
export async function prepareBchMainnetCircleGenesisPreview(
  input: BchMainnetCircleDraft,
  initiatorAddress: string,
) {
  const draft = createBchMainnetCircleDraft(input);
  const plan = await planV2FeeGenesis(draft, initiatorAddress);
  return {
    params: plan.params,
    contractAddress: plan.contract.address,
    stateCategory: plan.params.stateCategory,
    feeEstimate: plan.feeEstimate,
    estimatedChange: plan.estimatedChange,
    transactionInputCount: plan.walletInputs.length,
    transactionOutputCount: draft.members.length * 2 + 3,
    wc: plan.wc,
    walletInputs: plan.walletInputs,
    summary: "Unsigned BCH Mainnet genesis preview only. No signature, deployment or broadcast occurred.",
  };
}
