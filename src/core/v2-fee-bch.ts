import {
  Contract,
  TransactionBuilder,
  placeholderP2PKHUnlocker,
  placeholderPublicKey,
  placeholderSignature,
  type Artifact,
  type NetworkProvider,
  type SpendableUtxo,
} from 'cashscript';
import { hexToBin } from '@bitauth/libauth';
import artifactJson from '../../contracts/AjoCircleV2Fee.json' with { type: 'json' };
import escrowArtifactJson from '../../contracts/AjoCircleV2FeeEscrow.json' with { type: 'json' };
import autoReserveArtifactJson from '../../contracts/AjoCircleV3AutoReserve.json' with { type: 'json' };
import { classicAddressToPkh, getClassicProvider, type ClassicNetwork } from "./classic-bch";

const addressToPkh = (address: string) => classicAddressToPkh(address, "chipnet");
const treasuryAddressToPkh = (address: string, network: ClassicNetwork) => classicAddressToPkh(address, network);
const assertNewBchContribution = (amount: bigint) => {
  if (amount < 200_000n) throw new Error("New BCH circles require at least 0.002 BCH (200,000 sats) per member per round.");
};
const getProvider = getClassicProvider;

const artifact = artifactJson as unknown as Artifact;
const escrowArtifact = escrowArtifactJson as unknown as Artifact;
const autoReserveArtifact = autoReserveArtifactJson as unknown as Artifact;
const STATE_DUST = 1_000n;
const RECEIPT_DUST = 1_000n;
const CHANGE_DUST = 546n;
const CASH_SCRIPT_INT_MAX = 0x7fffffffffffffffn;

export interface V2FeeCircleParams {
  version: 2;
  covenant: 'fee-v1' | 'fee-v2-escrow' | 'fee-v3-auto-reserve';
  name: string;
  network: ClassicNetwork;
  members: string[];
  contribution: bigint;
  maxFee: bigint;
  stateCategory: string;
  initiator: string;
  treasury: string;
}
export type V2FeeCircleDraft = Omit<V2FeeCircleParams, 'stateCategory'>;

const hex = (v: Uint8Array) => Array.from(v, b => b.toString(16).padStart(2, '0')).join('');
const feeEstimate = (memberCount: number) => 6_000n + BigInt(memberCount) * 500n;

function validate(p: V2FeeCircleDraft | V2FeeCircleParams): void {
  if (p.version !== 2 || (p.covenant !== 'fee-v1' && p.covenant !== 'fee-v2-escrow' && p.covenant !== 'fee-v3-auto-reserve') || !p.name.trim()) throw new Error('Invalid V2 fee-circle details');
  if (p.network !== 'chipnet') throw new Error('The V2 fee covenant is Chipnet-only.');
  if (p.members.length < 2 || p.members.length > 5) throw new Error('A V2 fee circle needs 2–5 members');
  const members = p.members.map(a => hex(treasuryAddressToPkh(a, p.network)));
  if (new Set(members).size !== members.length) throw new Error('Each member must have a unique BCH address');
  assertNewBchContribution(p.contribution);
  if (p.contribution > CASH_SCRIPT_INT_MAX) throw new Error('Contribution exceeds the CashScript integer limit');
  if (p.maxFee < 1_000n || p.maxFee > CASH_SCRIPT_INT_MAX) throw new Error('Maximum miner fee must be at least 1,000 sats and within the CashScript integer limit');
  const pot = BigInt(p.members.length) * p.contribution;
  const projectFee = pot / 100n;
  if (projectFee < 546n) throw new Error('The 1% project fee must be at least 546 sats to remain dust-safe');
  if (p.maxFee > pot - projectFee - 546n) throw new Error('Maximum miner fee must leave a dust-safe payout after the 1% project fee');
  const estimate = feeEstimate(p.members.length);
  if (p.maxFee < estimate) throw new Error(`This V2 fee version needs maxFee of at least ${estimate.toString()} sats for its conservative transaction estimate.`);
  treasuryAddressToPkh(p.initiator, p.network);
  treasuryAddressToPkh(p.treasury, p.network);
}

function contractFor(p: V2FeeCircleParams, provider: NetworkProvider): Contract {
  validate(p);
  const pkhs = p.members.map(addressToPkh);
  while (pkhs.length < 5) pkhs.push(new Uint8Array(20));
  return new Contract(p.covenant === 'fee-v3-auto-reserve' ? autoReserveArtifact : p.covenant === 'fee-v2-escrow' ? escrowArtifact : artifact, [
    pkhs[0], pkhs[1], pkhs[2], pkhs[3], pkhs[4],
    BigInt(p.members.length), p.contribution, p.maxFee,
    hexToBin(p.stateCategory).reverse(),
    addressToPkh(p.initiator),
    treasuryAddressToPkh(p.treasury, p.network),
  ] as any, { provider, contractType: 'p2sh32' });
}

export function v2FeeStateCommitment(round: number, hasPaid: boolean): string {
  if (!Number.isInteger(round) || round < 0 || round > 5) throw new Error('Invalid V2 fee state round');
  return '54' + round.toString(16).padStart(2, '0') + (hasPaid ? '01' : '00');
}

/** Validate the exact three-byte state NFT commitment: prefix | round | hasPaid. */
export function isValidV2FeeStateCommitment(commitment: string): boolean {
  return typeof commitment === 'string' && /^54(?:0[0-5])(?:00|01)$/i.test(commitment);
}

/**
 * Enforce the state transition invariant for escrow and auto-reserve circles:
 * round zero is the unspent genesis state; every later round proves a payout.
 * Legacy fee-v1 deliberately wraps its round counter and retains its old rules.
 */
export function assertV2FeeStateCommitmentSemantics(
  covenant: V2FeeCircleParams['covenant'],
  memberCount: number,
  commitment: string,
): void {
  if (covenant === 'fee-v1') return;
  if (!Number.isInteger(memberCount) || memberCount < 2 || memberCount > 5 ||
      !isValidV2FeeStateCommitment(commitment)) {
    throw new Error('Invalid V2 fee state commitment.');
  }
  const round = Number.parseInt(commitment.slice(2, 4), 16);
  const hasPaid = commitment.slice(4) === '01';
  if (round > memberCount || (round === 0 && hasPaid) || (round > 0 && !hasPaid)) {
    throw new Error('V2 fee state round and irreversible payout marker are inconsistent.');
  }
}

/** Reject deposits for terminal or impossible payout rounds before building a wallet transaction. */
export function assertV2FeeDepositRoundOpen(
  covenant: V2FeeCircleParams['covenant'],
  round: number,
  memberCount: number,
): void {
  if (!Number.isSafeInteger(round) || round < 0 || round >= memberCount) {
    if (covenant !== 'fee-v1' && round === memberCount) {
      throw new Error('This circle has completed every scheduled payout. No further deposits are accepted.');
    }
    throw new Error('Invalid V2 fee deposit round; no deposit can be prepared for this state.');
  }
}

export function v2FeeReceiptCommitment(index: number, credit: bigint): string {
  if (!Number.isInteger(index) || index < 0 || index > 4 || credit < 0n || credit > CASH_SCRIPT_INT_MAX) throw new Error('Invalid V2 member receipt data');
  return '52' + index.toString(16).padStart(2, '0') + credit.toString(16).padStart(16, '0').match(/../g)!.reverse().join('');
}


export interface V2FeeMemberAccounting {
  index: number;
  address: string;
  currentCredit: bigint;
  requiredForNextPayout: bigint;
  shortfallForNextPayout: bigint;
  contributionsAlreadyConsumed: bigint;
  totalPaidIn: bigint | null;
  totalCycleContribution: bigint;
  remainingContributionCommitment: bigint | null;
  prepaidRounds: number;
  payoutReceived: boolean | null;
  payoutAmountReceived: bigint;
  fullySecured: boolean;
  status: string;
}

export function summarizeV2FeeMemberAccounting(
  params: V2FeeCircleParams,
  round: number,
  credits: readonly bigint[],
): V2FeeMemberAccounting[] {
  const memberCount = params.members.length;
  const completed = params.covenant !== 'fee-v1' && round === memberCount;
  if (!Number.isSafeInteger(round) || round < 0 || round > memberCount || credits.length !== memberCount) {
    throw new Error('Member accounting snapshot does not match the on-chain circle state.');
  }
  if (params.covenant === 'fee-v1' && round === memberCount) {
    throw new Error('Legacy rolling-credit state has an invalid round.');
  }
  const remainingRounds = completed ? 0 : memberCount - round;
  const contributionAlreadyConsumed = BigInt(round) * params.contribution;
  const fullCycleContribution = BigInt(memberCount) * params.contribution;
  const grossPot = BigInt(memberCount) * params.contribution;
  const projectFee = grossPot / 100n;
  return params.members.map((address, index) => {
    const currentCredit = credits[index];
    const payoutReceived = params.covenant !== 'fee-v1' ? index < round : null;
    let requiredForNextPayout = completed ? 0n : params.contribution;
    if (params.covenant === 'fee-v2-escrow') {
      requiredForNextPayout = BigInt(remainingRounds) * params.contribution;
    } else if (params.covenant === 'fee-v3-auto-reserve' && index < round) {
      requiredForNextPayout = params.contribution;
    }
    const shortfallForNextPayout = requiredForNextPayout > currentCredit
      ? requiredForNextPayout - currentCredit : 0n;
    // A V3 recipient's automatic reserve is funded from their payout, not a
    // member deposit. Exclude it both while held and after it funds the next round.
    const isCurrentReserveHolder = params.covenant === 'fee-v3-auto-reserve' &&
      !completed && round > 0 && index === round - 1 && index < memberCount - 1;
    if (isCurrentReserveHolder && currentCredit !== params.contribution) {
      throw new Error('Latest V3 recipient receipt does not contain its exact automatic reserve.');
    }
    const hasConsumedAutomaticReserve = params.covenant === 'fee-v3-auto-reserve' &&
      index < memberCount - 1 && round > index + 1;
    const totalPaidIn = params.covenant === 'fee-v1'
      ? null
      : params.covenant === 'fee-v3-auto-reserve'
        ? contributionAlreadyConsumed + currentCredit -
          (hasConsumedAutomaticReserve ? params.contribution : 0n) -
          (isCurrentReserveHolder ? params.contribution : 0n)
        : contributionAlreadyConsumed + currentCredit;
    const commitmentCovered = contributionAlreadyConsumed + currentCredit;
    const remainingContributionCommitment = params.covenant === 'fee-v1'
      ? null
      : (fullCycleContribution > commitmentCovered ? fullCycleContribution - commitmentCovered : 0n);
    const prepaidRounds = Number(currentCredit / params.contribution);
    const fullySecured = completed || currentCredit >= requiredForNextPayout;
    const futureReserve = params.covenant === 'fee-v3-auto-reserve' && index < memberCount - 1
      ? params.contribution
      : 0n;
    const historicalPayout = params.covenant === 'fee-v3-auto-reserve'
      ? grossPot - projectFee - futureReserve
      : grossPot - projectFee;
    const status = completed
      ? 'Circle complete'
      : params.covenant === 'fee-v3-auto-reserve'
        ? payoutReceived
          ? fullySecured ? 'Payout received · next installment reserved' : 'Payout received · next installment due'
          : fullySecured ? 'Current contribution funded · awaiting turn' : 'Current contribution due'
        : params.covenant === 'fee-v2-escrow'
          ? payoutReceived
            ? fullySecured ? 'Received payout · future rounds escrowed' : 'Received payout · shortfall'
            : fullySecured ? 'Fully escrowed · awaiting turn' : 'Must fund remaining rounds'
          : currentCredit >= params.contribution
            ? 'Next round funded · legacy rolling mode'
            : 'Contribution due · legacy rolling mode';
    return {
      index, address, currentCredit, requiredForNextPayout, shortfallForNextPayout,
      contributionsAlreadyConsumed: contributionAlreadyConsumed,
      totalPaidIn, totalCycleContribution: fullCycleContribution,
      remainingContributionCommitment, prepaidRounds, payoutReceived,
      payoutAmountReceived: payoutReceived ? historicalPayout : 0n,
      fullySecured, status,
    };
  });
}

export function v2FeeCreditFromCommitment(commitment: string): bigint {
  if (!/^52[0-4][0-9a-f][0-9a-f]{16}$/i.test(commitment)) throw new Error('Invalid V2 member receipt commitment');
  const credit = BigInt('0x' + commitment.slice(4).match(/../g)!.reverse().join(''));
  if (credit > CASH_SCRIPT_INT_MAX) throw new Error('Member credit exceeds the CashScript integer limit');
  return credit;
}

function findState(
  utxos: SpendableUtxo[],
  category: string,
  covenant: V2FeeCircleParams['covenant'],
  memberCount: number,
) {
  const matches = utxos.filter(u => u.token?.category === category && u.token.nft?.capability === 'minting' && isValidV2FeeStateCommitment(u.token.nft.commitment));
  if (matches.length !== 1) throw new Error(matches.length ? 'Multiple V2 fee state NFTs found; stop and investigate.' : 'V2 fee state NFT not found or has an invalid commitment.');
  if (matches[0].token!.amount !== 0n) throw new Error('V2 fee state NFT unexpectedly carries fungible tokens.');
  assertV2FeeStateCommitmentSemantics(covenant, memberCount, matches[0].token!.nft!.commitment);
  return matches[0];
}

function findReceipt(utxos: SpendableUtxo[], category: string, index: number) {
  const prefix = '52' + index.toString(16).padStart(2, '0');
  const matches = utxos.filter(u => u.token?.category === category && u.token.nft?.capability === 'none' && u.token.nft.commitment.startsWith(prefix));
  if (matches.length !== 1) throw new Error(matches.length ? `Duplicate receipt for member ${index + 1}; stop and investigate.` : `Missing receipt for member ${index + 1}; refresh the circle.`);
  if (matches[0].token!.amount !== 0n) throw new Error(`Member ${index + 1} receipt unexpectedly carries fungible tokens.`);
  v2FeeCreditFromCommitment(matches[0].token!.nft!.commitment);
  return matches[0];
}

function assertUtxoSet(
  utxos: SpendableUtxo[],
  category: string,
  memberCount: number,
  covenant: V2FeeCircleParams['covenant'],
) {
  const categoryUtxos = utxos.filter(u => u.token?.category === category);
  if (categoryUtxos.length !== memberCount + 1) throw new Error(`Invalid V2 fee token set: expected ${memberCount + 1} state/receipt NFTs, found ${categoryUtxos.length}. Stop and investigate.`);
  const state = findState(utxos, category, covenant, memberCount);
  const receipts = Array.from({ length: memberCount }, (_, index) => findReceipt(utxos, category, index));
  const known = new Set([state, ...receipts].map(u => `${u.txid}:${u.vout}`));
  if (categoryUtxos.some(u => !known.has(`${u.txid}:${u.vout}`))) throw new Error('Unexpected CashToken output found at the V2 fee circle address. Stop and investigate.');
}

function pickFunding(utxos: SpendableUtxo[], required: bigint) {
  const coin = [...utxos].filter(u => !u.token).sort((a, b) => a.satoshis > b.satoshis ? -1 : 1).find(u => u.satoshis >= required);
  if (!coin) throw new Error('No single BCH coin can cover this action and its fee reserve. Consolidate funds first.');
  return coin;
}

/** Genesis creates a new 0x54 state NFT and one immutable receipt per member. */
export async function planV2FeeGenesis(draft: V2FeeCircleDraft, walletAddress: string) {
  const paramsBase = { ...draft, initiator: walletAddress };
  validate({ ...paramsBase, stateCategory: '00'.repeat(32) });
  const provider = await getProvider(draft.network);
  const coins = (await provider.getUtxos(walletAddress)).filter(u => !u.token);
  const genesis = coins.find(u => u.vout === 0 && u.satoshis >= 3_000n);
  if (!genesis) throw new Error('V2 fee creation needs a non-token BCH UTXO at vout 0 for its CashTokens category. Check wallet funding before sending more BCH.');
  const params: V2FeeCircleParams = { ...paramsBase, stateCategory: genesis.txid };
  const contract = contractFor(params, provider);
  const inputs: SpendableUtxo[] = [genesis];
  let total = genesis.satoshis;
  const fee = feeEstimate(params.members.length);
  for (const coin of coins) {
    if (coin.txid === genesis.txid && coin.vout === genesis.vout) continue;
    if (total >= STATE_DUST + BigInt(params.members.length) * RECEIPT_DUST + fee + CHANGE_DUST) break;
    inputs.push(coin);
    total += coin.satoshis;
  }
  const change = total - STATE_DUST - BigInt(params.members.length) * RECEIPT_DUST - fee;
  if (change < CHANGE_DUST) throw new Error('Not enough BCH to create the V2 fee state, receipts, and change.');
  const builder = new TransactionBuilder({ provider });
  inputs.forEach(u => builder.addInput(u, placeholderP2PKHUnlocker(walletAddress)));
  builder.addOutput({ to: contract.tokenAddress, amount: STATE_DUST, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'minting', commitment: v2FeeStateCommitment(0, false) } } });
  for (let i = 0; i < params.members.length; i++) builder.addOutput({ to: contract.tokenAddress, amount: RECEIPT_DUST, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'none', commitment: v2FeeReceiptCommitment(i, 0n) } } });
  builder.addOutput({ to: walletAddress, amount: change });
  return { params, contract, wc: builder.generateWcTransactionObject({ broadcast: false, userPrompt: `Create V2 fee circle "${params.name}" and mint ${params.members.length} member receipts` }), walletInputs: inputs.map((_, i) => i) };
}

/** Member-specific deposit preserves the 0x54 state and increments only that member's receipt. */
export async function planV2FeeDeposit(params: V2FeeCircleParams, memberIndex: number, amount: bigint, walletAddress: string) {
  validate(params);
  if (!Number.isInteger(memberIndex) || memberIndex < 0 || memberIndex >= params.members.length) throw new Error('Invalid member index');
  if (amount <= 0n || amount > CASH_SCRIPT_INT_MAX) throw new Error('Deposit amount is outside the supported CashScript integer range');
  if (hex(addressToPkh(params.members[memberIndex])) !== hex(addressToPkh(walletAddress))) throw new Error('Connected wallet does not match this member slot.');
  const provider = await getProvider(params.network);
  const contract = contractFor(params, provider);
  const all = await contract.getUtxos();
  assertUtxoSet(all, params.stateCategory, params.members.length, params.covenant);
  const state = findState(all, params.stateCategory, params.covenant, params.members.length);
  const currentRound = Number.parseInt(state.token!.nft!.commitment.slice(2, 4), 16);
  assertV2FeeDepositRoundOpen(params.covenant, currentRound, params.members.length);
  const allReceipts = params.members.map((_, i) => findReceipt(all, params.stateCategory, i));
  const allCredits = allReceipts.map(u => v2FeeCreditFromCommitment(u.token!.nft!.commitment));
  if (state.satoshis !== allCredits.reduce((sum, credit) => sum + credit, STATE_DUST)) throw new Error('State BCH does not match the exact member-credit total. Stop and investigate.');
  const receipt = allReceipts[memberIndex];
  const remainingRounds = params.members.length - currentRound;
  const maximumEscrow = params.covenant === 'fee-v2-escrow'
    ? BigInt(remainingRounds) * params.contribution
    : params.covenant === 'fee-v3-auto-reserve'
      ? params.contribution
      : CASH_SCRIPT_INT_MAX;
  const fee = feeEstimate(params.members.length);
  if (fee > params.maxFee) throw new Error('The configured maxFee is too low for a safe V2 member deposit.');
  const funding = pickFunding((await provider.getUtxos(walletAddress)).filter(u => !u.token), amount + fee + CHANGE_DUST);
  const oldCredit = v2FeeCreditFromCommitment(receipt.token!.nft!.commitment);
  if (oldCredit + amount > CASH_SCRIPT_INT_MAX) throw new Error('This deposit would exceed the supported member-credit limit.');
  if (oldCredit + amount > maximumEscrow) {
    throw new Error('Deposit exceeds this member\'s exact remaining circle commitment. Add no more than ' +
      (maximumEscrow > oldCredit ? (maximumEscrow - oldCredit).toString() : '0') + ' sats.');
  }
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.addCredit(BigInt(memberIndex), amount))
    .addInput(receipt, contract.unlock.addCredit(BigInt(memberIndex), amount))
    .addInput(funding, placeholderP2PKHUnlocker(walletAddress))
    .addOutput({ to: contract.tokenAddress, amount: state.satoshis + amount, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'minting', commitment: state.token!.nft!.commitment } } })
    .addOutput({ to: contract.tokenAddress, amount: receipt.satoshis, token: { category: params.stateCategory, amount: 0n, nft: { capability: 'none', commitment: v2FeeReceiptCommitment(memberIndex, oldCredit + amount) } } })
    .addOutput({ to: walletAddress, amount: funding.satoshis - amount - fee });
  return {
    wc: builder.generateWcTransactionObject({ broadcast: false, userPrompt: 'Add credit to your V2 member receipt' }),
    walletInputs: [2],
    memberIndex,
    credited: amount,
    newCredit: oldCredit + amount,
    shortfall: (params.covenant !== 'fee-v1' ? maximumEscrow : params.contribution) > oldCredit
      ? (params.covenant !== 'fee-v1' ? maximumEscrow : params.contribution) - oldCredit
      : 0n,
    requiredCredit: params.covenant !== 'fee-v1' ? maximumEscrow : params.contribution,
  };
}

/** Any circle participant can trigger payout and sponsor miner fees from a separate BCH input. */
export async function planV2FeePayout(params: V2FeeCircleParams, feePayerAddress: string) {
  validate(params);
  if (!feePayerAddress) throw new Error("A connected Chipnet fee-payer address is required.");
  classicAddressToPkh(feePayerAddress, "chipnet");
  const provider = await getProvider(params.network);
  const contract = contractFor(params, provider);
  const all = await contract.getUtxos();
  assertUtxoSet(all, params.stateCategory, params.members.length, params.covenant);
  const state = findState(all, params.stateCategory, params.covenant, params.members.length);
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2, 4), 16);
  const hasPaid = state.token!.nft!.commitment.slice(4) === "01";
  if (!Number.isInteger(round) || round < 0 || round >= params.members.length) {
    throw new Error(params.covenant !== 'fee-v1' && round === params.members.length
      ? "This circle has completed every scheduled payout."
      : "Invalid V2 fee payout round.");
  }
  const receipts = params.members.map((_, i) => findReceipt(all, params.stateCategory, i));
  const credits = receipts.map((u) => v2FeeCreditFromCommitment(u.token!.nft!.commitment));
  if (state.satoshis !== credits.reduce((sum, credit) => sum + credit, STATE_DUST)) {
    throw new Error("State BCH does not match the exact member-credit total. Stop and investigate.");
  }
  const remainingRounds = params.members.length - round;
  const requiredCredits = credits.map(() => params.covenant === 'fee-v2-escrow'
    ? BigInt(remainingRounds) * params.contribution
    : params.contribution);
  if (credits.some((credit, index) => credit < requiredCredits[index])) {
    throw new Error(params.covenant === 'fee-v2-escrow'
      ? "Payout blocked: every member must have the full remaining circle commitment locked in their own receipt."
      : params.covenant === 'fee-v3-auto-reserve'
        ? "Payout blocked: every member must have one contribution available for this round, either from the previous payout reserve or a fresh deposit."
        : "Payout is blocked until every member has one full contribution in their own receipt.");
  }
  const pot = BigInt(params.members.length) * params.contribution;
  const autoReserve = params.covenant === 'fee-v3-auto-reserve' && round < params.members.length - 1
    ? params.contribution
    : 0n;
  const projectFee = pot / 100n;
  const recipientPayoutBeforeReserve = pot - projectFee;
  const recipientPayout = recipientPayoutBeforeReserve - autoReserve;
  const autoReservePercentHundredths = autoReserve === 0n || recipientPayoutBeforeReserve <= 0n
    ? 0n
    : (autoReserve * 10_000n + recipientPayoutBeforeReserve / 2n) / recipientPayoutBeforeReserve;
  const autoReservePercent = (autoReservePercentHundredths / 100n).toString() + "." +
    (autoReservePercentHundredths % 100n).toString().padStart(2, "0");
  const minerFee = feeEstimate(params.members.length);
  if (minerFee > params.maxFee) throw new Error("Estimated miner fee exceeds this circle maxFee.");
  if (state.satoshis - pot + autoReserve < STATE_DUST) {
    throw new Error("Payout would reduce the state reserve below 1,000 sats.");
  }
  if (projectFee < 546n || recipientPayout < CHANGE_DUST) {
    throw new Error("The project fee or automatic future-contribution reserve would leave an invalid recipient amount.");
  }

  const feeCoins = (await provider.getUtxos(feePayerAddress)).filter((u) => !u.token);
  const feeFunding = pickFunding(feeCoins, minerFee + CHANGE_DUST);
  const feeChange = feeFunding.satoshis - minerFee;

  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.payout())
    .addInputs(receipts, contract.unlock.payout())
    .addInput(feeFunding, placeholderP2PKHUnlocker(feePayerAddress))
    .addOutput({
      to: contract.tokenAddress,
      amount: state.satoshis - pot + autoReserve,
      token: { category: params.stateCategory, amount: 0n,
        nft: { capability: "minting", commitment: v2FeeStateCommitment(
          params.covenant !== 'fee-v1' ? round + 1 : (round + 1) % params.members.length,
          true,
        ) } },
    });
  receipts.forEach((receipt, index) => {
    builder.addOutput({
      to: contract.tokenAddress,
      amount: receipt.satoshis,
      token: { category: params.stateCategory, amount: 0n,
        nft: { capability: "none", commitment: v2FeeReceiptCommitment(index, credits[index] - params.contribution + (index === round ? autoReserve : 0n)) } },
    });
  });
  builder.addOutput({ to: params.treasury, amount: projectFee });
  // Exactly one next contribution stays in the state reserve and is credited to the recipient's receipt.
  // The final recipient has no next installment, so no reserve is withheld.
  builder.addOutput({ to: params.members[round], amount: recipientPayout });
  // Miner fee is separately funded by the caller and change returns to that wallet.
  builder.addOutput({ to: feePayerAddress, amount: feeChange });

  return {
    wc: builder.generateWcTransactionObject({
      broadcast: false,
      userPrompt: "Pay AjoChain V2 round " + (round + 1) + "; BCH miner fee is paid separately by your wallet",
    }),
    walletInputs: [params.members.length + 1],
    round,
    recipient: params.members[round],
    gross: pot,
    projectFee,
    minerFee,
    payout: recipientPayout,
    autoReserve,
    autoReservePercent,
    futureContributionCount: params.covenant === 'fee-v3-auto-reserve' && round < params.members.length - 1 ? 1 : 0,
    hasPaid,
    feePayerAddress,
    requiredPerMember: params.covenant === 'fee-v2-escrow' ? BigInt(remainingRounds) * params.contribution : params.contribution,
    requiredCredits,
    remainingRounds,
    hasAutomaticFutureReserve: params.covenant === 'fee-v3-auto-reserve',
  };
}

/** Initiator-only cancellation refunds every member's exact receipt credit and attached BCH. */
export async function planV2FeeCancel(params: V2FeeCircleParams, walletAddress: string) {
  validate(params);
  if (hex(addressToPkh(walletAddress)) !== hex(addressToPkh(params.initiator))) throw new Error('Only the circle initiator can cancel before the first payout.');
  const provider = await getProvider(params.network);
  const contract = contractFor(params, provider);
  const all = await contract.getUtxos();
  assertUtxoSet(all, params.stateCategory, params.members.length, params.covenant);
  const state = findState(all, params.stateCategory, params.covenant, params.members.length);
  const stateCommitment = state.token!.nft!.commitment;
  const round = Number.parseInt(stateCommitment.slice(2, 4), 16);
  const hasPaid = stateCommitment.slice(4) === '01';
  if (hasPaid) throw new Error('Cancellation is permanently disabled after the first payout.');
  if (!Number.isInteger(round) || round < 0 || round >= params.members.length) throw new Error('Invalid V2 fee state round.');
  const receipts = params.members.map((_, i) => findReceipt(all, params.stateCategory, i));
  const credits = receipts.map(u => v2FeeCreditFromCommitment(u.token!.nft!.commitment));
  if (state.satoshis !== credits.reduce((sum, credit) => sum + credit, STATE_DUST)) throw new Error('State BCH does not match the exact member-credit total. Stop and investigate.');
  const minerFee = feeEstimate(params.members.length);
  if (minerFee > params.maxFee) throw new Error('Estimated cancellation miner fee exceeds this circle maxFee.');
  const requiredFunding = minerFee - STATE_DUST + CHANGE_DUST;
  const funding = pickFunding((await provider.getUtxos(walletAddress)).filter(u => !u.token), requiredFunding);
  const change = funding.satoshis + STATE_DUST - minerFee;
  if (change < CHANGE_DUST) throw new Error('The initiator fee input cannot fund a dust-safe cancellation.');
  const builder = new TransactionBuilder({ provider });
  const pk = placeholderPublicKey();
  const sig = placeholderSignature();
  const contractUnlocker = contract.unlock.cancel(pk, sig);
  builder.addInput(state, contractUnlocker);
  builder.addInputs(receipts, contractUnlocker);
  builder.addInput(funding, placeholderP2PKHUnlocker(walletAddress));
  receipts.forEach((receipt, i) => builder.addOutput({ to: params.members[i], amount: receipt.satoshis + credits[i] }));
  builder.addOutput({ to: walletAddress, amount: change });
  const wc = builder.generateWcTransactionObject({ broadcast: false, userPrompt: `Cancel V2 circle "${params.name}" and refund every member` });
  return { wc, walletInputs: Array.from({ length: params.members.length + 2 }, (_, i) => i), minerFee, refunds: credits };
}

/** Read and validate the complete V2 fee state before showing balances or actions. */
export async function readV2FeeCircle(params: V2FeeCircleParams) {
  validate(params);
  const provider = await getProvider(params.network);
  const contract = contractFor(params, provider);
  const utxos = await contract.getUtxos();
  assertUtxoSet(utxos, params.stateCategory, params.members.length, params.covenant);
  const state = findState(utxos, params.stateCategory, params.covenant, params.members.length);
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2, 4), 16);
  const hasPaid = state.token!.nft!.commitment.slice(4) === '01';
  const completed = params.covenant !== 'fee-v1' && round === params.members.length;
  if (!Number.isInteger(round) || round < 0 ||
      (params.covenant !== 'fee-v1' ? round > params.members.length : round >= params.members.length)) {
    throw new Error('Invalid V2 fee payout round.');
  }
  if (completed && !hasPaid) throw new Error('Completed circle state is missing its irreversible payout marker.');
  const receipts = params.members.map((_, i) => findReceipt(utxos, params.stateCategory, i));
  const credits = receipts.map(u => v2FeeCreditFromCommitment(u.token!.nft!.commitment));
  if (state.satoshis !== credits.reduce((sum, credit) => sum + credit, STATE_DUST)) throw new Error('State BCH does not match the exact member-credit total. Stop and investigate.');
  const memberAccounting = summarizeV2FeeMemberAccounting(params, round, credits);
  const requiredPerMember = params.covenant === 'fee-v2-escrow'
    ? BigInt(params.members.length - round) * params.contribution
    : params.contribution;
  return {
    contract,
    utxos,
    round,
    hasPaid,
    completed,
    stateSatoshis: state.satoshis,
    credits,
    memberAccounting,
    requiredPerMember,
    remainingRounds: params.members.length - round,
    ready: !completed && memberAccounting.every((account) => account.fullySecured),
    recipient: completed ? null : params.members[round],
  };
}
