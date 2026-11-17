import {
  Contract,
  TransactionBuilder,
  placeholderP2PKHUnlocker,
  type Artifact,
  type NetworkProvider,
  type SpendableUtxo,
} from "cashscript";
import { binToHex, decodeCashAddress, getDustThreshold, hexToBin } from "@bitauth/libauth";
import circleArtifactJson from "../../contracts/AjoCirclePUSDV3Mainnet.json" with { type: "json" };
import escrowArtifactJson from "../../contracts/AjoPUSDMemberEscrowV3.json" with { type: "json" };
import { CASH_TOKEN_MAX_AMOUNT, PUSD_ASSET } from "./assets";
import { classicAddressToPkh, getClassicProvider } from "./classic-bch";
import { calculatePusdCircleEconomics } from "./pusd-circle-economics";
import { fetchPusdFeeQuote, fetchPusdWalletBalance } from "./pusd-api";
import { getMainnetProjectTreasuryPkh } from "./project-treasury";

const circleArtifact = circleArtifactJson as unknown as Artifact;
const escrowArtifact = escrowArtifactJson as unknown as Artifact;
const STATE_DUST = 1_000n;
const RECEIPT_DUST = 1_000n;
const ESCROW_DUST = 1_000n;
const CHANGE_DUST = 546n;
const CASH_SCRIPT_INT_MAX = 0x7fffffffffffffffn;

export interface PusdMainnetCircleDraft {
  version: 3;
  name: string;
  network: "mainnet";
  members: string[];
  contribution: bigint;
  maxFee: bigint;
  initiator: string;
}

export interface PusdMainnetCircleParams extends PusdMainnetCircleDraft {
  stateCategory: string;
  treasury: string;
}

export interface PusdMainnetCircleSnapshot {
  params: PusdMainnetCircleParams;
  contract: Contract;
  escrows: Contract[];
  state: SpendableUtxo;
  receipts: SpendableUtxo[];
  escrowUtxos: SpendableUtxo[];
  credits: bigint[];
  round: number;
  completed: boolean;
  ready: boolean;
  recipient: string | null;
}

export interface PusdMainnetTransactionPlan {
  wc: unknown;
  walletInputs: number[];
  feeEstimate: bigint;
  transactionSizeBytes: number;
  contractAddress?: string;
  escrowAddresses?: string[];
  projectTreasury: string;
  summary: string;
}

function toHex(bytes: Uint8Array) {
  return binToHex(bytes).toLowerCase();
}

function receiptCommitment(index: number, credit: bigint): string {
  if (!Number.isInteger(index) || index < 0 || index > 4 ||
      credit < 0n || credit > CASH_SCRIPT_INT_MAX) {
    throw new Error("Invalid PUSD member receipt data.");
  }
  return "52" + index.toString(16).padStart(2, "0") +
    credit.toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
}

function creditFromCommitment(commitment: string): bigint {
  if (!/^52[0-4][0-9a-f][0-9a-f]{16}$/i.test(commitment)) {
    throw new Error("PUSD circle has an invalid member receipt commitment.");
  }
  const amount = BigInt("0x" + commitment.slice(4).match(/../g)!.reverse().join(""));
  if (amount > CASH_SCRIPT_INT_MAX) throw new Error("PUSD member receipt exceeds the covenant integer limit.");
  return amount;
}

function stateCommitment(round: number, hasPaid: boolean) {
  if (!Number.isSafeInteger(round) || round < 0 || round > 5) {
    throw new Error("Invalid PUSD circle round.");
  }
  return "54" + round.toString(16).padStart(2, "0") + (hasPaid ? "01" : "00");
}

function decodeStateCommitment(commitment: string, memberCount: number) {
  if (!/^54(?:0[0-5])(?:00|01)$/i.test(commitment)) {
    throw new Error("PUSD circle state NFT has an invalid commitment.");
  }
  const round = Number.parseInt(commitment.slice(2, 4), 16);
  const hasPaid = commitment.slice(4) === "01";
  if (round > memberCount || (round === 0 && hasPaid) || (round > 0 && !hasPaid)) {
    throw new Error("PUSD circle round and irreversible payout marker are inconsistent.");
  }
  return { round, hasPaid, completed: round === memberCount };
}

function tokenAwareP2pkh(address: string): Uint8Array {
  const decoded = decodeCashAddress(address.trim());
  if (typeof decoded === "string" || decoded.prefix !== "bitcoincash" ||
      String(decoded.type).toLowerCase() !== "p2pkhwithtokens" ||
      decoded.payload.length !== 20) {
    throw new Error("PUSD circle members must use token-aware P2PKH Bitcoin Cash Mainnet addresses.");
  }
  return decoded.payload;
}

function validateDraft(draft: PusdMainnetCircleDraft) {
  if (draft.version !== 3 || draft.network !== "mainnet" ||
      !draft.name.trim() || draft.name.trim().length > 60) {
    throw new Error("Invalid PUSD Mainnet circle details.");
  }
  if (!Array.isArray(draft.members) || draft.members.length < 2 || draft.members.length > 5) {
    throw new Error("A PUSD Mainnet circle needs 2–5 members.");
  }
  const memberKeys = draft.members.map(tokenAwareP2pkh).map(toHex);
  if (new Set(memberKeys).size !== memberKeys.length) {
    throw new Error("Each PUSD circle member must have a unique Mainnet address.");
  }
  const initiatorPkh = classicAddressToPkh(draft.initiator, "mainnet");
  if (draft.maxFee < 1_000n || draft.maxFee > CASH_SCRIPT_INT_MAX) {
    throw new Error("Maximum BCH miner fee must be at least 1,000 sats and within the covenant integer range.");
  }
  if (draft.contribution <= 0n || draft.contribution > CASH_TOKEN_MAX_AMOUNT) {
    throw new Error("PUSD contribution is outside the supported CashTokens amount range.");
  }
  calculatePusdCircleEconomics(draft.members.length, draft.contribution);
  return { memberKeys, initiatorPkh };
}

function circleContracts(params: PusdMainnetCircleParams, provider: NetworkProvider) {
  const memberPkhs = params.members.map(tokenAwareP2pkh);
  const pusdCategory = hexToBin(PUSD_ASSET.categoryId).reverse();
  const stateCategory = hexToBin(params.stateCategory).reverse();
  const escrows = params.members.map((_, index) => new Contract(escrowArtifact, [
    stateCategory,
    pusdCategory,
    BigInt(params.members.length),
    BigInt(index),
    params.contribution,
    memberPkhs[index],
  ], { provider, contractType: "p2sh32" }));

  const paddedMembers = [...memberPkhs];
  while (paddedMembers.length < 5) paddedMembers.push(new Uint8Array(20));
  const paddedEscrowLocks = escrows.map((escrow) => escrow.lockingBytecode);
  while (paddedEscrowLocks.length < 5) paddedEscrowLocks.push(escrows[0].lockingBytecode);

  const contract = new Contract(circleArtifact, [
    paddedMembers[0], paddedMembers[1], paddedMembers[2], paddedMembers[3], paddedMembers[4],
    BigInt(params.members.length),
    params.contribution,
    params.maxFee,
    stateCategory,
    pusdCategory,
    classicAddressToPkh(params.initiator, "mainnet"),
    getMainnetProjectTreasuryPkh(),
    paddedEscrowLocks[0], paddedEscrowLocks[1], paddedEscrowLocks[2],
    paddedEscrowLocks[3], paddedEscrowLocks[4],
  ], { provider, contractType: "p2sh32" });

  return { contract, escrows };
}

function selectBchInputs(
  utxos: readonly SpendableUtxo[],
  requiredSatoshis: bigint,
  excludedOutpoint?: string,
) {
  const coins = utxos
    .filter((utxo) => !utxo.token && utxo.satoshis > 0n &&
      (utxo.txid + ":" + utxo.vout) !== excludedOutpoint)
    .sort((a, b) => a.satoshis === b.satoshis ? 0 : a.satoshis > b.satoshis ? -1 : 1);
  const selected: SpendableUtxo[] = [];
  let total = 0n;
  for (const coin of coins) {
    selected.push(coin);
    total += coin.satoshis;
    if (total >= requiredSatoshis) break;
  }
  if (total < requiredSatoshis) {
    throw new Error("The connected wallet does not have enough spendable BCH for the circle carrier outputs and miner-fee reserve.");
  }
  return { selected, total };
}

function pusdCarrierSatoshis(lockingBytecode: Uint8Array, amount: bigint): bigint {
  const threshold = getDustThreshold({
    valueSatoshis: 0n,
    lockingBytecode,
    token: { category: hexToBin(PUSD_ASSET.categoryId), amount },
  });
  if (threshold < 1n) throw new Error("Could not calculate a positive BCH carrier for this PUSD output.");
  return threshold;
}

function selectSingleBchCoin(
  utxos: readonly SpendableUtxo[],
  requiredSatoshis: bigint,
): SpendableUtxo {
  const coin = [...utxos]
    .filter((utxo) => !utxo.token && utxo.satoshis >= requiredSatoshis)
    .sort((a, b) => a.satoshis === b.satoshis ? 0 : a.satoshis > b.satoshis ? -1 : 1)[0];
  if (!coin) {
    throw new Error("No single BCH-only UTXO can cover this action's miner-fee reserve and dust-safe change.");
  }
  return coin;
}

function transactionSizeBytes(builder: TransactionBuilder): number {
  const built = builder.build();
  if (typeof built !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(built)) {
    throw new Error("Could not serialize the unsigned PUSD Mainnet transaction for fee estimation.");
  }
  return built.length / 2;
}

async function estimateFee(builder: TransactionBuilder, maxFee: bigint) {
  const size = transactionSizeBytes(builder);
  const quote = await fetchPusdFeeQuote();
  const rateFee = (BigInt(size) * quote.feeRateSatoshisPerKb + 999n) / 1000n;
  const fee = rateFee > 1_000n ? rateFee : 1_000n;
  if (fee > maxFee) {
    throw new Error("Estimated BCH miner fee (" + fee.toString() +
      " sats) exceeds this circle's maximum fee (" + maxFee.toString() + " sats).");
  }
  return { size, fee };
}

function findState(utxos: SpendableUtxo[], category: string, memberCount: number) {
  const matches = utxos.filter((utxo) =>
    utxo.token?.category === category &&
    utxo.token.nft?.capability === "minting",
  );
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? "Multiple PUSD circle state NFTs were found; stop and investigate."
      : "PUSD circle state NFT was not found on Mainnet.");
  }
  const state = matches[0];
  if (state.token!.amount !== 0n) throw new Error("PUSD circle state NFT unexpectedly carries fungible tokens.");
  decodeStateCommitment(state.token!.nft!.commitment, memberCount);
  return state;
}

function findReceipt(utxos: SpendableUtxo[], category: string, index: number) {
  const prefix = "52" + index.toString(16).padStart(2, "0");
  const matches = utxos.filter((utxo) =>
    utxo.token?.category === category &&
    utxo.token.nft?.capability === "none" &&
    utxo.token.nft.commitment.startsWith(prefix),
  );
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? "Duplicate PUSD receipt for member " + (index + 1) + "."
      : "Missing PUSD receipt for member " + (index + 1) + ".");
  }
  if (matches[0].token!.amount !== 0n) {
    throw new Error("PUSD member receipt unexpectedly carries fungible tokens.");
  }
  creditFromCommitment(matches[0].token!.nft!.commitment);
  return matches[0];
}

export function validatePusdMainnetCircleParams(params: PusdMainnetCircleParams) {
  if (!/^[0-9a-f]{64}$/i.test(params.stateCategory)) {
    throw new Error("PUSD circle state category must be a transaction ID.");
  }
  validateDraft(params);
  if (params.treasury !== "bitcoincash:zqtu3577x0swy2gsra6km3033xcj8swg8s4rld9w7q") {
    throw new Error("PUSD circle treasury differs from the shared Mainnet BCH/PUSD project treasury.");
  }
}

export async function planPusdMainnetCircleGenesis(
  draft: { name: string; members: string[]; contribution: bigint; maxFee: bigint },
  initiatorAddress: string,
): Promise<PusdMainnetTransactionPlan & { params: PusdMainnetCircleParams }> {
  const normalized: PusdMainnetCircleDraft = {
    ...draft,
    version: 3,
    network: "mainnet",
    initiator: initiatorAddress,
  };
  validateDraft(normalized);
  const provider = await getClassicProvider("mainnet");
  const walletUtxos = (await provider.getUtxos(initiatorAddress)).filter((utxo) => !utxo.token);
  const genesis = walletUtxos.find((utxo) => utxo.vout === 0);
  if (!genesis) {
    throw new Error("Mainnet PUSD circle creation requires a token-free wallet UTXO at output index 0 to establish the circle's CashToken category.");
  }

  const params: PusdMainnetCircleParams = {
    ...normalized,
    stateCategory: genesis.txid,
    treasury: "bitcoincash:zqtu3577x0swy2gsra6km3033xcj8swg8s4rld9w7q",
  };
  const { contract, escrows } = circleContracts(params, provider);
  const fixedOutputValue = STATE_DUST +
    BigInt(params.members.length) * (RECEIPT_DUST + ESCROW_DUST);

  const additional = selectBchInputs(
    walletUtxos,
    fixedOutputValue + params.maxFee + CHANGE_DUST,
    genesis.txid + ":" + genesis.vout,
  );
  const inputs = [genesis, ...additional.selected];
  const inputTotal = genesis.satoshis + additional.total;
  const estimateBuilder = new TransactionBuilder({ provider });
  inputs.forEach((utxo) => estimateBuilder.addInput(utxo, placeholderP2PKHUnlocker(initiatorAddress)));
  estimateBuilder.addOutput({
    to: contract.tokenAddress,
    amount: STATE_DUST,
    token: { category: params.stateCategory, amount: 0n, nft: { capability: "minting", commitment: stateCommitment(0, false) } },
  });
  for (let index = 0; index < params.members.length; index++) {
    estimateBuilder.addOutput({
      to: contract.tokenAddress,
      amount: RECEIPT_DUST,
      token: { category: params.stateCategory, amount: 0n, nft: { capability: "none", commitment: receiptCommitment(index, 0n) } },
    });
  }
  escrows.forEach((escrow) => estimateBuilder.addOutput({ to: escrow.address, amount: ESCROW_DUST }));
  estimateBuilder.addOutput({ to: initiatorAddress, amount: CHANGE_DUST });
  const { fee, size } = await estimateFee(estimateBuilder, params.maxFee);
  const change = inputTotal - fixedOutputValue - fee;
  if (change < CHANGE_DUST) throw new Error("Mainnet BCH inputs cannot fund the PUSD circle genesis, carrier outputs and quoted miner fee.");

  const builder = new TransactionBuilder({ provider });
  inputs.forEach((utxo) => builder.addInput(utxo, placeholderP2PKHUnlocker(initiatorAddress)));
  builder.addOutput({
    to: contract.tokenAddress,
    amount: STATE_DUST,
    token: { category: params.stateCategory, amount: 0n, nft: { capability: "minting", commitment: stateCommitment(0, false) } },
  });
  for (let index = 0; index < params.members.length; index++) {
    builder.addOutput({
      to: contract.tokenAddress,
      amount: RECEIPT_DUST,
      token: { category: params.stateCategory, amount: 0n, nft: { capability: "none", commitment: receiptCommitment(index, 0n) } },
    });
  }
  escrows.forEach((escrow) => builder.addOutput({ to: escrow.address, amount: ESCROW_DUST }));
  builder.addOutput({ to: initiatorAddress, amount: change });

  const wc = builder.generateWcTransactionObject({
    broadcast: false,
    userPrompt: "Create PUSD Mainnet circle " + params.name + " and mint member receipt NFTs",
  });
  return {
    params,
    wc,
    walletInputs: inputs.map((_, index) => index),
    feeEstimate: fee,
    transactionSizeBytes: size,
    contractAddress: contract.address,
    escrowAddresses: escrows.map((escrow) => escrow.address),
    projectTreasury: params.treasury,
    summary: "Mainnet genesis plan only. This plan is unsigned and is not broadcast.",
  };
}

export async function readPusdMainnetCircle(params: PusdMainnetCircleParams): Promise<PusdMainnetCircleSnapshot> {
  validatePusdMainnetCircleParams(params);
  const provider = await getClassicProvider("mainnet");
  const { contract, escrows } = circleContracts(params, provider);
  const utxos = await contract.getUtxos();
  const categoryUtxos = utxos.filter((utxo) => utxo.token?.category === params.stateCategory);
  if (categoryUtxos.length !== params.members.length + 1) {
    throw new Error("PUSD Mainnet circle state/receipt NFT set is incomplete or contains unexpected outputs.");
  }
  const state = findState(utxos, params.stateCategory, params.members.length);
  const statePosition = decodeStateCommitment(state.token!.nft!.commitment, params.members.length);
  const receipts = params.members.map((_, index) => findReceipt(utxos, params.stateCategory, index));
  const credits = receipts.map((receipt) => creditFromCommitment(receipt.token!.nft!.commitment));

  const escrowUtxos = await Promise.all(escrows.map(async (escrow, index) => {
    const sidecarUtxos = await escrow.getUtxos();
    if (sidecarUtxos.length !== 1) {
      throw new Error("PUSD escrow UTXO for member " + (index + 1) + " is missing or duplicated.");
    }
    const utxo = sidecarUtxos[0];
    const credit = credits[index];
    if (credit === 0n) {
      if (utxo.token && (utxo.token.category !== PUSD_ASSET.categoryId || utxo.token.amount !== 0n)) {
        throw new Error("Empty PUSD escrow for member " + (index + 1) + " unexpectedly contains token value.");
      }
    } else if (!utxo.token || utxo.token.category !== PUSD_ASSET.categoryId ||
        utxo.token.amount !== credit || utxo.token.nft) {
      throw new Error("PUSD escrow token amount does not match member " + (index + 1) + "'s on-chain receipt.");
    }
    if (utxo.satoshis <= 0n) throw new Error("PUSD escrow is missing its BCH carrier value.");
    return utxo;
  }));

  const totalCredits = credits.reduce((sum, credit) => sum + credit, 0n);
  if (totalCredits > CASH_TOKEN_MAX_AMOUNT) throw new Error("Total circle credit exceeds the CashTokens amount limit.");
  return {
    params,
    contract,
    escrows,
    state,
    receipts,
    escrowUtxos,
    credits,
    round: statePosition.round,
    completed: statePosition.completed,
    ready: !statePosition.completed && credits.every((credit) => credit >= params.contribution),
    recipient: statePosition.completed ? null : params.members[statePosition.round],
  };
}

export async function planPusdMainnetDeposit(
  params: PusdMainnetCircleParams,
  memberIndex: number,
  amount: bigint,
  walletAddress: string,
): Promise<PusdMainnetTransactionPlan> {
  validatePusdMainnetCircleParams(params);
  if (!Number.isSafeInteger(memberIndex) || memberIndex < 0 || memberIndex >= params.members.length) {
    throw new Error("Invalid PUSD member slot.");
  }
  if (toHex(classicAddressToPkh(walletAddress, "mainnet")) !==
      toHex(classicAddressToPkh(params.members[memberIndex], "mainnet"))) {
    throw new Error("Connected wallet does not match this PUSD member slot.");
  }
  if (amount <= 0n || amount > CASH_TOKEN_MAX_AMOUNT) throw new Error("Invalid PUSD deposit amount.");
  const snapshot = await readPusdMainnetCircle(params);
  if (snapshot.completed) throw new Error("This PUSD circle has completed all scheduled payouts.");
  const oldCredit = snapshot.credits[memberIndex];
  if (oldCredit > params.contribution || amount > params.contribution - oldCredit) {
    const remaining = oldCredit < params.contribution ? params.contribution - oldCredit : 0n;
    throw new Error(
      "This member can add at most " + remaining.toString() +
      " raw PUSD units this round. Excess PUSD must remain in the member wallet.",
    );
  }
  if (oldCredit > CASH_SCRIPT_INT_MAX - amount) throw new Error("PUSD member credit would exceed the covenant integer limit.");

  const balance = await fetchPusdWalletBalance(walletAddress);
  const tokenInput = balance.utxos
    .filter((utxo) => utxo.token?.category === PUSD_ASSET.categoryId && utxo.token.amount >= amount)
    .sort((a, b) => a.token!.amount === b.token!.amount
      ? (a.txid + ":" + a.vout).localeCompare(b.txid + ":" + b.vout)
      : a.token!.amount < b.token!.amount ? -1 : 1)[0];
  if (!tokenInput) {
    throw new Error("No authenticated PUSD UTXO has enough fungible PUSD for this member deposit. Excess PUSD from a larger UTXO is returned to the member wallet.");
  }
  const provider = await getClassicProvider("mainnet");
  const bchUtxos = (await provider.getUtxos(walletAddress)).filter((utxo) => !utxo.token);
  const tokenChange = tokenInput.token!.amount - amount;
  const memberLockingBytecode = hexToBin("76a914" + toHex(classicAddressToPkh(walletAddress, "mainnet")) + "88ac");
  const tokenChangeCarrier = tokenChange > 0n ? pusdCarrierSatoshis(memberLockingBytecode, tokenChange) : 0n;
  const reserve = selectSingleBchCoin(bchUtxos, params.maxFee + CHANGE_DUST + tokenChangeCarrier);
  if (!reserve) throw new Error("No BCH-only input is available to sponsor the PUSD deposit miner fee.");
  const funding = tokenInput as unknown as SpendableUtxo;
  const { contract, escrows } = snapshot;
  const state = snapshot.state;
  const receipt = snapshot.receipts[memberIndex];
  const escrow = snapshot.escrowUtxos[memberIndex];
  const unlock = contract.unlock.deposit(BigInt(memberIndex), amount);

  const makeBuilder = (change: bigint) => {
    const builder = new TransactionBuilder({ provider })
      .addInput(state, unlock)
      .addInput(receipt, unlock)
      .addInput(escrow, escrows[memberIndex].unlock.attest())
      .addInput(funding, placeholderP2PKHUnlocker(walletAddress))
      .addInput(reserve, placeholderP2PKHUnlocker(walletAddress))
      .addOutput({
        to: contract.tokenAddress, amount: state.satoshis,
        token: { category: params.stateCategory, amount: 0n, nft: { capability: "minting", commitment: state.token!.nft!.commitment } },
      })
      .addOutput({
        to: contract.tokenAddress, amount: receipt.satoshis,
        token: { category: params.stateCategory, amount: 0n, nft: { capability: "none", commitment: receiptCommitment(memberIndex, oldCredit + amount) } },
      })
      .addOutput({
        to: escrows[memberIndex].tokenAddress,
        amount: escrow.satoshis + funding.satoshis,
        token: { category: PUSD_ASSET.categoryId, amount: oldCredit + amount },
      });
    if (tokenChange > 0n) {
      builder.addOutput({
        to: walletAddress,
        amount: tokenChangeCarrier,
        token: { category: PUSD_ASSET.categoryId, amount: tokenChange },
      });
    }
    builder.addOutput({ to: walletAddress, amount: change });
    return builder;
  };

  const estimateBuilder = makeBuilder(CHANGE_DUST);
  const { fee, size } = await estimateFee(estimateBuilder, params.maxFee);
  const feeChange = reserve.satoshis - tokenChangeCarrier - fee;
  if (feeChange < CHANGE_DUST) throw new Error("BCH fee reserve cannot cover the token-change carrier, quoted miner fee and change.");
  const builder = makeBuilder(feeChange);
  const wc = builder.generateWcTransactionObject({
    broadcast: false,
    userPrompt: "Deposit " + amount.toString() + " raw PUSD units into member " + (memberIndex + 1) + "'s circle escrow",
  });
  return {
    wc,
    walletInputs: [3, 4],
    feeEstimate: fee,
    transactionSizeBytes: size,
    projectTreasury: params.treasury,
    summary: "Mainnet member deposit plan only. Exact PUSD UTXO and BCH fee input are wallet-owned; unsigned and not broadcast.",
  };
}

export async function planPusdMainnetPayout(
  params: PusdMainnetCircleParams,
  initiatorAddress: string,
): Promise<PusdMainnetTransactionPlan> {
  validatePusdMainnetCircleParams(params);
  if (toHex(classicAddressToPkh(initiatorAddress, "mainnet")) !==
      toHex(classicAddressToPkh(params.initiator, "mainnet"))) {
    throw new Error("Only the registered PUSD circle initiator can sponsor the payout miner fee.");
  }
  const snapshot = await readPusdMainnetCircle(params);
  if (snapshot.completed) throw new Error("This PUSD circle has already completed.");
  if (!snapshot.credits.every((credit) => credit >= params.contribution)) {
    throw new Error("Every member must have at least one full PUSD contribution in their own escrow before payout.");
  }

  const economics = calculatePusdCircleEconomics(params.members.length, params.contribution);
  const reserve = snapshot.round + 1 < params.members.length ? params.contribution : 0n;
  const payoutAmount = economics.grossPot - economics.projectFee - reserve;
  const provider = await getClassicProvider("mainnet");
  const bchUtxos = (await provider.getUtxos(initiatorAddress)).filter((utxo) => !utxo.token);
  const treasuryCarrier = pusdCarrierSatoshis(
    hexToBin("76a914" + toHex(getMainnetProjectTreasuryPkh()) + "88ac"),
    economics.projectFee,
  );
  const recipientCarrier = pusdCarrierSatoshis(
    hexToBin("76a914" + toHex(classicAddressToPkh(params.members[snapshot.round], "mainnet")) + "88ac"),
    payoutAmount,
  );
  const feeInput = selectSingleBchCoin(
    bchUtxos,
    treasuryCarrier + recipientCarrier + params.maxFee + CHANGE_DUST,
  );
  const count = params.members.length;
  const makeBuilder = (feeChange: bigint) => {
    const unlock = snapshot.contract.unlock.payout();
    const builder = new TransactionBuilder({ provider }).addInput(snapshot.state, unlock);
    builder.addInputs(snapshot.receipts, unlock);
    for (let index = 0; index < count; index++) {
      builder.addInput(snapshot.escrowUtxos[index], snapshot.escrows[index].unlock.attest());
    }
    builder.addInput(feeInput, placeholderP2PKHUnlocker(initiatorAddress));
    builder.addOutput({
      to: snapshot.contract.tokenAddress, amount: snapshot.state.satoshis,
      token: { category: params.stateCategory, amount: 0n, nft: { capability: "minting", commitment: stateCommitment(snapshot.round + 1, true) } },
    });
    for (let index = 0; index < count; index++) {
      const nextCredit = snapshot.credits[index] - params.contribution +
        (index === snapshot.round ? reserve : 0n);
      builder.addOutput({
        to: snapshot.contract.tokenAddress, amount: snapshot.receipts[index].satoshis,
        token: { category: params.stateCategory, amount: 0n, nft: { capability: "none", commitment: receiptCommitment(index, nextCredit) } },
      });
    }
    for (let index = 0; index < count; index++) {
      const nextCredit = snapshot.credits[index] - params.contribution +
        (index === snapshot.round ? reserve : 0n);
      if (nextCredit > 0n) {
        builder.addOutput({
          to: snapshot.escrows[index].tokenAddress,
          amount: snapshot.escrowUtxos[index].satoshis,
          token: { category: PUSD_ASSET.categoryId, amount: nextCredit },
        });
      } else {
        builder.addOutput({ to: snapshot.escrows[index].address, amount: snapshot.escrowUtxos[index].satoshis });
      }
    }
    builder.addOutput({
      to: params.treasury, amount: treasuryCarrier,
      token: { category: PUSD_ASSET.categoryId, amount: economics.projectFee },
    });
    builder.addOutput({
      to: params.members[snapshot.round], amount: recipientCarrier,
      token: { category: PUSD_ASSET.categoryId, amount: payoutAmount },
    });
    builder.addOutput({ to: initiatorAddress, amount: feeChange });
    return builder;
  };

  const estimateBuilder = makeBuilder(CHANGE_DUST);
  const { fee, size } = await estimateFee(estimateBuilder, params.maxFee);
  const feeChange = feeInput.satoshis - treasuryCarrier - recipientCarrier - fee;
  if (feeChange < CHANGE_DUST) throw new Error("BCH fee reserve cannot cover both PUSD token carrier outputs and the quoted payout fee.");
  const wc = makeBuilder(feeChange).generateWcTransactionObject({
    broadcast: false,
    userPrompt: "Pay PUSD Mainnet circle round " + (snapshot.round + 1) + " to member " + (snapshot.round + 1),
  });
  return {
    wc,
    walletInputs: [2 * count + 1],
    feeEstimate: fee,
    transactionSizeBytes: size,
    projectTreasury: params.treasury,
    summary: "Mainnet PUSD payout plan: 1% PUSD treasury fee, one next-contribution reserve for non-final recipient, and separately funded BCH miner fee. Unsigned and not broadcast.",
  };
}

export async function planPusdMainnetCancel(
  params: PusdMainnetCircleParams,
  initiatorAddress: string,
): Promise<PusdMainnetTransactionPlan> {
  validatePusdMainnetCircleParams(params);
  if (toHex(classicAddressToPkh(initiatorAddress, "mainnet")) !==
      toHex(classicAddressToPkh(params.initiator, "mainnet"))) {
    throw new Error("Only the registered PUSD circle initiator can cancel this circle.");
  }
  const snapshot = await readPusdMainnetCircle(params);
  if (snapshot.round !== 0 || snapshot.completed) {
    throw new Error("PUSD circle cancellation is only available before the first payout.");
  }
  const provider = await getClassicProvider("mainnet");
  const bchUtxos = (await provider.getUtxos(initiatorAddress)).filter((utxo) => !utxo.token);
  const feeInput = selectSingleBchCoin(bchUtxos, params.maxFee + CHANGE_DUST);

  const count = params.members.length;
  const makeBuilder = (feeChange: bigint) => {
    const unlock = snapshot.contract.unlock.cancel();
    const builder = new TransactionBuilder({ provider }).addInput(snapshot.state, unlock);
    builder.addInputs(snapshot.receipts, unlock);
    for (let index = 0; index < count; index++) {
      builder.addInput(snapshot.escrowUtxos[index], snapshot.escrows[index].unlock.cancel());
    }
    builder.addInput(feeInput, placeholderP2PKHUnlocker(initiatorAddress));
    for (let index = 0; index < count; index++) {
      const credit = snapshot.credits[index];
      const value = snapshot.escrowUtxos[index].satoshis + snapshot.receipts[index].satoshis;
      if (credit > 0n) {
        builder.addOutput({
          to: params.members[index], amount: value,
          token: { category: PUSD_ASSET.categoryId, amount: credit },
        });
      } else {
        builder.addOutput({ to: params.members[index], amount: value });
      }
    }
    builder.addOutput({ to: initiatorAddress, amount: feeChange });
    return builder;
  };

  const estimateBuilder = makeBuilder(CHANGE_DUST);
  const { fee, size } = await estimateFee(estimateBuilder, params.maxFee);
  const feeChange = feeInput.satoshis + snapshot.state.satoshis - fee;
  if (feeChange < CHANGE_DUST) throw new Error("Initiator BCH input and state reserve cannot cover the cancellation miner fee.");
  const wc = makeBuilder(feeChange).generateWcTransactionObject({
    broadcast: false,
    userPrompt: "Cancel PUSD Mainnet circle " + params.name + " and refund every member's exact PUSD escrow",
  });
  return {
    wc,
    walletInputs: [2 * count + 1],
    feeEstimate: fee,
    transactionSizeBytes: size,
    projectTreasury: params.treasury,
    summary: "Mainnet pre-payout cancellation plan: returns every member's PUSD escrow and BCH carrier backing. No project fee is charged. Unsigned and not broadcast.",
  };
}
