import { describe, expect, it } from "vitest";
import { verifyDecodedTransaction, type TransactionIntent, type DecodedTransaction } from "./transaction-intent";

const intent: TransactionIntent = {
  network: "mainnet",
  maxFeeSatoshis: 1_000n,
  outputs: [{ address: "bitcoincash:qrecipient", satoshis: 50_000n, tokenCategory: "abc", tokenAmount: 7n, nftCommitment: "01ff" }],
};
const decoded: DecodedTransaction = {
  network: "mainnet",
  feeSatoshis: 500n,
  outputs: [{ address: "bitcoincash:qrecipient", satoshis: 50_000n, tokenCategory: "abc", tokenAmount: 7n, nftCommitment: "01ff" }],
};

describe("verifyDecodedTransaction", () => {
  it("accepts an exact match", () => expect(verifyDecodedTransaction(intent, decoded)).toEqual({ ok: true }));
  it("rejects a network mismatch", () => expect(verifyDecodedTransaction(intent, { ...decoded, network: "chipnet" })).toMatchObject({ ok: false, reason: "Network mismatch" }));
  it("rejects a fee above the approved maximum", () => expect(verifyDecodedTransaction(intent, { ...decoded, feeSatoshis: 1_001n })).toMatchObject({ ok: false }));
  it("rejects changed token quantities", () => expect(verifyDecodedTransaction(intent, { ...decoded, outputs: [{ ...decoded.outputs[0], tokenAmount: 8n }] })).toMatchObject({ ok: false }));
  it("rejects output substitution", () => expect(verifyDecodedTransaction(intent, { ...decoded, outputs: [{ ...decoded.outputs[0], address: "bitcoincash:qattacker" }] })).toMatchObject({ ok: false }));
});