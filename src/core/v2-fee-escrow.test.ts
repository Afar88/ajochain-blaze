import { describe, expect, it } from 'vitest';
import {
  Contract,
  MockNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
  randomUtxo,
  type Artifact,
  type SpendableUtxo,
} from 'cashscript';
import { hash160, secp256k1, hexToBin } from '@bitauth/libauth';
import escrowArtifactJson from '../../contracts/AjoCircleV2FeeEscrow.json' with { type: 'json' };
import { pkhToAddress } from './bch-address';
import {
  summarizeV2FeeMemberAccounting,
  type V2FeeCircleParams,
} from './v2-fee-bch';

const artifact = escrowArtifactJson as unknown as Artifact;
const CATEGORY = 'ef'.repeat(32);
const CONTRIBUTION = 200_000n;
const MAX_FEE = 10_000n;
const DUST = 1_000n;

function key(n: number) {
  const privateKey = new Uint8Array(32);
  privateKey[31] = n;
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey) as Uint8Array;
  return { privateKey, publicKey, pkh: hash160(publicKey), signature: new SignatureTemplate(privateKey) };
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
  ], { provider, contractType: 'p2sh32' });
}

function receiptCommitment(index: number, amount: bigint) {
  return '52' + index.toString(16).padStart(2, '0') +
    amount.toString(16).padStart(16, '0').match(/../g)!.reverse().join('');
}

function addGenesis(provider: MockNetworkProvider, contract: Contract) {
  provider.addUtxo(contract.address, randomUtxo({
    satoshis: DUST,
    token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: '540000' } },
  }));
  for (let index = 0; index < members.length; index++) {
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: DUST,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: receiptCommitment(index, 0n) } },
    }));
  }
}

async function deposit(
  provider: MockNetworkProvider,
  contract: Contract,
  index: number,
  amount: bigint,
) {
  const all = await contract.getUtxos();
  const state = all.find((utxo) => utxo.token?.nft?.capability === 'minting') as SpendableUtxo;
  const receipt = all.find((utxo) => utxo.token?.nft?.commitment?.startsWith('52' + index.toString(16).padStart(2, '0'))) as SpendableUtxo;
  const address = pkhToAddress(members[index].pkh, 'chipnet');
  const funding = provider.addUtxo(address, randomUtxo({ satoshis: amount + 20_000n }));
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.addCredit(BigInt(index), amount))
    .addInput(receipt, contract.unlock.addCredit(BigInt(index), amount))
    .addInput(funding, members[index].signature.unlockP2PKH())
    .addOutput({
      to: contract.tokenAddress,
      amount: state.satoshis + amount,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: state.token!.nft!.commitment } },
    })
    .addOutput({
      to: contract.tokenAddress,
      amount: DUST,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: receiptCommitment(index, receipt.token!.nft!.commitment ? BigInt('0x' + receipt.token!.nft!.commitment.slice(4).match(/../g)!.reverse().join('')) + amount : amount) } },
    })
    .addOutput({ to: address, amount: 10_000n });
  await builder.send();
}

async function current(contract: Contract) {
  const all = await contract.getUtxos();
  const state = all.find((utxo) => utxo.token?.nft?.capability === 'minting') as SpendableUtxo;
  const receipts = members.map((_, index) => all.find((utxo) =>
    utxo.token?.nft?.commitment?.startsWith('52' + index.toString(16).padStart(2, '0')),
  ) as SpendableUtxo);
  return { state, receipts };
}

async function payout(provider: MockNetworkProvider, contract: Contract) {
  const { state, receipts } = await current(contract);
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2, 4), 16);
  const gross = BigInt(members.length) * CONTRIBUTION;
  const projectFee = gross / 100n;
  const feeAddress = pkhToAddress(initiator.pkh, 'chipnet');
  const feeFunding = provider.addUtxo(feeAddress, randomUtxo({ satoshis: 20_000n }));
  const nextRound = round + 1;
  const nextState = nextRound === members.length
    ? '54' + nextRound.toString(16).padStart(2, '0') + '01'
    : '54' + nextRound.toString(16).padStart(2, '0') + '01';
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.payout())
    .addInputs(receipts, contract.unlock.payout())
    .addInput(feeFunding, initiator.signature.unlockP2PKH())
    .addOutput({
      to: contract.tokenAddress,
      amount: state.satoshis - gross,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'minting', commitment: nextState } },
    });
  for (let index = 0; index < receipts.length; index++) {
    const commitment = receipts[index].token!.nft!.commitment;
    const previousCredit = BigInt('0x' + commitment.slice(4).match(/../g)!.reverse().join(''));
    builder.addOutput({
      to: contract.tokenAddress,
      amount: receipts[index].satoshis,
      token: { category: CATEGORY, amount: 0n, nft: { capability: 'none', commitment: receiptCommitment(index, previousCredit - CONTRIBUTION) } },
    });
  }
  builder.addOutput({ to: pkhToAddress(treasury.pkh, 'chipnet'), amount: projectFee });
  builder.addOutput({ to: pkhToAddress(members[round].pkh, 'chipnet'), amount: gross - projectFee });
  builder.addOutput({ to: feeAddress, amount: feeFunding.satoshis - 8_000n });
  await builder.send();
}

describe('AjoChain full-cycle escrow covenant', () => {
  it('blocks the first payout until every member has escrowed every scheduled round', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    await deposit(provider, contract, 0, CONTRIBUTION);
    await deposit(provider, contract, 1, CONTRIBUTION);
    await expect(payout(provider, contract)).rejects.toThrow();
  });

  it('lets the first recipient leave without new deposits because all future rounds were already locked', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    const fullCyclePerMember = BigInt(members.length) * CONTRIBUTION;
    await deposit(provider, contract, 0, fullCyclePerMember);
    await deposit(provider, contract, 1, fullCyclePerMember);

    await payout(provider, contract);
    let snapshot = await current(contract);
    expect(snapshot.state.token!.nft!.commitment).toBe('540101');
    expect(snapshot.receipts.map((receipt) => receipt.token!.nft!.commitment)).toEqual([
      receiptCommitment(0, CONTRIBUTION),
      receiptCommitment(1, CONTRIBUTION),
    ]);

    // No member deposits anything after the first payout. Their future dues
    // were prepaid and are still locked in their own receipts.
    await payout(provider, contract);
    snapshot = await current(contract);
    expect(snapshot.state.token!.nft!.commitment).toBe('540201');
    expect(snapshot.receipts.every((receipt) =>
      receipt.token!.nft!.commitment === receiptCommitment(
        Number.parseInt(receipt.token!.nft!.commitment.slice(2, 4), 16), 0n,
      ),
    )).toBe(true);
  });

  it('marks the finite rotation complete and rejects any further payout', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    const fullCyclePerMember = BigInt(members.length) * CONTRIBUTION;
    await deposit(provider, contract, 0, fullCyclePerMember);
    await deposit(provider, contract, 1, fullCyclePerMember);
    await payout(provider, contract);
    await payout(provider, contract);
    await expect(payout(provider, contract)).rejects.toThrow();
  });

  it('rejects deposits above the exact remaining cycle commitment', async () => {
    const provider = new MockNetworkProvider();
    const contract = makeContract(provider);
    addGenesis(provider, contract);
    await expect(deposit(provider, contract, 0, BigInt(members.length + 1) * CONTRIBUTION)).rejects.toThrow();
  });

  it('shows the first payout recipient still has all future dues escrowed', () => {
    const params: V2FeeCircleParams = {
      version: 2, covenant: 'fee-v2-escrow', name: 'Test', network: 'chipnet',
      members: ['bchtest:qone', 'bchtest:qtwo'], contribution: CONTRIBUTION,
      maxFee: MAX_FEE, stateCategory: CATEGORY, initiator: 'bchtest:qinitiator',
      treasury: 'bchtest:qtytreasury',
    };
    const ledger = summarizeV2FeeMemberAccounting(params, 1, [CONTRIBUTION, CONTRIBUTION]);
    expect(ledger[0].payoutReceived).toBe(true);
    expect(ledger[0].requiredForNextPayout).toBe(CONTRIBUTION);
    expect(ledger[0].shortfallForNextPayout).toBe(0n);
    expect(ledger[0].status).toMatch(/Received payout.*future rounds escrowed/);
    expect(ledger[1].payoutReceived).toBe(false);
    expect(ledger[1].shortfallForNextPayout).toBe(0n);
  });
});


describe('AjoChain full-cycle escrow five-member rotation', () => {
  const fiveMembers = [21, 22, 23, 24, 25].map(key);
  const fiveCategory = '9a'.repeat(32);

  function fiveContract(provider: MockNetworkProvider) {
    return new Contract(artifact, [
      fiveMembers[0].pkh, fiveMembers[1].pkh, fiveMembers[2].pkh,
      fiveMembers[3].pkh, fiveMembers[4].pkh,
      5n, CONTRIBUTION, MAX_FEE, hexToBin(fiveCategory).reverse(),
      initiator.pkh, treasury.pkh,
    ], { provider, contractType: 'p2sh32' });
  }

  function fiveGenesis(provider: MockNetworkProvider, contract: Contract) {
    provider.addUtxo(contract.address, randomUtxo({
      satoshis: DUST,
      token: { category: fiveCategory, amount: 0n, nft: { capability: 'minting', commitment: '540000' } },
    }));
    for (let index = 0; index < fiveMembers.length; index++) {
      provider.addUtxo(contract.address, randomUtxo({
        satoshis: DUST,
        token: { category: fiveCategory, amount: 0n, nft: { capability: 'none', commitment: receiptCommitment(index, 0n) } },
      }));
    }
  }

  async function depositFive(provider: MockNetworkProvider, contract: Contract, index: number) {
    const all = await contract.getUtxos();
    const state = all.find((utxo) => utxo.token?.nft?.capability === 'minting') as SpendableUtxo;
    const receipt = all.find((utxo) => utxo.token?.nft?.commitment?.startsWith('52' + index.toString(16).padStart(2, '0'))) as SpendableUtxo;
    const address = pkhToAddress(fiveMembers[index].pkh, 'chipnet');
    const amount = BigInt(fiveMembers.length) * CONTRIBUTION;
    const funding = provider.addUtxo(address, randomUtxo({ satoshis: amount + 20_000n }));
    const builder = new TransactionBuilder({ provider })
      .addInput(state, contract.unlock.addCredit(BigInt(index), amount))
      .addInput(receipt, contract.unlock.addCredit(BigInt(index), amount))
      .addInput(funding, fiveMembers[index].signature.unlockP2PKH())
      .addOutput({
        to: contract.tokenAddress,
        amount: state.satoshis + amount,
        token: { category: fiveCategory, amount: 0n, nft: { capability: 'minting', commitment: state.token!.nft!.commitment } },
      })
      .addOutput({
        to: contract.tokenAddress,
        amount: DUST,
        token: { category: fiveCategory, amount: 0n, nft: { capability: 'none', commitment: receiptCommitment(index, amount) } },
      })
      .addOutput({ to: address, amount: 10_000n });
    await builder.send();
  }

  async function payoutFive(provider: MockNetworkProvider, contract: Contract) {
    const all = await contract.getUtxos();
    const state = all.find((utxo) => utxo.token?.nft?.capability === 'minting') as SpendableUtxo;
    const receipts = fiveMembers.map((_, index) => all.find((utxo) =>
      utxo.token?.nft?.commitment?.startsWith('52' + index.toString(16).padStart(2, '0')),
    ) as SpendableUtxo);
    const round = Number.parseInt(state.token!.nft!.commitment.slice(2, 4), 16);
    const gross = BigInt(fiveMembers.length) * CONTRIBUTION;
    const feeAddress = pkhToAddress(initiator.pkh, 'chipnet');
    const funding = provider.addUtxo(feeAddress, randomUtxo({ satoshis: 20_000n }));
    const nextRound = round + 1;
    const builder = new TransactionBuilder({ provider })
      .addInput(state, contract.unlock.payout())
      .addInputs(receipts, contract.unlock.payout())
      .addInput(funding, initiator.signature.unlockP2PKH())
      .addOutput({
        to: contract.tokenAddress,
        amount: state.satoshis - gross,
        token: { category: fiveCategory, amount: 0n, nft: { capability: 'minting', commitment: '54' + nextRound.toString(16).padStart(2, '0') + '01' } },
      });
    for (let index = 0; index < receipts.length; index++) {
      const previousCredit = BigInt('0x' + receipts[index].token!.nft!.commitment.slice(4).match(/../g)!.reverse().join(''));
      builder.addOutput({
        to: contract.tokenAddress,
        amount: receipts[index].satoshis,
        token: { category: fiveCategory, amount: 0n, nft: { capability: 'none', commitment: receiptCommitment(index, previousCredit - CONTRIBUTION) } },
      });
    }
    builder.addOutput({ to: pkhToAddress(treasury.pkh, 'chipnet'), amount: gross / 100n });
    builder.addOutput({ to: pkhToAddress(fiveMembers[round].pkh, 'chipnet'), amount: gross - gross / 100n });
    builder.addOutput({ to: feeAddress, amount: funding.satoshis - 8_000n });
    await builder.send();
  }

  it('completes five payouts without further deposits and reaches round-five terminal state', async () => {
    const provider = new MockNetworkProvider();
    const contract = fiveContract(provider);
    fiveGenesis(provider, contract);
    for (let index = 0; index < fiveMembers.length; index++) {
      await depositFive(provider, contract, index);
    }
    for (let round = 0; round < fiveMembers.length; round++) {
      await payoutFive(provider, contract);
    }
    const all = await contract.getUtxos();
    const state = all.find((utxo) => utxo.token?.nft?.capability === 'minting');
    expect(state?.token?.nft?.commitment).toBe('540501');
    const receipts = fiveMembers.map((_, index) => all.find((utxo) =>
      utxo.token?.nft?.commitment?.startsWith('52' + index.toString(16).padStart(2, '0')),
    ));
    expect(receipts.every((receipt, index) =>
      receipt?.token?.nft?.commitment === receiptCommitment(index, 0n),
    )).toBe(true);
    await expect(payoutFive(provider, contract)).rejects.toThrow();
  }, 20000);
});
