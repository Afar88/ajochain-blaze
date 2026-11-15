export interface OutputIntent {
  address: string;
  satoshis: bigint;
  tokenCategory?: string;
  tokenAmount?: bigint;
  nftCommitment?: string;
}

export interface TransactionIntent {
  network: "mainnet" | "chipnet";
  outputs: OutputIntent[];
  maxFeeSatoshis: bigint;
}

export interface DecodedOutput {
  address: string;
  satoshis: bigint;
  tokenCategory?: string;
  tokenAmount?: bigint;
  nftCommitment?: string;
}

export interface DecodedTransaction {
  network: "mainnet" | "chipnet";
  outputs: DecodedOutput[];
  feeSatoshis: bigint;
}

/**
 * Compares a decoded transaction summary with the approved intent.
 * This is a fail-closed domain guard, not a raw transaction decoder or signer.
 * A production wallet adapter must decode the exact signed bytes independently.
 */
export function verifyDecodedTransaction(
  intent: TransactionIntent,
  decoded: DecodedTransaction,
): { ok: true } | { ok: false; reason: string } {
  if (intent.network !== decoded.network) return { ok: false, reason: "Network mismatch" };
  if (decoded.feeSatoshis < 0n || decoded.feeSatoshis > intent.maxFeeSatoshis) {
    return { ok: false, reason: "Fee exceeds approved maximum" };
  }
  if (intent.outputs.length !== decoded.outputs.length) {
    return { ok: false, reason: "Output count mismatch" };
  }

  for (let i = 0; i < intent.outputs.length; i += 1) {
    const expected = intent.outputs[i];
    const actual = decoded.outputs[i];
    if (expected.address !== actual.address) return { ok: false, reason: `Output ${i + 1} address mismatch` };
    if (expected.satoshis !== actual.satoshis) return { ok: false, reason: `Output ${i + 1} BCH amount mismatch` };
    if ((expected.tokenCategory ?? "") !== (actual.tokenCategory ?? "")) return { ok: false, reason: `Output ${i + 1} token category mismatch` };
    if ((expected.tokenAmount ?? 0n) !== (actual.tokenAmount ?? 0n)) return { ok: false, reason: `Output ${i + 1} token amount mismatch` };
    if ((expected.nftCommitment ?? "") !== (actual.nftCommitment ?? "")) return { ok: false, reason: `Output ${i + 1} NFT commitment mismatch` };
  }

  return { ok: true };
}