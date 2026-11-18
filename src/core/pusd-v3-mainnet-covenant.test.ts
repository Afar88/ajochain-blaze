import { describe, expect, it } from "vitest";
import {
  Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder,
  randomUtxo, type Artifact, type SpendableUtxo,
} from "cashscript";
import { encodeCashAddress, hash160, hexToBin, secp256k1 } from "@bitauth/libauth";
import circleArtifactJson from "../../contracts/AjoCirclePUSDV3Mainnet.json" with { type: "json" };
import escrowArtifactJson from "../../contracts/AjoPUSDMemberEscrowV3.json" with { type: "json" };
import { PUSD_ASSET } from "./assets";
import { MAINNET_PROJECT_TREASURY_ADDRESS } from "./project-treasury";
import { createPusdMainnetCircleContracts, validatePusdMainnetCircleParams } from "./pusd-mainnet-circle";
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

const members = [key(1), key(2)];
const initiator = key(8);

function mainnetTokenAddress(pkh: Uint8Array) {
  const result = encodeCashAddress({ prefix: "bitcoincash", type: "p2pkhWithTokens", payload: pkh });
  if (typeof result === "string") throw new Error("Could not encode Mainnet token-aware test address");
  return result.address;
}

function mainnetParams(membersForCircle = members) {
  return {
    version: 3 as const,
    name: "PUSD Mainnet binding test",
    network: "mainnet" as const,
    members: membersForCircle.map((member) => mainnetTokenAddress(member.pkh)),
    contribution: 10_000n,
    maxFee: MAX_FEE,
    initiator: pkhToAddress(initiator.pkh, "mainnet"),
    stateCategory: STATE,
    treasury: MAINNET_PROJECT_TREASURY_ADDRESS,
  };
}

function tokenAddress(pkh: Uint8Array) {
  const result = encodeCashAddress({ prefix: "bchtest", type: "p2pkhWithTokens", payload: pkh });
  if (typeof result === "string") throw new Error("Could not encode token-aware test address");
  return result.address;
}

function creditCommitment(index: number, amount: bigint) {
  const littleEndian = amount.toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
  return "52" + index.toString(16).padStart(2, "0") + littleEndian;
}

function makeContracts(provider: MockNetworkProvider) {
  const escrows = members.map((member, index) => new Contract(escrowArtifact, [
    hexToBin(STATE).reverse(),
    hexToBin(PUSD).reverse(),
    2n,
    BigInt(index),
    CONTRIBUTION,
    member.pkh,
  ], { provider, contractType: "p2sh32" }));

  const contract = new Contract(circleArtifact, [
    members[0].pkh, members[1].pkh,
    new Uint8Array(20), new Uint8Array(20), new Uint8Array(20),
    2n, CONTRIBUTION, MAX_FEE,
    hexToBin(STATE).reverse(), hexToBin(PUSD).reverse(),
    initiator.pkh, treasuryPkh,
    escrows[0].lockingBytecode, escrows[1].lockingBytecode,
    escrows[0].lockingBytecode, escrows[0].lockingBytecode, escrows[0].lockingBytecode,
  ], { provider, contractType: "p2sh32" });

  return { contract, escrows };
}

function addGenesis(provider: MockNetworkProvider, contract: Contract, escrows: Contract[]) {
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

async function current(contract: Contract, escrows: Contract[]) {
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

async function deposit(
  provider: MockNetworkProvider,
  contract: Contract,
  escrows: Contract[],
  index: number,
  amount = CONTRIBUTION,
  fundingAmount = amount,
) {
  const { state, receipts, escrowUtxos } = await current(contract, escrows);
  const memberAddress = tokenAddress(members[index].pkh);
  const funding = provider.addUtxo(memberAddress, randomUtxo({
    satoshis: DUST,
    token: { category: PUSD, amount: fundingAmount },
  }));
  const reserveAddress = memberAddress;
  const reserve = provider.addUtxo(reserveAddress, randomUtxo({ satoshis: 20_000n }));
  const circleUnlock = contract.unlock.deposit(BigInt(index), amount);
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
      token: { category: STATE, amount: 0n, nft: { capability: "none", commitment: creditCommitment(index, amount) } },
    })
    .addOutput({
      to: escrows[index].tokenAddress, amount: escrowUtxos[index].satoshis + funding.satoshis,
      token: { category: PUSD, amount },
    });
  if (fundingAmount > amount) {
    builder.addOutput({
      to: tokenAddress(members[index].pkh), amount: DUST,
      token: { category: PUSD, amount: fundingAmount - amount },
    });
  }
  builder.addOutput({
    to: reserveAddress,
    amount: 20_000n - (fundingAmount > amount ? DUST : 0n) - 10_000n,
  });
  await builder.send();
}

async function payout(provider: MockNetworkProvider, contract: Contract, escrows: Contract[], recipientIndex = 0) {
  const { state, receipts, escrowUtxos } = await current(contract, escrows);
  const reserveAddress = pkhToAddress(initiator.pkh, "chipnet");
  const reserve = provider.addUtxo(reserveAddress, randomUtxo({ satoshis: 25_000n }));
  const reserveCredit = recipientIndex < members.length - 1 ? CONTRIBUTION : 0n;
  const nextRound = Number.parseInt(state.token!.nft!.commitment.slice(2, 4), 16) + 1;
  const nextStateCommitment = "54" + nextRound.toString(16).padStart(2, "0") + "01";
  const circleUnlock = contract.unlock.payout();
  const builder = new TransactionBuilder({ provider })
    .addInput(state, circleUnlock)
    .addInput(receipts[0], circleUnlock)
    .addInput(receipts[1], circleUnlock)
    .addInput(escrowUtxos[0], escrows[0].unlock.attest())
    .addInput(escrowUtxos[1], escrows[1].unlock.attest())
    .addInput(reserve, initiator.signature.unlockP2PKH())
    .addOutput({
      to: contract.tokenAddress, amount: state.satoshis,
      token: { category: STATE, amount: 0n, nft: { capability: "minting", commitment: nextStateCommitment } },
    })
    .addOutput({
      to: contract.tokenAddress, amount: receipts[0].satoshis,
      token: { category: STATE, amount: 0n, nft: { capability: "none", commitment: creditCommitment(0, recipientIndex === 0 ? reserveCredit : 0n) } },
    })
    .addOutput({
      to: contract.tokenAddress, amount: receipts[1].satoshis,
      token: { category: STATE, amount: 0n, nft: { capability: "none", commitment: creditCommitment(1, recipientIndex === 1 ? reserveCredit : 0n) } },
    });

  for (let index = 0; index < members.length; index++) {
    const oldCredit = escrowUtxos[index].token?.amount ?? 0n;
    const nextCredit = oldCredit - CONTRIBUTION + (index === recipientIndex ? reserveCredit : 0n);
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
  const recipientPayout = grossPot - projectFee - reserveCredit;
  builder
    .addOutput({
      to: tokenAddress(treasuryPkh), amount: DUST,
      token: { category: PUSD, amount: projectFee },
    })
    .addOutput({
      to: tokenAddress(members[recipientIndex].pkh), amount: DUST,
      token: { category: PUSD, amount: recipientPayout },
    })
    .addOutput({ to: reserveAddress, amount: 10_000n });

  await builder.send();
}

async function cancel(provider: MockNetworkProvider, contract: Contract, escrows: Contract[]) {
  const { state, receipts, escrowUtxos } = await current(contract, escrows);
  const feeAddress = pkhToAddress(initiator.pkh, "chipnet");
  const feeInput = provider.addUtxo(feeAddress, randomUtxo({ satoshis: 25_000n }));
  const circleUnlock = contract.unlock.cancel();
  const builder = new TransactionBuilder({ provider })
    .addInput(state, circleUnlock);
  builder.addInputs(receipts, circleUnlock);
  for (let index = 0; index < members.length; index++) {
    builder.addInput(escrowUtxos[index], escrows[index].unlock.cancel());
  }
  builder.addInput(feeInput, initiator.signature.unlockP2PKH());

  for (let index = 0; index < members.length; index++) {
    const credit = receipts[index].token!.nft!.commitment
      ? BigInt("0x" + receipts[index].token!.nft!.commitment.slice(4).match(/../g)!.reverse().join(""))
      : 0n;
    const value = escrowUtxos[index].satoshis + receipts[index].satoshis;
    if (credit > 0n) {
      builder.addOutput({
        to: tokenAddress(members[index].pkh), amount: value,
        token: { category: PUSD, amount: credit },
      });
    } else {
      builder.addOutput({ to: pkhToAddress(members[index].pkh, "chipnet"), amount: value });
    }
  }
  builder.addOutput({ to: feeAddress, amount: 10_000n });
  await builder.send();
}

describe("PUSD Mainnet adapter constructor bindings", () => {
  it("accepts only unique Mainnet token-aware P2PKH member addresses and the shared treasury", () => {
    const params = mainnetParams();
    expect(() => validatePusdMainnetCircleParams(params)).not.toThrow();
    expect(() => validatePusdMainnetCircleParams({
      ...params,
      members: [mainnetTokenAddress(members[0].pkh), tokenAddress(members[1].pkh)],
    })).toThrow(/token-aware P2PKH Bitcoin Cash Mainnet/);
    expect(() => validatePusdMainnetCircleParams({
      ...params,
      members: [params.members[0], params.members[0]],
    })).toThrow(/unique Mainnet address/);
    expect(() => validatePusdMainnetCircleParams({
      ...params,
      treasury: "bitcoincash:qz0w0w0w0w0w0w0w0w0w0w0w0w0w0w0w0w0w0w0w0",
    })).toThrow(/shared Mainnet BCH\/PUSD project treasury/);
  });

  it("derives the exact V3 circle and one distinct member escrow script from the validated Mainnet constructor parameters", () => {
    const provider = new MockNetworkProvider();
    const params = mainnetParams(members);
    const { contract, escrows } = createPusdMainnetCircleContracts(params, provider);
    expect(escrows).toHaveLength(members.length);
    expect(escrows.every((escrow) => escrow.lockingBytecode.length > 0)).toBe(true);
    expect(escrows[0].lockingBytecode).not.toEqual(escrows[1].lockingBytecode);
    expect(contract.lockingBytecode.length).toBeGreaterThan(0);

    const reordered = createPusdMainnetCircleContracts({
      ...params,
      members: [params.members[1], params.members[0]],
    }, provider);
    expect(reordered.contract.lockingBytecode).not.toEqual(contract.lockingBytecode);
    expect(reordered.escrows[0].lockingBytecode).not.toEqual(escrows[0].lockingBytecode);
  });

  it("pins five ordered members and five separately derived escrow scripts", () => {
    const provider = new MockNetworkProvider();
    const fiveMembers = [...members, key(4), key(5), key(6)];
    const params = mainnetParams(fiveMembers);
    const { contract, escrows } = createPusdMainnetCircleContracts(params, provider);
    expect(escrows).toHaveLength(5);
    expect(new Set(escrows.map((escrow) => binToHex(escrow.lockingBytecode))).size).toBe(5);
    expect(contract.lockingBytecode.length).toBeGreaterThan(0);
  });
});

describe("AjoChain PUSD V3 Mainnet covenant (mock-chain invariants)", () => {
  it("pins the same Mainnet project-fee treasury in each newly derived circle", () => {
    const provider = new MockNetworkProvider();
    const { contract } = makeContracts(provider);
    expect(contract.address).toMatch(/^bchtest:/);
    expect(treasuryPkh).toHaveLength(20);
  });

  it("returns excess PUSD to the depositing member without crediting it to escrow", async () => {
    const provider = new MockNetworkProvider();
    const { contract, escrows } = makeContracts(provider);
    addGenesis(provider, contract, escrows);
    await deposit(provider, contract, escrows, 0, CONTRIBUTION, CONTRIBUTION + 50n);

    const { receipts, escrowUtxos } = await current(contract, escrows);
    expect(receipts[0].token!.nft!.commitment).toBe(creditCommitment(0, CONTRIBUTION));
    expect(escrowUtxos[0].token!.amount).toBe(CONTRIBUTION);
    const memberUtxos = await provider.getUtxos(tokenAddress(members[0].pkh));
    expect(memberUtxos.some((utxo) => utxo.token?.category === PUSD &&
      utxo.token.amount === 50n)).toBe(true);
  });

  it("rejects a member deposit that would strand more than one round contribution in escrow", async () => {
    const provider = new MockNetworkProvider();
    const { contract, escrows } = makeContracts(provider);
    addGenesis(provider, contract, escrows);

    await expect(deposit(provider, contract, escrows, 0, 2n * CONTRIBUTION))
      .rejects.toThrow();

    const { receipts, escrowUtxos } = await current(contract, escrows);
    expect(receipts[0].token!.nft!.commitment).toBe(creditCommitment(0, 0n));
    expect(escrowUtxos[0].token?.category).toBeUndefined();
  }, 60_000);

  it("pays a separate 1% PUSD fee and reserves one next contribution for the non-final recipient", async () => {
    const provider = new MockNetworkProvider();
    const { contract, escrows } = makeContracts(provider);
    addGenesis(provider, contract, escrows);
    await deposit(provider, contract, escrows, 0);
    await deposit(provider, contract, escrows, 1);

    await payout(provider, contract, escrows, 0);

    const { state, receipts, escrowUtxos } = await current(contract, escrows);
    expect(state.token!.nft!.commitment).toBe("540101");
    expect(receipts.map((receipt) => receipt.token!.nft!.commitment)).toEqual([
      creditCommitment(0, CONTRIBUTION), creditCommitment(1, 0n),
    ]);
    expect(escrowUtxos[0].token?.amount).toBe(CONTRIBUTION);
    expect(escrowUtxos[1].token?.category).toBeUndefined();

    const treasuryOutputs = await provider.getUtxos(tokenAddress(treasuryPkh));
    expect(treasuryOutputs.some((utxo) =>
      utxo.token?.category === PUSD && utxo.token.amount === 2n,
    )).toBe(true);
    const firstRecipientOutputs = await provider.getUtxos(tokenAddress(members[0].pkh));
    expect(firstRecipientOutputs.some((utxo) =>
      utxo.token?.category === PUSD && utxo.token.amount === 98n,
    )).toBe(true);
  }, 60_000);

  it("pays no future reserve to the final recipient", async () => {
    const provider = new MockNetworkProvider();
    const { contract, escrows } = makeContracts(provider);
    addGenesis(provider, contract, escrows);
    await deposit(provider, contract, escrows, 0);
    await deposit(provider, contract, escrows, 1);
    await payout(provider, contract, escrows, 0);

    await deposit(provider, contract, escrows, 1);
    await payout(provider, contract, escrows, 1);

    const { state, receipts, escrowUtxos } = await current(contract, escrows);
    expect(state.token!.nft!.commitment).toBe("540201");
    expect(receipts.map((receipt) => receipt.token!.nft!.commitment)).toEqual([
      creditCommitment(0, 0n), creditCommitment(1, 0n),
    ]);
    expect(escrowUtxos.every((utxo) => utxo.token?.category === undefined)).toBe(true);
  }, 60_000);

  it("refunds each member's exact PUSD credit before the first payout", async () => {
    const provider = new MockNetworkProvider();
    const { contract, escrows } = makeContracts(provider);
    addGenesis(provider, contract, escrows);
    await deposit(provider, contract, escrows, 0);

    await cancel(provider, contract, escrows);

    for (const member of members) {
      const outputs = await provider.getUtxos(tokenAddress(member.pkh));
      expect(outputs.some((utxo) => utxo.token?.category === PUSD &&
        utxo.token.amount === CONTRIBUTION)).toBe(member === members[0]);
    }
  });

  it("rejects cancellation after the first payout", async () => {
    const provider = new MockNetworkProvider();
    const { contract, escrows } = makeContracts(provider);
    addGenesis(provider, contract, escrows);
    await deposit(provider, contract, escrows, 0);
    await deposit(provider, contract, escrows, 1);
    await payout(provider, contract, escrows, 0);
    await expect(cancel(provider, contract, escrows)).rejects.toThrow();
  }, 60_000);
});
