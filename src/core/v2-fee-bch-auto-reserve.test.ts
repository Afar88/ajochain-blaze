import { describe, it, expect } from "vitest";
import {
  Contract,
  MockNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
  randomUtxo,
  type Artifact,
  type SpendableUtxo,
} from "cashscript";
import { hash160, secp256k1, hexToBin } from "@bitauth/libauth";
import autoReserveJson from "../../contracts/AjoCircleV3AutoReserve.json" with { type: "json" };
import { pkhToAddress } from "./bch-address";
import { v2FeeCreditFromCommitment, summarizeV2FeeMemberAccounting } from "./v2-fee-bch";

const artifact = autoReserveJson as unknown as Artifact;
const CATEGORY = "ab".repeat(32);
const CONTRIBUTION = 200_000n;
const MAX_FEE = 10_000n;
const DUST = 1_000n;

function key(n: number) {
  const privateKey = new Uint8Array(32);
  privateKey[31] = n;
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey) as Uint8Array;
  return { privateKey, publicKey, pkh: hash160(publicKey), signer: new SignatureTemplate(privateKey) };
}

const members = [key(11), key(12)];
const initiator = key(18);
const treasury = key(19);

function makeContract(provider: MockNetworkProvider) {
  return new Contract(artifact, [
    members[0].pkh, members[1].pkh,
    new Uint8Array(20), new Uint8Array(20), new Uint8Array(20),
    2n, CONTRIBUTION, MAX_FEE, hexToBin(CATEGORY).reverse(),
    initiator.pkh, treasury.pkh,
  ], { provider, contractType: "p2sh32" });
}

function commitment(index: number, credit: bigint) {
  return "52" + index.toString(16).padStart(2, "0") +
    credit.toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
}

function addGenesis(provider: MockNetworkProvider, contract: Contract) {
  provider.addUtxo(contract.address, randomUtxo({
    satoshis: DUST,
    token: { category: CATEGORY, amount: 0n, nft: { capability: "minting", commitment: "540000" } },
  }));
  for (let index = 0; index < members.length; index++) {
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: DUST,
      token: { category: CATEGORY, amount: 0n, nft: { capability: "none", commitment: commitment(index, 0n) } },
    }));
  }
}

async function readCircle(contract: Contract) {
  const utxos = await contract.getUtxos();
  const state = utxos.find((utxo) => utxo.token?.nft?.capability === "minting") as SpendableUtxo;
  const receipts = members.map((_, index) => utxos.find((utxo) =>
    utxo.token?.nft?.commitment?.startsWith("52" + index.toString(16).padStart(2, "0")),
  ) as SpendableUtxo);
  return { state, receipts };
}

async function depositCurrentRound(provider: MockNetworkProvider, contract: Contract, index: number) {
  const { state, receipts } = await readCircle(contract);
  const address = pkhToAddress(members[index].pkh, "chipnet");
  const funding = provider.addUtxo(address, randomUtxo({ satoshis: CONTRIBUTION + 20_000n }));
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.addCredit(BigInt(index), CONTRIBUTION))
    .addInput(receipts[index], contract.unlock.addCredit(BigInt(index), CONTRIBUTION))
    .addInput(funding, members[index].signer.unlockP2PKH())
    .addOutput({
      to: contract.tokenAddress,
      amount: state.satoshis + CONTRIBUTION,
      token: { category: CATEGORY, amount: 0n, nft: { capability: "minting", commitment: state.token!.nft!.commitment } },
    })
    .addOutput({
      to: contract.tokenAddress,
      amount: receipts[index].satoshis,
      token: { category: CATEGORY, amount: 0n, nft: { capability: "none", commitment: commitment(index, v2FeeCreditFromCommitment(receipts[index].token!.nft!.commitment) + CONTRIBUTION) } },
    })
    .addOutput({ to: address, amount: 10_000n });
  await builder.send();
}

async function triggerPayout(provider: MockNetworkProvider, contract: Contract) {
  const { state, receipts } = await readCircle(contract);
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2, 4), 16);
  const gross = BigInt(members.length) * CONTRIBUTION;
  const projectFee = gross / 100n;
  const reserve = BigInt(members.length - round - 1) * CONTRIBUTION;
  const payout = gross - projectFee - reserve;
  const feeAddress = pkhToAddress(initiator.pkh, "chipnet");
  const feeFunding = provider.addUtxo(feeAddress, randomUtxo({ satoshis: 20_000n }));
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.payout())
    .addInputs(receipts, contract.unlock.payout())
    .addInput(feeFunding, initiator.signer.unlockP2PKH())
    .addOutput({
      to: contract.tokenAddress,
      amount: state.satoshis - gross + reserve,
      token: { category: CATEGORY, amount: 0n, nft: { capability: "minting", commitment: "54" + (round + 1).toString(16).padStart(2, "0") + "01" } },
    });
  for (let index = 0; index < receipts.length; index++) {
    const oldCredit = v2FeeCreditFromCommitment(receipts[index].token!.nft!.commitment);
    const nextCredit = oldCredit - CONTRIBUTION + (index === round ? reserve : 0n);
    builder.addOutput({
      to: contract.tokenAddress,
      amount: receipts[index].satoshis,
      token: { category: CATEGORY, amount: 0n, nft: { capability: "none", commitment: commitment(index, nextCredit) } },
    });
  }
  builder.addOutput({ to: pkhToAddress(treasury.pkh, "chipnet"), amount: projectFee });
  builder.addOutput({ to: pkhToAddress(members[round].pkh, "chipnet"), amount: payout });
  builder.addOutput({ to: feeAddress, amount: feeFunding.satoshis - 8_000n });
  await builder.send();
  return { reserve, payout, gross, projectFee };
}

describe("AjoChain V3 automatic future-contribution reserve covenant", () => {
  it("retains every future installment from the recipient's payout and funds their receipt", async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    await depositCurrentRound(provider, contract, 0);
    await depositCurrentRound(provider, contract, 1);

    const first = await triggerPayout(provider, contract);
    expect(first.reserve).toBe(CONTRIBUTION);
    expect(first.payout).toBe(first.gross - first.projectFee - CONTRIBUTION);

    let circle = await readCircle(contract);
    expect(circle.state.satoshis).toBe(DUST + CONTRIBUTION);
    expect(v2FeeCreditFromCommitment(circle.receipts[0].token!.nft!.commitment)).toBe(CONTRIBUTION);
    expect(v2FeeCreditFromCommitment(circle.receipts[1].token!.nft!.commitment)).toBe(0n);
    expect(circle.state.token!.nft!.commitment).toBe("540101");

    // The unpaid member funds only the current installment. The first recipient
    // already has the full remaining installment reserved from their payout.
    await depositCurrentRound(provider, contract, 1);
    const second = await triggerPayout(provider, contract);
    expect(second.reserve).toBe(0n);
    expect(second.payout).toBe(second.gross - second.projectFee);

    circle = await readCircle(contract);
    expect(circle.state.satoshis).toBe(DUST);
    expect(v2FeeCreditFromCommitment(circle.receipts[0].token!.nft!.commitment)).toBe(0n);
    expect(v2FeeCreditFromCommitment(circle.receipts[1].token!.nft!.commitment)).toBe(0n);
    expect(circle.state.token!.nft!.commitment).toBe("540201");
  });

  it("blocks the next payout if an unpaid member has not funded the current round", async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    await depositCurrentRound(provider, contract, 0);
    await depositCurrentRound(provider, contract, 1);
    await triggerPayout(provider, contract);
    // Member 0 is secured by the first payout's retained contribution.
    // Member 1 has not funded the next round, so the contract must reject it.
    await expect(triggerPayout(provider, contract)).rejects.toThrow();
  });

  it("reserves all four remaining contributions for the first recipient in a five-member circle", () => {
    const params = {
      version: 2 as const,
      covenant: "fee-v3-auto-reserve" as const,
      name: "Five-member reserve test",
      network: "chipnet" as const,
      members: ["member-0", "member-1", "member-2", "member-3", "member-4"],
      contribution: CONTRIBUTION,
      maxFee: MAX_FEE,
      stateCategory: CATEGORY,
      initiator: "initiator",
      treasury: "treasury",
    };
    const gross = 5n * CONTRIBUTION;
    const projectFee = gross / 100n;
    const futureReserve = 4n * CONTRIBUTION;
    const ledger = summarizeV2FeeMemberAccounting(
      params,
      1,
      [futureReserve, 0n, 0n, 0n, 0n],
    );
    expect(ledger[0].requiredForNextPayout).toBe(futureReserve);
    expect(ledger[0].fullySecured).toBe(true);
    expect(ledger[0].payoutAmountReceived).toBe(gross - projectFee - futureReserve);
    expect(ledger[0].payoutAmountReceived).toBe(190_000n);
    expect(ledger[0].remainingContributionCommitment).toBe(0n);
    expect(ledger.slice(1).every((member) =>
      member.requiredForNextPayout === CONTRIBUTION && !member.fullySecured,
    )).toBe(true);
  });

  it("reports only current-round funding for unpaid members and all future reserves for recipients", () => {
    const params = {
      version: 2 as const,
      covenant: "fee-v3-auto-reserve" as const,
      name: "Test circle",
      network: "chipnet" as const,
      members: ["member-0", "member-1"],
      contribution: CONTRIBUTION,
      maxFee: MAX_FEE,
      stateCategory: CATEGORY,
      initiator: "initiator",
      treasury: "treasury",
    };
    const snapshot = summarizeV2FeeMemberAccounting(params, 1, [CONTRIBUTION, 0n]);
    expect(snapshot[0].requiredForNextPayout).toBe(CONTRIBUTION);
    expect(snapshot[0].fullySecured).toBe(true);
    expect(snapshot[0].remainingContributionCommitment).toBe(0n);
    expect(snapshot[1].requiredForNextPayout).toBe(CONTRIBUTION);
    expect(snapshot[1].fullySecured).toBe(false);
    expect(snapshot[1].remainingContributionCommitment).toBe(CONTRIBUTION);
  });
});
