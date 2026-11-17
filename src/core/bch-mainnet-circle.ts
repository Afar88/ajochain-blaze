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
 * Prepare only an unsigned genesis preview. No wallet signing or broadcast
 * occurs here; the Mainnet quorum provider is read-only and the app guard stays
 * closed until independent review and wallet E2E evidence are complete.
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
    transactionSizeBytes: (() => {
      const tx = plan.wc as { transaction?: { inputs?: unknown[]; outputs?: unknown[] } };
      return { inputs: tx.transaction?.inputs?.length ?? 0, outputs: tx.transaction?.outputs?.length ?? 0 };
    })(),
    summary: "Unsigned BCH Mainnet genesis preview only. No signature, deployment or broadcast occurred.",
  };
}
