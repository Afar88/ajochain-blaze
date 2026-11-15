import { describe, expect, it } from "vitest";
import { PUSD_ASSET } from "./assets";
import { verifyDecodedPusdTransfer, type PusdDecodedTransaction, type PusdTransferIntent } from "./pusd-transfer-verifier";

const txid = "a".repeat(64);
const intent: PusdTransferIntent = {
  recipient: "bitcoincash:recipient",
  amount: 700n,
  changeAddress: "bitcoincash:change",
  maxFeeSatoshis: 500n,
};
const valid: PusdDecodedTransaction = {
  inputs: [
    { txid, vout: 0, satoshis: 2000n, token: { category: PUSD_ASSET.categoryId, amount: 1000n } },
    { txid: "b".repeat(64), vout: 1, satoshis: 1000n },
  ],
  outputs: [
    { address: intent.recipient, satoshis: 1000n, token: { category: PUSD_ASSET.categoryId, amount: 700n } },
    { address: intent.changeAddress, satoshis: 1500n, token: { category: PUSD_ASSET.categoryId, amount: 300n } },
  ],
  feeSatoshis: 500n,
};

describe("plain PUSD transaction verifier", () => {
  it("accepts exact PUSD conservation, recipient amount, change and BCH fee", () => {
    expect(verifyDecodedPusdTransfer(intent, valid)).toEqual({
      ok: true, inputTokenAmount: 1000n, outputTokenAmount: 1000n, feeSatoshis: 500n,
    });
  });

  it("rejects token inflation or burning", () => {
    const changed = { ...valid, outputs: valid.outputs.map((o, i) => i === 1
      ? { ...o, token: { category: PUSD_ASSET.categoryId, amount: 299n } } : o) };
    expect(verifyDecodedPusdTransfer(intent, changed)).toMatchObject({ ok: false, reason: "PUSD token conservation failed." });
  });

  it("rejects recipient substitution and unexpected PUSD change destination", () => {
    const changed = { ...valid, outputs: valid.outputs.map((o, i) => i === 0 ? { ...o, address: "bitcoincash:attacker" } : o) };
    expect(verifyDecodedPusdTransfer(intent, changed)).toMatchObject({ ok: false, reason: "PUSD output is directed to an unapproved address." });
  });

  it("rejects an unapproved token category and any NFT", () => {
    const wrongCategory = { ...valid, inputs: valid.inputs.map((i, n) => n === 0
      ? { ...i, token: { category: "0".repeat(64), amount: 1000n } } : i) };
    expect(verifyDecodedPusdTransfer(intent, wrongCategory)).toMatchObject({ ok: false, reason: "Unexpected non-PUSD token category in inputs." });

    const withNft = { ...valid, inputs: valid.inputs.map((i, n) => n === 0
      ? { ...i, token: { category: PUSD_ASSET.categoryId, amount: 1000n, nft: { capability: "none" as const, commitment: "01" } } } : i) };
    expect(verifyDecodedPusdTransfer(intent, withNft)).toMatchObject({ ok: false, reason: "NFT-bearing inputs are not supported" });
  });

  it("rejects duplicate inputs and BCH value creation", () => {
    const duplicate = { ...valid, inputs: [valid.inputs[0], valid.inputs[0]] };
    expect(verifyDecodedPusdTransfer(intent, duplicate)).toMatchObject({ ok: false, reason: "Duplicate transaction input outpoint." });

    const valueCreation = { ...valid, outputs: valid.outputs.map((o) => ({ ...o, satoshis: o.satoshis + 1n })) };
    expect(verifyDecodedPusdTransfer(intent, valueCreation)).toMatchObject({ ok: false, reason: "Transaction creates BCH value." });
  });

  it("rejects a false or excessive fee and a wrong recipient amount", () => {
    expect(verifyDecodedPusdTransfer(intent, { ...valid, feeSatoshis: 499n })).toMatchObject({ ok: false, reason: "Reported miner fee does not match BCH input/output accounting." });
    expect(verifyDecodedPusdTransfer({ ...intent, maxFeeSatoshis: 499n }, valid)).toMatchObject({ ok: false, reason: "Miner fee exceeds the approved maximum." });
    const wrongAmount = { ...valid, outputs: valid.outputs.map((o, i) => i === 0
      ? { ...o, token: { category: PUSD_ASSET.categoryId, amount: 699n } } : o) };
    expect(verifyDecodedPusdTransfer(intent, wrongAmount)).toMatchObject({ ok: false, reason: "PUSD token conservation failed." });
  });
});
