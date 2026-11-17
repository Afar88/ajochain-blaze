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
import { assertV2FeeDepositRoundOpen, assertV2FeeStateCommitmentSemantics, isValidV2FeeStateCommitment, v2FeeCreditFromCommitment, v2FeeStateCommitment, summarizeV2FeeMemberAccounting } from "./v2-fee-bch";

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

function addGenesis(
  provider: MockNetworkProvider,
  contract: Contract,
  stateCommitment = "540000",
  initialCredit = 0n,
) {
  provider.addUtxo(contract.address, randomUtxo({
    satoshis: DUST + BigInt(members.length) * initialCredit,
    token: { category: CATEGORY, amount: 0n, nft: { capability: "minting", commitment: stateCommitment } },
  }));
  for (let index = 0; index < members.length; index++) {
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: DUST,
      token: { category: CATEGORY, amount: 0n, nft: { capability: "none", commitment: commitment(index, initialCredit) } },
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

async function depositCurrentRound(
  provider: MockNetworkProvider,
  contract: Contract,
  index: number,
  amount = CONTRIBUTION,
) {
  const { state, receipts } = await readCircle(contract);
  const address = pkhToAddress(members[index].pkh, "chipnet");
  const oldCredit = v2FeeCreditFromCommitment(receipts[index].token!.nft!.commitment);
  const funding = provider.addUtxo(address, randomUtxo({ satoshis: amount + 20_000n }));
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.addCredit(BigInt(index), amount))
    .addInput(receipts[index], contract.unlock.addCredit(BigInt(index), amount))
    .addInput(funding, members[index].signer.unlockP2PKH())
    .addOutput({
      to: contract.tokenAddress,
      amount: state.satoshis + amount,
      token: { category: CATEGORY, amount: 0n, nft: { capability: "minting", commitment: state.token!.nft!.commitment } },
    })
    .addOutput({
      to: contract.tokenAddress,
      amount: receipts[index].satoshis,
      token: { category: CATEGORY, amount: 0n, nft: { capability: "none", commitment: commitment(index, oldCredit + amount) } },
    })
    .addOutput({ to: address, amount: 10_000n });
  await builder.send();
}

async function cancelV3Circle(
  provider: MockNetworkProvider,
  contract: Contract,
  authorizer = initiator,
) {
  const { state, receipts } = await readCircle(contract);
  const feeAddress = pkhToAddress(initiator.pkh, "chipnet");
  const feeFunding = provider.addUtxo(feeAddress, randomUtxo({ satoshis: 20_000n }));
  const unlocker = contract.unlock.cancel(authorizer.publicKey, authorizer.signer);
  const builder = new TransactionBuilder({ provider })
    .addInput(state, unlocker)
    .addInputs(receipts, unlocker)
    .addInput(feeFunding, initiator.signer.unlockP2PKH());
  receipts.forEach((receipt, index) => {
    const credit = v2FeeCreditFromCommitment(receipt.token!.nft!.commitment);
    builder.addOutput({
      to: pkhToAddress(members[index].pkh, "chipnet"),
      amount: receipt.satoshis + credit,
    });
  });
  builder.addOutput({ to: feeAddress, amount: 14_000n });
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

describe("V2/V3 member deposit round guard", () => {
  it("allows only active rounds and rejects terminal or impossible rounds", () => {
    expect(() => assertV2FeeDepositRoundOpen("fee-v3-auto-reserve", 0, 2)).not.toThrow();
    expect(() => assertV2FeeDepositRoundOpen("fee-v3-auto-reserve", 1, 2)).not.toThrow();
    expect(() => assertV2FeeDepositRoundOpen("fee-v2-escrow", 2, 2))
      .toThrow(/completed every scheduled payout/);
    expect(() => assertV2FeeDepositRoundOpen("fee-v3-auto-reserve", 3, 2))
      .toThrow(/Invalid V2 fee deposit round/);
    expect(() => assertV2FeeDepositRoundOpen("fee-v1", 2, 2))
      .toThrow(/Invalid V2 fee deposit round/);
  });
});

describe("V2/V3 state transition semantics", () => {
  it("accepts genesis, paid rounds and terminal state for escrow and auto-reserve circles", () => {
    for (const covenant of ["fee-v2-escrow", "fee-v3-auto-reserve"] as const) {
      expect(() => assertV2FeeStateCommitmentSemantics(covenant, 2, "540000")).not.toThrow();
      expect(() => assertV2FeeStateCommitmentSemantics(covenant, 2, "540101")).not.toThrow();
      expect(() => assertV2FeeStateCommitmentSemantics(covenant, 2, "540201")).not.toThrow();
    }
  });

  it("rejects impossible round and payout-marker combinations", () => {
    for (const commitment of ["540001", "540100", "540300", "5402ff"]) {
      expect(() => assertV2FeeStateCommitmentSemantics("fee-v3-auto-reserve", 2, commitment))
        .toThrow(/state|commitment/i);
    }
  });

  it("preserves valid fee-v1 wrapped paid states but rejects impossible unpaid rounds", () => {
    for (const commitment of ["540000", "540001", "540101"]) {
      expect(() => assertV2FeeStateCommitmentSemantics("fee-v1", 2, commitment)).not.toThrow();
    }
    for (const commitment of ["540100", "540201"]) {
      expect(() => assertV2FeeStateCommitmentSemantics("fee-v1", 2, commitment))
        .toThrow(/legacy.*state|payout marker/i);
    }
  });
});

describe("V2/V3 state NFT commitment encoding", () => {
  it("recognises every valid three-byte round and payout-marker combination", () => {
    for (let round = 0; round <= 5; round++) {
      for (const hasPaid of [false, true]) {
        const commitment = v2FeeStateCommitment(round, hasPaid);
        expect(commitment).toHaveLength(6);
        expect(isValidV2FeeStateCommitment(commitment)).toBe(true);
      }
    }
  });

  it("rejects truncated, extended, out-of-range and malformed state commitments", () => {
    for (const commitment of [
      "5400", "54000000", "540600", "54ff00", "540002", "550000", "",
    ]) {
      expect(isValidV2FeeStateCommitment(commitment)).toBe(false);
    }
  });
});

describe("AjoChain V3 rejects inconsistent state in covenant branches", () => {
  it("rejects deposits from a non-genesis round with an unpaid marker", async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract, "540100");
    await expect(depositCurrentRound(provider, contract, 0)).rejects.toThrow();
  });

  it("rejects payout from a non-genesis round with an unpaid marker", async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract, "540100", CONTRIBUTION);
    await expect(triggerPayout(provider, contract)).rejects.toThrow();
  });

  it("rejects cancellation unless the circle is still at genesis", async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract, "540100", CONTRIBUTION);
    await expect(cancelV3Circle(provider, contract)).rejects.toThrow();
  });
});

describe("AjoChain V3 initiator cancellation covenant", () => {
  it("refunds each member's exact recorded credit and receipt backing before the first payout", async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    const expectedCredits = [CONTRIBUTION / 2n, CONTRIBUTION];
    await depositCurrentRound(provider, contract, 0, expectedCredits[0]);
    await depositCurrentRound(provider, contract, 1, expectedCredits[1]);

    await cancelV3Circle(provider, contract);

    expect(await contract.getUtxos()).toHaveLength(0);
    for (let index = 0; index < members.length; index++) {
      const address = pkhToAddress(members[index].pkh, "chipnet");
      const memberUtxos = await provider.getUtxos(address);
      expect(memberUtxos.some((utxo) => utxo.satoshis === DUST + expectedCredits[index])).toBe(true);
    }
  });

  it("rejects cancellation authorized by a non-initiator", async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    await expect(cancelV3Circle(provider, contract, key(20))).rejects.toThrow();
  });

  it("permanently rejects cancellation after the first payout", async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    await depositCurrentRound(provider, contract, 0);
    await depositCurrentRound(provider, contract, 1);
    await triggerPayout(provider, contract);
    await expect(cancelV3Circle(provider, contract)).rejects.toThrow();
  });
});

describe("AjoChain V3 automatic future-contribution reserve covenant", () => {
  it("retains one next installment from the recipient's payout and funds their receipt", async () => {
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
    // already has one next installment reserved from their payout.
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

  it("carries one contribution into the next round, but blocks a later missed installment", async () => {
    const five = [31, 32, 33, 34, 35].map(key);
    const fiveCategory = "bc".repeat(32);
    const fiveTreasury = key(38);
    const fiveInitiator = key(39);
    const provider = new MockNetworkProvider();
    const fiveContract = new Contract(artifact, [
      five[0].pkh, five[1].pkh, five[2].pkh, five[3].pkh, five[4].pkh,
      5n, CONTRIBUTION, 20_000n, hexToBin(fiveCategory).reverse(),
      fiveInitiator.pkh, fiveTreasury.pkh,
    ], { provider, contractType: "p2sh32" });

    provider.addUtxo(fiveContract.address, randomUtxo({
      satoshis: DUST,
      token: { category: fiveCategory, amount: 0n, nft: { capability: "minting", commitment: "540000" } },
    }));
    for (let index = 0; index < five.length; index++) {
      provider.addUtxo(fiveContract.address, randomUtxo({
        satoshis: DUST,
        token: { category: fiveCategory, amount: 0n, nft: { capability: "none", commitment: commitment(index, 0n) } },
      }));
    }

    const readFive = async () => {
      const utxos = await fiveContract.getUtxos();
      const state = utxos.find((utxo) => utxo.token?.nft?.capability === "minting") as SpendableUtxo;
      const receipts = five.map((_, index) => utxos.find((utxo) =>
        utxo.token?.nft?.commitment?.startsWith("52" + index.toString(16).padStart(2, "0")),
      ) as SpendableUtxo);
      return { state, receipts };
    };

    const depositFive = async (index: number) => {
      const { state, receipts } = await readFive();
      const address = pkhToAddress(five[index].pkh, "chipnet");
      const funding = provider.addUtxo(address, randomUtxo({ satoshis: CONTRIBUTION + 20_000n }));
      const oldCredit = v2FeeCreditFromCommitment(receipts[index].token!.nft!.commitment);
      const builder = new TransactionBuilder({ provider })
        .addInput(state, fiveContract.unlock.addCredit(BigInt(index), CONTRIBUTION))
        .addInput(receipts[index], fiveContract.unlock.addCredit(BigInt(index), CONTRIBUTION))
        .addInput(funding, five[index].signer.unlockP2PKH())
        .addOutput({
          to: fiveContract.tokenAddress,
          amount: state.satoshis + CONTRIBUTION,
          token: { category: fiveCategory, amount: 0n, nft: { capability: "minting", commitment: state.token!.nft!.commitment } },
        })
        .addOutput({
          to: fiveContract.tokenAddress,
          amount: receipts[index].satoshis,
          token: { category: fiveCategory, amount: 0n, nft: { capability: "none", commitment: commitment(index, oldCredit + CONTRIBUTION) } },
        })
        .addOutput({ to: address, amount: 10_000n });
      await builder.send();
    };

    const payoutFive = async () => {
      const { state, receipts } = await readFive();
      const round = Number.parseInt(state.token!.nft!.commitment.slice(2, 4), 16);
      const pot = BigInt(five.length) * CONTRIBUTION;
      const projectFee = pot / 100n;
      const reserve = round < five.length - 1 ? CONTRIBUTION : 0n;
      const feeAddress = pkhToAddress(fiveInitiator.pkh, "chipnet");
      const feeFunding = provider.addUtxo(feeAddress, randomUtxo({ satoshis: 50_000n }));
      const builder = new TransactionBuilder({ provider })
        .addInput(state, fiveContract.unlock.payout())
        .addInputs(receipts, fiveContract.unlock.payout())
        .addInput(feeFunding, fiveInitiator.signer.unlockP2PKH())
        .addOutput({
          to: fiveContract.tokenAddress,
          amount: state.satoshis - pot + reserve,
          token: { category: fiveCategory, amount: 0n, nft: { capability: "minting", commitment: "54" + (round + 1).toString(16).padStart(2, "0") + "01" } },
        });
      for (let index = 0; index < receipts.length; index++) {
        const oldCredit = v2FeeCreditFromCommitment(receipts[index].token!.nft!.commitment);
        const nextCredit = oldCredit - CONTRIBUTION + (index === round ? reserve : 0n);
        builder.addOutput({
          to: fiveContract.tokenAddress,
          amount: receipts[index].satoshis,
          token: { category: fiveCategory, amount: 0n, nft: { capability: "none", commitment: commitment(index, nextCredit) } },
        });
      }
      builder.addOutput({ to: pkhToAddress(fiveTreasury.pkh, "chipnet"), amount: projectFee });
      const recipientPayout = pot - projectFee - reserve;
      builder.addOutput({
        to: pkhToAddress(five[round].pkh, "chipnet"),
        amount: recipientPayout,
      });
      builder.addOutput({ to: feeAddress, amount: feeFunding.satoshis - 15_000n });
      await builder.send();
      return { reserve, pot, projectFee, recipientPayout };
    };

    // All five members fund round one. Member one receives one next installment,
    // not the four future installments remaining in the overall circle.
    for (let index = 0; index < five.length; index++) await depositFive(index);
    const first = await payoutFive();
    expect(first.reserve).toBe(CONTRIBUTION);
    let circle = await readFive();
    expect(circle.state.satoshis).toBe(DUST + CONTRIBUTION);
    expect(v2FeeCreditFromCommitment(circle.receipts[0].token!.nft!.commitment)).toBe(CONTRIBUTION);
    expect(circle.receipts.slice(1).every((receipt) =>
      v2FeeCreditFromCommitment(receipt.token!.nft!.commitment) === 0n,
    )).toBe(true);

    // The one retained contribution lets member one continue through round two
    // without sending a fresh deposit. The other four members fund that round.
    for (let index = 1; index < five.length; index++) await depositFive(index);
    const second = await payoutFive();
    expect(second.reserve).toBe(CONTRIBUTION);
    circle = await readFive();
    expect(v2FeeCreditFromCommitment(circle.receipts[0].token!.nft!.commitment)).toBe(0n);
    expect(v2FeeCreditFromCommitment(circle.receipts[1].token!.nft!.commitment)).toBe(CONTRIBUTION);

    // The first recipient's single reserve is now consumed. If that member stops
    // contributing completely, the next scheduled payout is blocked.
    for (let index = 2; index < five.length; index++) await depositFive(index);
    await expect(payoutFive()).rejects.toThrow();

    // The circle can continue when member one funds their next direct installment.
    await depositFive(0);
    const third = await payoutFive();
    expect(third.reserve).toBe(CONTRIBUTION);
    expect(third.recipientPayout).toBe(third.pot - third.projectFee - CONTRIBUTION);
    circle = await readFive();
    expect(circle.state.satoshis).toBe(DUST + CONTRIBUTION);
    expect(circle.state.token!.nft!.commitment).toBe("540301");
    expect(v2FeeCreditFromCommitment(circle.receipts[2].token!.nft!.commitment)).toBe(CONTRIBUTION);

    // Member two's reserve funds this round; all other members contribute again.
    for (const index of [0, 1, 3, 4]) await depositFive(index);
    const fourth = await payoutFive();
    expect(fourth.reserve).toBe(CONTRIBUTION);
    expect(fourth.recipientPayout).toBe(fourth.pot - fourth.projectFee - CONTRIBUTION);
    circle = await readFive();
    expect(circle.state.satoshis).toBe(DUST + CONTRIBUTION);
    expect(circle.state.token!.nft!.commitment).toBe("540401");
    expect(v2FeeCreditFromCommitment(circle.receipts[3].token!.nft!.commitment)).toBe(CONTRIBUTION);

    // The fifth and final recipient has no next round, so no reserve is withheld.
    for (const index of [0, 1, 2, 4]) await depositFive(index);
    const fifth = await payoutFive();
    expect(fifth.reserve).toBe(0n);
    expect(fifth.recipientPayout).toBe(fifth.pot - fifth.projectFee);
    circle = await readFive();
    expect(circle.state.satoshis).toBe(DUST);
    expect(circle.state.token!.nft!.commitment).toBe("540501");
    expect(circle.receipts.every((receipt) =>
      v2FeeCreditFromCommitment(receipt.token!.nft!.commitment) === 0n,
    )).toBe(true);
    await expect(payoutFive()).rejects.toThrow();
    await expect(depositFive(0)).rejects.toThrow();
  }, 150000);

  it("reserves exactly one next contribution for the first recipient in a five-member circle", () => {
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
    const nextInstallmentReserve = CONTRIBUTION;
    const ledger = summarizeV2FeeMemberAccounting(
      params,
      1,
      [nextInstallmentReserve, 0n, 0n, 0n, 0n],
    );
    expect(ledger[0].requiredForNextPayout).toBe(CONTRIBUTION);
    expect(ledger[0].fullySecured).toBe(true);
    expect(ledger[0].payoutAmountReceived).toBe(gross - projectFee - nextInstallmentReserve);
    expect(ledger[0].payoutAmountReceived).toBe(790_000n);
    expect(ledger[0].totalPaidIn).toBe(CONTRIBUTION);
    expect(ledger.slice(1).every((member) => member.totalPaidIn === CONTRIBUTION)).toBe(true);
    expect(ledger[0].remainingContributionCommitment).toBe(3n * CONTRIBUTION);
    expect(ledger.slice(1).every((member) =>
      member.requiredForNextPayout === CONTRIBUTION && !member.fullySecured,
    )).toBe(true);
  });

  it("separates direct member deposits from the payout-funded reserve at every five-member position", () => {
    const params = {
      version: 2 as const,
      covenant: "fee-v3-auto-reserve" as const,
      name: "Five-member deposit history",
      network: "chipnet" as const,
      members: ["m0", "m1", "m2", "m3", "m4"],
      contribution: CONTRIBUTION,
      maxFee: MAX_FEE,
      stateCategory: CATEGORY,
      initiator: "initiator",
      treasury: "treasury",
    };
    const cases = [
      { round: 2, credits: [0n, CONTRIBUTION, 0n, 0n, 0n], direct: [1n, 2n, 2n, 2n, 2n] },
      { round: 3, credits: [0n, 0n, CONTRIBUTION, 0n, 0n], direct: [2n, 2n, 3n, 3n, 3n] },
      { round: 4, credits: [0n, 0n, 0n, CONTRIBUTION, 0n], direct: [3n, 3n, 3n, 4n, 4n] },
      { round: 5, credits: [0n, 0n, 0n, 0n, 0n], direct: [4n, 4n, 4n, 4n, 5n] },
    ];
    for (const snapshot of cases) {
      const ledger = summarizeV2FeeMemberAccounting(params, snapshot.round, snapshot.credits);
      expect(ledger.map((member) => member.totalPaidIn)).toEqual(
        snapshot.direct.map((count) => count * CONTRIBUTION),
      );
    }
  });

  it("rejects a latest V3 recipient whose reserve credit is not exact", () => {
    const params = {
      version: 2 as const,
      covenant: "fee-v3-auto-reserve" as const,
      name: "Reserve integrity",
      network: "chipnet" as const,
      members: ["m0", "m1", "m2"],
      contribution: CONTRIBUTION,
      maxFee: MAX_FEE,
      stateCategory: CATEGORY,
      initiator: "initiator",
      treasury: "treasury",
    };
    expect(() => summarizeV2FeeMemberAccounting(params, 1, [CONTRIBUTION - 1n, 0n, 0n]))
      .toThrow(/exact automatic reserve/);
  });

  it("reports one next installment for prior recipients and one current contribution for unpaid members", () => {
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
