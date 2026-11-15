import { CASH_TOKEN_MAX_AMOUNT, PUSD_ASSET, isPusdCategoryId } from "./assets";

export interface DecodedCashToken {
  category: string;
  amount: bigint;
  nft?: { capability: "none" | "mutable" | "minting"; commitment: string };
}

export interface DecodedPusdInput {
  txid: string;
  vout: number;
  satoshis: bigint;
  token?: DecodedCashToken;
}

export interface DecodedPusdOutput {
  address: string;
  satoshis: bigint;
  token?: DecodedCashToken;
}

export interface PusdTransferIntent {
  recipient: string;
  amount: bigint;
  /** Destination for fungible PUSD remainder. */
  changeAddress: string;
  /** Separate BCH-only change destination. Omit to fail closed to the two known destinations. */
  bchChangeAddress?: string;
  maxFeeSatoshis: bigint;
}

export interface PusdDecodedTransaction {
  /** Must represent every input and output decoded from the exact transaction bytes. */
  inputs: DecodedPusdInput[];
  outputs: DecodedPusdOutput[];
  /** Independently calculated from all input and output satoshi values. */
  feeSatoshis: bigint;
}

export type PusdVerification =
  | { ok: true; inputTokenAmount: bigint; outputTokenAmount: bigint; feeSatoshis: bigint }
  | { ok: false; reason: string };

function fail(reason: string): PusdVerification {
  return { ok: false, reason };
}

/**
 * Conservative guard for a plain PUSD transfer only.
 *
 * It rejects NFTs and every non-PUSD CashToken category. It does not decode raw
 * transaction bytes, establish UTXO provenance, validate signatures, or prove a
 * covenant transition. Call only after an independent decoder has supplied the
 * complete input/output set from the exact transaction bytes being reviewed.
 */
export function verifyDecodedPusdTransfer(
  intent: PusdTransferIntent,
  decoded: PusdDecodedTransaction,
): PusdVerification {
  if (!intent.recipient || !intent.changeAddress || intent.recipient === intent.changeAddress) {
    return fail("Recipient and token-change addresses must be distinct and non-empty.");
  }
  if (intent.bchChangeAddress &&
      (intent.bchChangeAddress === intent.recipient || intent.bchChangeAddress === intent.changeAddress)) {
    return fail("BCH-only change must use a destination distinct from recipient and PUSD change.");
  }
  if (intent.amount <= 0n || intent.amount > CASH_TOKEN_MAX_AMOUNT) {
    return fail("Requested PUSD amount is outside the CashTokens fungible amount range.");
  }
  if (intent.maxFeeSatoshis < 0n) return fail("Maximum fee cannot be negative.");
  if (decoded.inputs.length === 0 || decoded.outputs.length === 0) {
    return fail("Transaction must contain inputs and outputs.");
  }

  const approvedBchDestinations = new Set([
    intent.recipient,
    intent.changeAddress,
    ...(intent.bchChangeAddress ? [intent.bchChangeAddress] : []),
  ]);
  const seen = new Set<string>();
  let inputPusd = 0n;
  let inputSatoshis = 0n;
  for (const input of decoded.inputs) {
    if (!/^[0-9a-f]{64}$/i.test(input.txid) || !Number.isSafeInteger(input.vout) || input.vout < 0) {
      return fail("Input contains an invalid outpoint.");
    }
    const outpoint = input.txid.toLowerCase() + ":" + input.vout;
    if (seen.has(outpoint)) return fail("Duplicate transaction input outpoint.");
    seen.add(outpoint);
    if (input.satoshis < 0n) return fail("Input BCH value cannot be negative.");
    inputSatoshis += input.satoshis;

    if (input.token) {
      if (!isPusdCategoryId(input.token.category)) return fail("Unexpected non-PUSD token category in inputs.");
      if (input.token.nft) return fail("NFT-bearing inputs are not supported by this plain-transfer verifier.");
      if (input.token.amount <= 0n || input.token.amount > CASH_TOKEN_MAX_AMOUNT) {
        return fail("Input contains an invalid PUSD fungible amount.");
      }
      inputPusd += input.token.amount;
      if (inputPusd > CASH_TOKEN_MAX_AMOUNT) return fail("Aggregate PUSD inputs exceed the CashTokens amount limit.");
    }
  }

  let outputPusd = 0n;
  let outputSatoshis = 0n;
  let recipientPusd = 0n;
  let changePusd = 0n;
  for (const output of decoded.outputs) {
    if (!output.address || output.satoshis < 0n) return fail("Output address or BCH value is invalid.");
    if (!approvedBchDestinations.has(output.address)) {
      return fail("BCH output is directed to an unapproved address.");
    }
    outputSatoshis += output.satoshis;
    if (!output.token) continue;
    if (!isPusdCategoryId(output.token.category)) return fail("Unexpected non-PUSD token category in outputs.");
    if (output.token.nft) return fail("NFT-bearing outputs are not supported by this plain-transfer verifier.");
    if (output.token.amount <= 0n || output.token.amount > CASH_TOKEN_MAX_AMOUNT) {
      return fail("Output contains an invalid PUSD fungible amount.");
    }
    outputPusd += output.token.amount;
    if (outputPusd > CASH_TOKEN_MAX_AMOUNT) return fail("Aggregate PUSD outputs exceed the CashTokens amount limit.");
    if (output.address === intent.recipient) recipientPusd += output.token.amount;
    else if (output.address === intent.changeAddress) changePusd += output.token.amount;
    else return fail("PUSD output is directed to an unapproved address.");
  }

  if (inputPusd !== outputPusd) return fail("PUSD token conservation failed.");
  if (recipientPusd !== intent.amount) return fail("Recipient PUSD amount does not match the approved intent.");
  if (changePusd !== inputPusd - intent.amount) return fail("PUSD change does not match the exact remainder.");
  if (inputSatoshis < outputSatoshis) return fail("Transaction creates BCH value.");
  const calculatedFee = inputSatoshis - outputSatoshis;
  if (decoded.feeSatoshis !== calculatedFee) return fail("Reported miner fee does not match BCH input/output accounting.");
  if (calculatedFee > intent.maxFeeSatoshis) return fail("Miner fee exceeds the approved maximum.");

  return { ok: true, inputTokenAmount: inputPusd, outputTokenAmount: outputPusd, feeSatoshis: calculatedFee };
}

export function assertPusdTransferCategory(category: string): void {
  if (!isPusdCategoryId(category)) {
    throw new Error("Unexpected CashToken category. Expected ParyonUSD " + PUSD_ASSET.categoryId + ".");
  }
}
