import { describe, expect, it } from "vitest";
import {
  Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder,
  randomUtxo, type Artifact, type SpendableUtxo,
} from "cashscript";
import { encodeCashAddress, hash160, hexToBin, secp256k1 } from "@bitauth/libauth";
import circleArtifactJson from "../../contracts/AjoCirclePUSDV3Mainnet.json" with { type: "json" };
import escrowArtifactJson from "../../contracts/AjoPUSDMemberEscrowV3.json" with { type: "json" };
import { PUSD_ASSET } from "./assets";
import { pkhToAddress } from "./bch-address";
import { getMainnetProjectTreasuryPkh } from "./project-treasury";

const circleArtifact = circleArtifactJson as unknown as Artifact;
const escrowArtifact = escrowArtifactJson as unknown as Artifact;
const STATE = "ab".repeat(32);
const PUSD = PUSD_ASSET.categoryId;
const DUST = 1_000n;
const CONTRIBUTION = 100n;
const MAX_FEE = 30_000n;
const treasuryPkh = getMainnetProjectTreasuryPkh();

function key(n: number) {
  const privateKey = new Uint8Array(32);
  privateKey[31] = n;
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey) as Uint8Array;
  return {
    privateKey,
    publicKey,
    pkh: hash160(publicKey),
    signature: new SignatureTemplate(privateKey),
  };
}

const members = [key(1), key(2), key(3)];
const initiator = key(8);

type Fixture = {
  provider: MockNetworkProvider;
  contract: Contract;
  escrows: Contract[];
};

function tokenAddress(pkh: Uint8Array) {
  const result = encodeCashAddress({ prefix: "bchtest", type: "p2pkhWithTokens", payload: pkh });
  if (typeof result === "string") throw new Error("Could not encode token-aware test address");
  return result.address;
}

function creditCommitment(index: number, amount: bigint) {
  const littleEndian = amount.toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
  return "52" + index.toString(16).padStart(2, "0") + littleEndian;
}

function makeFixture(provider: MockNetworkProvider): Fixture {
  const escrows = members.map((member, index) => new Contract(escrowArtifact, [
    hexToBin(STATE).reverse(),
    hexToBin(PUSD).reverse(),
    BigInt(members.length),
    BigInt(index),
    CONTRIBUTION,
    member.pkh,
  ], { provider, contractType: "p2sh32" }));

  const emptyPkh = new Uint8Array(20);
  const memberPkhs = [...members.map((member) => member.pkh), ...Array.from(
    { length: 5 - members.length }, () => emptyPkh,
  )];
  const emptyEscrowLock = escrows[0].lockingBytecode;
  const escrowLocks = [...escrows.map((escrow) => escrow.lockingBytecode), ...Array.from(
    { length: 5 - escrows.length }, () => emptyEscrowLock,
  )];

  const contract = new Contract(circleArtifact, [
    ...memberPkhs,
    BigInt(members.length), CONTRIBUTION, MAX_FEE,
    hexToBin(STATE).reverse(), hexToBin(PUSD).reverse(),
    initiator.pkh, treasuryPkh,
    ...escrowLocks,
  ], { provider, contractType: "p2sh32" });

  return { provider, contract, escrows };
}

function addGenesis({ provider, contract, escrows }: Fixture) {
  provider.addUtxo(contract.address, randomUtxo({
    satoshis: DUST,
    token: { category: STATE, amount: 0n, nft: { capability: "minting", commitment: "540000" } },
  }));
  for (let index = 0; index < members.length; index++) {
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: DUST,
      token: { category: STATE, amount: 0n, nft: { capability: "none", commitment: creditCommitment(index, 0n) } },
    }));
    provider.addUtxo(escrows[index].address, randomUtxo({ satoshis: DUST }));
  }
}

async function current({ contract, escrows }: Fixture) {
  const circleUtxos = await contract.getUtxos();
  const state = circleUtxos.find((utxo) => utxo.token?.nft?.capability === "minting") as SpendableUtxo;
  const receipts = members.map((_, index) => circleUtxos.find((utxo) =>
    utxo.token?.nft?.commitment?.startsWith("52" + index.toString(16).padStart(2, "0")),
  ) as SpendableUtxo);
  const escrowUtxos = await Promise.all(escrows.map(async (escrow) => {
    const utxos = await escrow.getUtxos();
    return (utxos.find((utxo) => utxo.token?.category === PUSD) ?? utxos[0]) as SpendableUtxo;
  }));
  return { state, receipts, escrowUtxos };
}

async function deposit(fixture: Fixture, index: number) {
  const { provider, contract, escrows } = fixture;
  const { state, receipts, escrowUtxos } = await current(fixture);
  const memberAddress = tokenAddress(members[index].pkh);
  const funding = provider.addUtxo(memberAddress, randomUtxo({
    satoshis: DUST,
    token: { category: PUSD, amount: CONTRIBUTION },
  }));
  const reserve = provider.addUtxo(memberAddress, randomUtxo({ satoshis: 20_000n }));
  const circleUnlock = contract.unlock.deposit(BigInt(index), CONTRIBUTION);
  const builder = new TransactionBuilder({ provider })
    .addInput(state, circleUnlock)
    .addInput(receipts[index], circleUnlock)
    .addInput(escrowUtxos[index], escrows[index].unlock.attest())
    .addInput(funding, members[index].signature.unlockP2PKH())
    .addInput(reserve, members[index].signature.unlockP2PKH())
    .addOutput({
      to: contract.tokenAddress, amount: state.satoshis,
      token: { category: STATE, amount: 0n, nft: { capability: "minting", commitment: state.token!.nft!.commitment } },
    })
    .addOutput({
      to: contract.tokenAddress, amount: receipts[index].satoshis,
      token: { category: STATE, amount: 0n, nft: { capability: "none", commitment: creditCommitment(index, CONTRIBUTION) } },
    })
    .addOutput({
      to: escrows[index].tokenAddress, amount: escrowUtxos[index].satoshis + funding.satoshis,
      token: { category: PUSD, amount: CONTRIBUTION },
    })
    .addOutput({ to: memberAddress, amount: 10_000n });
  await builder.send();
}

async function payout(fixture: Fixture, recipientIndex: number) {
  const { provider, contract, escrows } = fixture;
  const { state, receipts, escrowUtxos } = await current(fixture);
  const reserveAddress = pkhToAddress(initiator.pkh, "chipnet");
  const feeInput = provider.addUtxo(reserveAddress, randomUtxo({ satoshis: 25_000n }));
  const recipientReserve = recipientIndex < members.length - 1 ? CONTRIBUTION : 0n;
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2, 4), 16);
  const nextStateCommitment = "54" + (round + 1).toString(16).padStart(2, "0") + "01";
  const circleUnlock = contract.unlock.payout();
  const builder = new TransactionBuilder({ provider })
    .addInput(state, circleUnlock);
  builder.addInputs(receipts, circleUnlock);
  for (let index = 0; index < members.length; index++) {
    builder.addInput(escrowUtxos[index], escrows[index].unlock.attest());
  }
  builder.addInput(feeInput, initiator.signature.unlockP2PKH());
  builder.addOutput({
    to: contract.tokenAddress, amount: state.satoshis,
    token: { category: STATE, amount: 0n, nft: { capability: "minting", commitment: nextStateCommitment } },
  });

  for (let index = 0; index < members.length; index++) {
    const oldCredit = escrowUtxos[index].token?.amount ?? 0n;
    const nextCredit = oldCredit - CONTRIBUTION + (index === recipientIndex ? recipientReserve : 0n);
    builder.addOutput({
      to: contract.tokenAddress, amount: receipts[index].satoshis,
      token: { category: STATE, amount: 0n, nft: { capability: "none", commitment: creditCommitment(index, nextCredit) } },
    });
  }

  for (let index = 0; index < members.length; index++) {
    const oldCredit = escrowUtxos[index].token?.amount ?? 0n;
    const nextCredit = oldCredit - CONTRIBUTION + (index === recipientIndex ? recipientReserve : 0n);
    if (nextCredit > 0n) {
      builder.addOutput({
        to: escrows[index].tokenAddress, amount: escrowUtxos[index].satoshis,
        token: { category: PUSD, amount: nextCredit },
      });
    } else {
      builder.addOutput({ to: escrows[index].address, amount: escrowUtxos[index].satoshis });
    }
  }

  const grossPot = BigInt(members.length) * CONTRIBUTION;
  const projectFee = grossPot / 100n;
  const payoutAmount = grossPot - projectFee - recipientReserve;
  builder
    .addOutput({
      to: tokenAddress(treasuryPkh), amount: DUST,
      token: { category: PUSD, amount: projectFee },
    })
    .addOutput({
      to: tokenAddress(members[recipientIndex].pkh), amount: DUST,
      token: { category: PUSD, amount: payoutAmount },
    })
    .addOutput({ to: reserveAddress, amount: 10_000n });

  await builder.send();
}

describe("AjoChain PUSD V3 full-rotation reserve rule", () => {
  it("reserves exactly one next contribution from every non-final recipient and none from the final recipient", async () => {
    const provider = new MockNetworkProvider();
    const fixture = makeFixture(provider);
    addGenesis(fixture);

    // First round: all members fund their own current installment.
    await deposit(fixture, 0);
    await deposit(fixture, 1);
    await deposit(fixture, 2);

    // Member 0 receives the pot. Their next contribution is retained in their
    // own escrow at exactly the agreed per-member contribution amount.
    await payout(fixture, 0);
    let snapshot = await current(fixture);
    expect(snapshot.escrowUtxos.map((utxo) => utxo.token?.amount ?? 0n))
      .toEqual([CONTRIBUTION, 0n, 0n]);
    expect(await provider.getUtxos(tokenAddress(members[0].pkh))).toEqual(
      expect.arrayContaining([expect.objectContaining({ token: expect.objectContaining({ category: PUSD, amount: 197n }) })]),
    );

    // Second round: member 0's reserve satisfies their installment without a
    // new deposit. The other members must fund their own receipts.
    await deposit(fixture, 1);
    await deposit(fixture, 2);
    await payout(fixture, 1);
    snapshot = await current(fixture);
    expect(snapshot.escrowUtxos.map((utxo) => utxo.token?.amount ?? 0n))
      .toEqual([0n, CONTRIBUTION, 0n]);
    expect(await provider.getUtxos(tokenAddress(members[1].pkh))).toEqual(
      expect.arrayContaining([expect.objectContaining({ token: expect.objectContaining({ category: PUSD, amount: 197n }) })]),
    );

    // Final round: member 1's reserve is consumed; member 0 must contribute
    // again; the final recipient gets no further contribution withheld.
    await deposit(fixture, 0);
    await deposit(fixture, 2);
    await payout(fixture, 2);
    snapshot = await current(fixture);
    expect(snapshot.state.token!.nft!.commitment).toBe("540301");
    expect(snapshot.escrowUtxos.map((utxo) => utxo.token?.amount ?? 0n))
      .toEqual([0n, 0n, 0n]);
    expect(await provider.getUtxos(tokenAddress(members[2].pkh))).toEqual(
      expect.arrayContaining([expect.objectContaining({ token: expect.objectContaining({ category: PUSD, amount: 297n }) })]),
    );
  }, 60_000);
});
