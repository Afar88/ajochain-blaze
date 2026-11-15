import {
  Contract,
  TransactionBuilder,
  placeholderP2PKHUnlocker,
  type NetworkProvider,
  type SpendableUtxo,
  type Artifact,
} from "cashscript";
import { hexToBin } from "@bitauth/libauth";
import artifactJson from "../../contracts/AjoCircleV2.json" with { type: "json" };
import { classicAddressToPkh, getClassicProvider } from "./classic-bch";

const artifact = artifactJson as unknown as Artifact;
const STATE_DUST = 1_000n;
const RECEIPT_DUST = 1_000n;
const CHANGE_DUST = 546n;
const RECEIPT_PREFIX = "52";
const CASH_SCRIPT_INT_MAX = 0x7fffffffffffffffn;

export interface V2CircleParams {
  version: 2;
  name: string;
  network: "chipnet";
  members: string[];
  contribution: bigint;
  maxFee: bigint;
  stateCategory: string;
}
export type V2CircleDraft = Omit<V2CircleParams, "stateCategory">;

const hex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

export function validateV2Circle(params: V2CircleDraft | V2CircleParams): void {
  if (params.version !== 2 || !params.name.trim() || params.name.length > 60) {
    throw new Error("Invalid V2 circle details.");
  }
  if (params.network !== "chipnet") {
    throw new Error("The V2 member-receipt prototype is Chipnet-only.");
  }
  if (params.members.length < 2 || params.members.length > 5) {
    throw new Error("A V2 circle needs 2–5 members.");
  }
  const keys = params.members.map((address) => hex(classicAddressToPkh(address, "chipnet")));
  if (new Set(keys).size !== keys.length) {
    throw new Error("Each V2 member must have a unique Chipnet BCH address.");
  }
  if (params.contribution < 1_000n || params.contribution > CASH_SCRIPT_INT_MAX) {
    throw new Error("Contribution must be between 1,000 sats and the CashScript integer limit.");
  }
  if (params.maxFee < 0n || params.maxFee > CASH_SCRIPT_INT_MAX ||
      params.maxFee > BigInt(params.members.length) * params.contribution - STATE_DUST) {
    throw new Error("Maximum fee must leave at least 1,000 sats for the recipient.");
  }
  if ("stateCategory" in params && !/^[0-9a-f]{64}$/i.test(params.stateCategory)) {
    throw new Error("Invalid V2 state token category.");
  }
}

export function v2ReceiptCommitment(index: number, credit: bigint): string {
  if (!Number.isInteger(index) || index < 0 || index > 4 ||
      credit < 0n || credit > CASH_SCRIPT_INT_MAX) {
    throw new Error("Invalid V2 member receipt data.");
  }
  return RECEIPT_PREFIX + index.toString(16).padStart(2, "0") +
    credit.toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
}

export function v2CreditFromCommitment(commitment: string): bigint {
  if (!/^52[0-4][0-9a-f][0-9a-f]{16}$/i.test(commitment)) {
    throw new Error("Invalid V2 member receipt commitment.");
  }
  const credit = BigInt("0x" + commitment.slice(4).match(/../g)!.reverse().join(""));
  if (credit > CASH_SCRIPT_INT_MAX) throw new Error("Member credit exceeds the CashScript integer limit.");
  return credit;
}

function contractFor(params: V2CircleParams, provider: NetworkProvider): Contract {
  validateV2Circle(params);
  const members = params.members.map((address) => classicAddressToPkh(address, "chipnet"));
  while (members.length < 5) members.push(new Uint8Array(20));
  return new Contract(artifact, [
    members[0], members[1], members[2], members[3], members[4],
    BigInt(params.members.length),
    params.contribution,
    params.maxFee,
    hexToBin(params.stateCategory).reverse(),
  ] as never, { provider, contractType: "p2sh32" });
}

function findState(utxos: SpendableUtxo[], category: string) {
  const matches = utxos.filter((utxo) =>
    utxo.token?.category.toLowerCase() === category.toLowerCase() &&
    utxo.token.nft?.capability === "minting" &&
    /^53[0-4]$/i.test(utxo.token.nft.commitment),
  );
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? "Multiple V2 state NFTs found; stop and investigate."
      : "V2 state NFT missing or has an invalid commitment.");
  }
  if (matches[0].token!.amount !== 0n) {
    throw new Error("V2 state NFT unexpectedly carries fungible tokens.");
  }
  return matches[0];
}

function findReceipt(utxos: SpendableUtxo[], category: string, index: number) {
  const prefix = RECEIPT_PREFIX + index.toString(16).padStart(2, "0");
  const matches = utxos.filter((utxo) =>
    utxo.token?.category.toLowerCase() === category.toLowerCase() &&
    utxo.token.nft?.capability === "none" &&
    utxo.token.nft.commitment.startsWith(prefix),
  );
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? "Duplicate receipt for member " + (index + 1) + "; stop and investigate."
      : "Missing receipt for member " + (index + 1) + "; refresh the circle.");
  }
  if (matches[0].token!.amount !== 0n) {
    throw new Error("Member " + (index + 1) + " receipt unexpectedly carries fungible tokens.");
  }
  v2CreditFromCommitment(matches[0].token!.nft!.commitment);
  return matches[0];
}

/** Rejects unknown token UTXOs at the V2 covenant address before any spend is planned. */
function assertV2UtxoSet(utxos: SpendableUtxo[], category: string, memberCount: number) {
  const tokenUtxos = utxos.filter((utxo) =>
    utxo.token?.category.toLowerCase() === category.toLowerCase(),
  );
  if (tokenUtxos.length !== memberCount + 1) {
    throw new Error(
      "Invalid V2 token set: expected exactly " + (memberCount + 1) +
      " state/receipt NFTs but found " + tokenUtxos.length + ". Stop and investigate.",
    );
  }
  const state = findState(utxos, category);
  const receipts = Array.from({ length: memberCount }, (_, index) =>
    findReceipt(utxos, category, index),
  );
  const outpoints = new Set([state, ...receipts].map((utxo) => utxo.txid + ":" + utxo.vout));
  if (tokenUtxos.some((utxo) => !outpoints.has(utxo.txid + ":" + utxo.vout))) {
    throw new Error("Unexpected token output at the V2 circle address. Stop and investigate.");
  }
}

function estimateFee(inputs: number, outputs: number) {
  return BigInt(10 + inputs * 150 + outputs * 100 + 100);
}

function pickFunding(utxos: SpendableUtxo[], required: bigint) {
  const coin = [...utxos]
    .filter((utxo) => !utxo.token)
    .sort((a, b) => a.satoshis > b.satoshis ? -1 : a.satoshis < b.satoshis ? 1 : 0)
    .find((utxo) => utxo.satoshis >= required);
  if (!coin) {
    throw new Error("No single BCH wallet coin can cover the amount, fee and dust-safe change. Consolidate test BCH first.");
  }
  return coin;
}

export async function planV2Genesis(draft: V2CircleDraft, walletAddress: string) {
  validateV2Circle(draft);
  const provider = await getClassicProvider("chipnet");
  const coins = (await provider.getUtxos(walletAddress)).filter((utxo) => !utxo.token);
  const genesis = coins.find((utxo) => utxo.vout === 0 && utxo.satoshis >= 3_000n);
  if (!genesis) {
    throw new Error("V2 creation requires a non-token BCH wallet UTXO at output index 0 with at least 3,000 sats.");
  }
  const params: V2CircleParams = { ...draft, stateCategory: genesis.txid };
  const contract = contractFor(params, provider);
  const outputs = params.members.length + 2;
  const inputs: SpendableUtxo[] = [genesis];
  let total = genesis.satoshis;
  for (const coin of coins) {
    if (coin.txid === genesis.txid && coin.vout === genesis.vout) continue;
    if (total >= STATE_DUST + BigInt(params.members.length) * RECEIPT_DUST +
        estimateFee(inputs.length, outputs) + CHANGE_DUST) break;
    inputs.push(coin);
    total += coin.satoshis;
  }
  const fee = estimateFee(inputs.length, outputs);
  const change = total - STATE_DUST - BigInt(params.members.length) * RECEIPT_DUST - fee;
  if (change < CHANGE_DUST) throw new Error("Not enough test BCH for the V2 state NFT, member receipts, fee and change.");
  const builder = new TransactionBuilder({ provider });
  inputs.forEach((utxo) => builder.addInput(utxo, placeholderP2PKHUnlocker(walletAddress)));
  builder.addOutput({
    to: contract.tokenAddress,
    amount: STATE_DUST,
    token: {
      category: params.stateCategory,
      amount: 0n,
      nft: { capability: "minting", commitment: "5300" },
    },
  });
  for (let index = 0; index < params.members.length; index++) {
    builder.addOutput({
      to: contract.tokenAddress,
      amount: RECEIPT_DUST,
      token: {
        category: params.stateCategory,
        amount: 0n,
        nft: { capability: "none", commitment: v2ReceiptCommitment(index, 0n) },
      },
    });
  }
  builder.addOutput({ to: walletAddress, amount: change });
  const wc = builder.generateWcTransactionObject({
    broadcast: false,
    userPrompt: "Create V2 AjoChain circle \"" + params.name + "\" and member receipts",
  });
  return { params, contract, provider, wc, walletInputs: inputs.map((_, index) => index), fee };
}

export async function planV2Deposit(
  params: V2CircleParams,
  memberIndex: number,
  amount: bigint,
  walletAddress: string,
) {
  validateV2Circle(params);
  if (!Number.isInteger(memberIndex) || memberIndex < 0 || memberIndex >= params.members.length) {
    throw new Error("Invalid V2 member index.");
  }
  if (amount <= 0n || amount > CASH_SCRIPT_INT_MAX) {
    throw new Error("Deposit amount is outside the supported CashScript integer range.");
  }
  if (hex(classicAddressToPkh(params.members[memberIndex], "chipnet")) !==
      hex(classicAddressToPkh(walletAddress, "chipnet"))) {
    throw new Error("Connected wallet does not match this V2 member slot.");
  }
  const provider = await getClassicProvider("chipnet");
  const contract = contractFor(params, provider);
  const all = await contract.getUtxos();
  assertV2UtxoSet(all, params.stateCategory, params.members.length);
  const state = findState(all, params.stateCategory);
  const receipt = findReceipt(all, params.stateCategory, memberIndex);
  const fee = estimateFee(3, 3);
  if (fee > params.maxFee) throw new Error("Estimated V2 deposit fee exceeds this circle's maxFee.");
  const funding = pickFunding(
    (await provider.getUtxos(walletAddress)).filter((utxo) => !utxo.token),
    amount + fee + CHANGE_DUST,
  );
  const change = funding.satoshis - amount - fee;
  const oldCredit = v2CreditFromCommitment(receipt.token!.nft!.commitment);
  if (oldCredit + amount > CASH_SCRIPT_INT_MAX) {
    throw new Error("This deposit would exceed the supported member-credit limit.");
  }
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.addCredit(BigInt(memberIndex), amount))
    .addInput(receipt, contract.unlock.addCredit(BigInt(memberIndex), amount))
    .addInput(funding, placeholderP2PKHUnlocker(walletAddress))
    .addOutput({
      to: contract.tokenAddress,
      amount: state.satoshis + amount,
      token: {
        category: params.stateCategory,
        amount: 0n,
        nft: { capability: "minting", commitment: state.token!.nft!.commitment },
      },
    })
    .addOutput({
      to: contract.tokenAddress,
      amount: receipt.satoshis,
      token: {
        category: params.stateCategory,
        amount: 0n,
        nft: { capability: "none", commitment: v2ReceiptCommitment(memberIndex, oldCredit + amount) },
      },
    })
    .addOutput({ to: walletAddress, amount: change });
  const wc = builder.generateWcTransactionObject({
    broadcast: false,
    userPrompt: "Add " + amount.toString() + " sats to your AjoChain V2 member credit",
  });
  return {
    provider,
    contract,
    wc,
    walletInputs: [2],
    memberIndex,
    credited: amount,
    newCredit: oldCredit + amount,
    fee,
  };
}

export async function planV2Payout(params: V2CircleParams) {
  validateV2Circle(params);
  const provider = await getClassicProvider("chipnet");
  const contract = contractFor(params, provider);
  const utxos = await contract.getUtxos();
  assertV2UtxoSet(utxos, params.stateCategory, params.members.length);
  const state = findState(utxos, params.stateCategory);
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2), 16);
  if (!Number.isInteger(round) || round < 0 || round >= params.members.length) {
    throw new Error("Invalid V2 payout round.");
  }
  const receipts = params.members.map((_, index) =>
    findReceipt(utxos, params.stateCategory, index),
  );
  const credits = receipts.map((receipt) =>
    v2CreditFromCommitment(receipt.token!.nft!.commitment),
  );
  for (let index = 0; index < credits.length; index++) {
    if (credits[index] < params.contribution) {
      throw new Error("Member " + (index + 1) + " has insufficient credit. Payout is blocked.");
    }
  }
  const pot = BigInt(params.members.length) * params.contribution;
  if (state.satoshis - pot < STATE_DUST) {
    throw new Error("V2 payout would reduce the state reserve below 1,000 sats.");
  }
  const builder = new TransactionBuilder({ provider })
    .addInput(state, contract.unlock.payout())
    .addInputs(receipts, contract.unlock.payout())
    .addOutput({
      to: contract.tokenAddress,
      amount: state.satoshis - pot,
      token: {
        category: params.stateCategory,
        amount: 0n,
        nft: {
          capability: "minting",
          commitment: "53" + ((round + 1) % params.members.length).toString(16).padStart(2, "0"),
        },
      },
    });
  receipts.forEach((receipt, index) => {
    const credit = credits[index];
    builder.addOutput({
      to: contract.tokenAddress,
      amount: receipt.satoshis,
      token: {
        category: params.stateCategory,
        amount: 0n,
        nft: {
          capability: "none",
          commitment: v2ReceiptCommitment(index, credit - params.contribution),
        },
      },
    });
  });
  const payout = pot - params.maxFee;
  builder.addOutput({ to: params.members[round], amount: payout });
  return { provider, contract, builder, round, recipient: params.members[round], payout, fee: params.maxFee, credits };
}

export async function readV2Circle(params: V2CircleParams) {
  validateV2Circle(params);
  const provider = await getClassicProvider("chipnet");
  const contract = contractFor(params, provider);
  const utxos = await contract.getUtxos();
  assertV2UtxoSet(utxos, params.stateCategory, params.members.length);
  const state = findState(utxos, params.stateCategory);
  const round = Number.parseInt(state.token!.nft!.commitment.slice(2), 16);
  if (!Number.isInteger(round) || round < 0 || round >= params.members.length) {
    throw new Error("Invalid V2 payout round.");
  }
  const receipts = params.members.map((_, index) =>
    findReceipt(utxos, params.stateCategory, index),
  );
  const credits = receipts.map((receipt) =>
    v2CreditFromCommitment(receipt.token!.nft!.commitment),
  );
  return {
    provider,
    contract,
    utxos,
    round,
    stateSatoshis: state.satoshis,
    credits,
    ready: credits.every((credit) => credit >= params.contribution),
    recipient: params.members[round],
  };
}


export function encodeV2Circle(params: V2CircleParams): string {
  validateV2Circle(params);
  const data = JSON.stringify({
    version: params.version,
    name: params.name,
    network: params.network,
    members: params.members,
    contribution: params.contribution.toString(),
    maxFee: params.maxFee.toString(),
    stateCategory: params.stateCategory,
  });
  return btoa(unescape(encodeURIComponent(data)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeV2Circle(encoded: string): V2CircleParams {
  if (!encoded || encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("Invalid V2 circle invite link.");
  }
  let value: unknown;
  try {
    value = JSON.parse(decodeURIComponent(escape(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")))));
  } catch {
    throw new Error("Could not read this V2 circle invite link.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid V2 circle invite data.");
  }
  const data = value as Record<string, unknown>;
  if (data.version !== 2 || data.network !== "chipnet" ||
      typeof data.name !== "string" || !Array.isArray(data.members) ||
      !data.members.every((member) => typeof member === "string") ||
      typeof data.contribution !== "string" || !/^\d+$/.test(data.contribution) ||
      typeof data.maxFee !== "string" || !/^\d+$/.test(data.maxFee) ||
      typeof data.stateCategory !== "string") {
    throw new Error("V2 circle invite data is incomplete or unsupported.");
  }
  const params: V2CircleParams = {
    version: 2,
    name: data.name,
    network: "chipnet",
    members: data.members as string[],
    contribution: BigInt(data.contribution),
    maxFee: BigInt(data.maxFee),
    stateCategory: data.stateCategory,
  };
  validateV2Circle(params);
  return params;
}
