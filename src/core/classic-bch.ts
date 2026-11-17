import {
  Contract,
  ElectrumNetworkProvider,
  TransactionBuilder,
  placeholderP2PKHUnlocker,
  type NetworkProvider,
  type SpendableUtxo,
  type Artifact,
} from "cashscript";
import { decodeCashAddress, hexToBin } from "@bitauth/libauth";
import { ElectrumClient } from "@electrum-cash/network";
import { ElectrumWebSocket } from "@electrum-cash/web-socket";
import artifactJson from "../../contracts/AjoCircle.json" with { type: "json" };
import { MainnetQuorumNetworkProvider } from "./mainnet-quorum-provider";
import { MAX_CIRCLE_MEMBERS, MIN_CIRCLE_MEMBERS } from "./member-ledger";

export type ClassicNetwork = "mainnet" | "chipnet";
export const CLASSIC_MIN_MEMBERS = MIN_CIRCLE_MEMBERS;
export const CLASSIC_MAX_MEMBERS = MAX_CIRCLE_MEMBERS;
export const CLASSIC_STATE_DUST = 1_000n;
export const CLASSIC_CHANGE_DUST = 546n;
export const CLASSIC_DEFAULT_MAX_FEE = 10_000n;

export interface ClassicCircleParams {
  version: 1;
  name: string;
  network: ClassicNetwork;
  members: string[];
  contribution: bigint;
  maxFee: bigint;
  stateCategory: string;
}
export type ClassicCircleDraft = Omit<ClassicCircleParams, "stateCategory">;
export interface ClassicCircleStatus {
  stateVerified: boolean;
  round: number | null;
  completed: boolean;
  recipient: string | null;
  available: bigint;
  required: bigint;
  shortfall: bigint;
  ready: boolean;
  stateUtxo?: SpendableUtxo;
  contributionUtxos: SpendableUtxo[];
  issues: string[];
}

const artifact = artifactJson as unknown as Artifact;
const servers: Record<ClassicNetwork, Array<[string, number]>> = {
  chipnet: [
    // Fulcrum's published Chipnet WSS port (server.features advertises 64004).
    ["chipnet.c3-soft.com", 64004],
    ["blackie.c3-soft.com", 64004],
    // OPTN Labs publishes a dedicated Chipnet WSS endpoint on standard TLS port 443.
    ["electrum-chipnet.optnlabs.com", 443],
    // Retain community hosts as compatibility fallbacks.
    ["chipnet.imaginary.cash", 50004],
    ["chipnet.bch.ninja", 50004],
  ],
  mainnet: [
    ["bch.imaginary.cash", 50004],
    ["electroncash.dk", 50004],
  ],
};
const providers: Partial<Record<ClassicNetwork, Promise<NetworkProvider>>> = {};

function makeProvider(network: ClassicNetwork, host: string, port: number) {
  const client = new ElectrumClient(
    "AjoChain Blaze",
    "1.0.0",
    new ElectrumWebSocket(host, { port, encrypted: true, timeout: 8_000 } as never),
  );
  return new ElectrumNetworkProvider(network, { electrum: client } as never);
}

/**
 * Mainnet uses a strict multi-server read quorum and can never broadcast.
 * Chipnet keeps the first-responsive test provider with a local override.
 */
export function getClassicProvider(network: ClassicNetwork): Promise<NetworkProvider> {
  if (!providers[network]) {
    if (network === "mainnet") {
      const electrumProviders = servers.mainnet.map(([host, port]) =>
        makeProvider("mainnet", host, port),
      );
      const quorum = new MainnetQuorumNetworkProvider(electrumProviders);
      providers.mainnet = quorum.getBlockHeight().then(() => quorum).catch((error) => {
        delete providers.mainnet;
        throw new Error(
          "BCH Mainnet quorum could not be established (" +
          servers.mainnet.map(([host]) => host).join(", ") + "). " +
          (error instanceof Error ? error.message : String(error)),
        );
      });
    } else {
      const configured = typeof localStorage !== "undefined"
        ? localStorage.getItem("ajochain-electrum-chipnet")
        : null;
      const endpoints: Array<[string, number]> = configured
        ? [[configured.split(":")[0], Number(configured.split(":")[1] || 50004)]]
        : servers.chipnet;
      const attempts = endpoints.map(async ([host, port]) => {
        const provider = makeProvider("chipnet", host, port);
        await Promise.race([
          provider.getBlockHeight(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(host + " timed out")), 9_000),
          ),
        ]);
        return provider;
      });
      providers.chipnet = Promise.any(attempts).catch((error: unknown) => {
        delete providers.chipnet;
        const failures = error && typeof error === "object" &&
          "errors" in error && Array.isArray((error as { errors?: unknown }).errors)
          ? (error as { errors: unknown[] }).errors
          : [error];
        const details = failures.map((failure, index) => {
          const message = failure instanceof Error ? failure.message : String(failure);
          return endpoints[index]?.[0] + ": " + message;
        }).join("; ");
        throw new Error(
          "No Chipnet Electrum endpoint responded (" +
          endpoints.map(([host, port]) => host + ":" + port).join(", ") + "). " +
          (details || "All connection attempts failed; check the network or try again."),
        );
      });
    }
  }
  return providers[network]!;
}

function expectedPrefix(network: ClassicNetwork) {
  return network === "mainnet" ? "bitcoincash" : "bchtest";
}

export function classicAddressToPkh(address: string, network: ClassicNetwork): Uint8Array {
  const decoded = decodeCashAddress(address.trim());
  if (typeof decoded === "string") throw new Error("Invalid BCH CashAddress: " + decoded);
  if (decoded.prefix !== expectedPrefix(network)) {
    throw new Error("Member address is not on " + network + ".");
  }
  if (decoded.type !== "p2pkh" && decoded.type !== "p2pkhWithTokens") {
    throw new Error("Members must use standard P2PKH CashAddresses.");
  }
  return decoded.payload;
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateClassicCircle(input: ClassicCircleDraft | ClassicCircleParams): void {
  if (input.version !== 1 || !input.name.trim() || input.name.length > 60) {
    throw new Error("Enter a circle name between 1 and 60 characters.");
  }
  if (input.network !== "mainnet" && input.network !== "chipnet") {
    throw new Error("Choose a supported BCH network.");
  }
  if (!Array.isArray(input.members) ||
      input.members.length < CLASSIC_MIN_MEMBERS ||
      input.members.length > CLASSIC_MAX_MEMBERS) {
    throw new Error("A Classic BCH circle needs 2–5 members.");
  }
  const memberIds = input.members.map((address) =>
    toHex(classicAddressToPkh(address, input.network)),
  );
  if (new Set(memberIds).size !== memberIds.length) {
    throw new Error("Each member must have a unique BCH address.");
  }
  if (input.contribution < 1_000n) {
    throw new Error("Contribution must be at least 1,000 satoshis.");
  }
  if (input.maxFee < 0n ||
      input.maxFee > BigInt(input.members.length) * input.contribution - CLASSIC_STATE_DUST) {
    throw new Error("Maximum payout fee must leave at least 1,000 sats for the recipient.");
  }
  if ("stateCategory" in input && !/^[0-9a-f]{64}$/i.test(input.stateCategory)) {
    throw new Error("Invalid circle state category.");
  }
}

function constructorArgs(params: ClassicCircleParams) {
  const members = params.members.map((address) => classicAddressToPkh(address, params.network));
  while (members.length < CLASSIC_MAX_MEMBERS) members.push(new Uint8Array(20));
  return [
    members[0], members[1], members[2], members[3], members[4],
    BigInt(params.members.length),
    params.contribution,
    params.maxFee,
    hexToBin(params.stateCategory).reverse(),
  ] as const;
}

export function classicCircleContract(
  params: ClassicCircleParams,
  provider: NetworkProvider,
): Contract {
  validateClassicCircle(params);
  return new Contract(artifact, constructorArgs(params) as never, {
    provider,
    contractType: "p2sh32",
  });
}

function stateRound(utxo: SpendableUtxo): number {
  const commitment = utxo.token?.nft?.commitment ?? "";
  if (!/^[0-9a-f]{2}$/i.test(commitment)) {
    throw new Error("Circle state NFT has an invalid round commitment.");
  }
  return Number.parseInt(commitment, 16);
}

export function inspectClassicCircle(
  params: ClassicCircleParams,
  utxos: SpendableUtxo[],
): ClassicCircleStatus {
  validateClassicCircle(params);
  const issues: string[] = [];
  const stateMatches = utxos.filter((utxo) =>
    utxo.token?.category.toLowerCase() === params.stateCategory.toLowerCase() &&
    utxo.token.nft?.capability === "mutable" &&
    utxo.token.amount === 0n,
  );
  if (stateMatches.length !== 1) {
    issues.push(stateMatches.length === 0
      ? "Circle state NFT is missing or invalid."
      : "More than one circle state NFT was found. Stop and investigate.");
  }
  const stateUtxo = stateMatches.length === 1 ? stateMatches[0] : undefined;
  let round: number | null = null;
  if (stateUtxo) {
    try {
      round = stateRound(stateUtxo);
      if (round >= params.members.length) issues.push("All scheduled payouts are complete.");
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "Invalid circle round.");
    }
    if (stateUtxo.satoshis < CLASSIC_STATE_DUST) {
      issues.push("Circle state NFT is below the 1,000 satoshi reserve.");
    }
  }
  for (const utxo of utxos) {
    if (utxo.token && utxo.token.category.toLowerCase() !== params.stateCategory.toLowerCase()) {
      issues.push("Unexpected token UTXO exists at the circle address; it is excluded from payout.");
    }
  }
  const contributionUtxos = utxos.filter((utxo) => !utxo.token && utxo.satoshis > 0n);
  const available = contributionUtxos.reduce((sum, utxo) => sum + utxo.satoshis, 0n);
  const required = BigInt(params.members.length) * params.contribution;
  const completed = round !== null && round >= params.members.length;
  const stateVerified = Boolean(stateUtxo) && round !== null && round < params.members.length &&
    stateUtxo!.satoshis >= CLASSIC_STATE_DUST &&
    !issues.some((issue) => issue.startsWith("More than one") || issue.startsWith("Circle state NFT has"));
  const ready = stateVerified && !completed && available >= required;
  return {
    stateVerified,
    round,
    completed,
    recipient: round !== null && !completed ? params.members[round] : null,
    available,
    required,
    shortfall: ready ? 0n : required > available ? required - available : 0n,
    ready,
    stateUtxo,
    contributionUtxos,
    issues: [...new Set(issues)],
  };
}

function feeFor(builder: TransactionBuilder, feeRateSatsPerByte = 1): bigint {
  const encoded = builder.build();
  const byteLength = encoded.length / 2;
  return BigInt(Math.ceil(byteLength * feeRateSatsPerByte)) + 20n;
}

function createGenesisBuilder(
  provider: NetworkProvider,
  walletAddress: string,
  inputs: SpendableUtxo[],
  stateAddress: string,
  stateCategory: string,
  change: bigint,
) {
  const builder = new TransactionBuilder({ provider });
  inputs.forEach((utxo) => builder.addInput(utxo, placeholderP2PKHUnlocker(walletAddress)));
  builder.addOutput({
    to: stateAddress,
    amount: CLASSIC_STATE_DUST,
    token: {
      category: stateCategory,
      amount: 0n,
      nft: { capability: "mutable", commitment: "00" },
    },
  });
  builder.addOutput({ to: walletAddress, amount: change });
  return builder;
}

export async function planClassicGenesis(
  draft: ClassicCircleDraft,
  walletAddress: string,
) {
  validateClassicCircle(draft);
  const provider = await getClassicProvider(draft.network);
  const walletUtxos = (await provider.getUtxos(walletAddress))
    .filter((utxo) => !utxo.token && utxo.satoshis > 0n);
  const genesis = walletUtxos.find((utxo) => utxo.vout === 0 && utxo.satoshis >= 3_000n);
  if (!genesis) {
    const total = walletUtxos.reduce((sum, utxo) => sum + utxo.satoshis, 0n);
    throw new Error(
      "CashTokens genesis needs a non-token wallet UTXO at output index 0 with at least 3,000 sats. " +
      walletUtxos.length + " BCH coin(s) were found, totalling " + total.toString() +
      " sats. Check the connected receive address before sending more funds.",
    );
  }
  const params: ClassicCircleParams = { ...draft, stateCategory: genesis.txid };
  const contract = classicCircleContract(params, provider);
  const inputs: SpendableUtxo[] = [genesis];
  let total = genesis.satoshis;
  for (const utxo of walletUtxos) {
    if (utxo.txid === genesis.txid && utxo.vout === genesis.vout) continue;
    if (total >= CLASSIC_STATE_DUST + 5_000n + CLASSIC_CHANGE_DUST) break;
    inputs.push(utxo);
    total += utxo.satoshis;
  }
  const provisional = createGenesisBuilder(
    provider, walletAddress, inputs, contract.tokenAddress, params.stateCategory,
    CLASSIC_CHANGE_DUST,
  );
  const fee = feeFor(provisional);
  const change = total - CLASSIC_STATE_DUST - fee;
  if (change < CLASSIC_CHANGE_DUST) {
    throw new Error("Not enough BCH to create the circle, pay the miner fee, and keep dust-safe wallet change.");
  }
  const builder = createGenesisBuilder(
    provider, walletAddress, inputs, contract.tokenAddress, params.stateCategory, change,
  );
  const wc = builder.generateWcTransactionObject({
    broadcast: false,
    userPrompt: "Create AjoChain Classic circle: " + params.name,
  });
  return { params, contract, provider, builder, wc, walletInputs: inputs.map((_, index) => index), fee };
}

export async function planClassicContribution(
  params: ClassicCircleParams,
  walletAddress: string,
  amount = params.contribution,
) {
  validateClassicCircle(params);
  if (amount <= 0n) throw new Error("Contribution amount must be positive.");
  const provider = await getClassicProvider(params.network);
  const contract = classicCircleContract(params, provider);
  const walletUtxos = (await provider.getUtxos(walletAddress))
    .filter((utxo) => !utxo.token && utxo.satoshis > 0n)
    .sort((a, b) => a.satoshis > b.satoshis ? -1 : a.satoshis < b.satoshis ? 1 : 0);
  const inputs: SpendableUtxo[] = [];
  let total = 0n;
  for (const utxo of walletUtxos) {
    inputs.push(utxo);
    total += utxo.satoshis;
    if (total >= amount + 2_000n + CLASSIC_CHANGE_DUST) break;
  }
  if (!inputs.length || total < amount + 2_000n + CLASSIC_CHANGE_DUST) {
    throw new Error("Not enough BCH for this contribution, miner fee, and dust-safe change.");
  }
  const make = (change: bigint) => {
    const builder = new TransactionBuilder({ provider });
    inputs.forEach((utxo) => builder.addInput(utxo, placeholderP2PKHUnlocker(walletAddress)));
    builder.addOutput({ to: contract.address, amount });
    builder.addOutput({ to: walletAddress, amount: change });
    return builder;
  };
  const fee = feeFor(make(CLASSIC_CHANGE_DUST));
  const change = total - amount - fee;
  if (change < CLASSIC_CHANGE_DUST) throw new Error("Contribution leaves insufficient BCH change after miner fees.");
  const builder = make(change);
  const wc = builder.generateWcTransactionObject({
    broadcast: false,
    userPrompt: "Contribute to AjoChain circle: " + params.name,
  });
  return { provider, contract, builder, wc, walletInputs: inputs.map((_, index) => index), fee };
}

export async function readClassicCircle(params: ClassicCircleParams) {
  validateClassicCircle(params);
  const provider = await getClassicProvider(params.network);
  const contract = classicCircleContract(params, provider);
  const utxos = await contract.getUtxos();
  return { provider, contract, utxos, status: inspectClassicCircle(params, utxos) };
}

export async function planClassicPayout(params: ClassicCircleParams) {
  const snapshot = await readClassicCircle(params);
  const { status, contract, provider } = snapshot;
  if (!status.stateUtxo || !status.stateVerified) {
    throw new Error("Circle state is not verified. No payout transaction was built.");
  }
  if (status.completed) throw new Error("This circle has completed all scheduled payouts.");
  if (!status.ready) {
    throw new Error("The pot is not full. " + status.shortfall.toString() + " more sats are needed.");
  }
  const round = status.round!;
  const picked: SpendableUtxo[] = [];
  let pickedTotal = 0n;
  const sorted = [...status.contributionUtxos].sort((a, b) =>
    a.satoshis > b.satoshis ? -1 : a.satoshis < b.satoshis ? 1 : 0,
  );
  for (const utxo of sorted) {
    if (pickedTotal >= status.required) break;
    picked.push(utxo);
    pickedTotal += utxo.satoshis;
  }
  const surplus = pickedTotal - status.required;
  const make = (fee: bigint) => {
    const builder = new TransactionBuilder({ provider });
    builder.addInput(status.stateUtxo!, contract.unlock.payout());
    builder.addInputs(picked, contract.unlock.payout());
    builder.addOutput({
      to: contract.tokenAddress,
      amount: status.stateUtxo!.satoshis,
      token: {
        category: params.stateCategory,
        amount: 0n,
        nft: { capability: "mutable", commitment: (round + 1).toString(16).padStart(2, "0") },
      },
    });
    const recipientAmount = (surplus < CLASSIC_STATE_DUST ? pickedTotal : status.required) - fee;
    builder.addOutput({ to: params.members[round], amount: recipientAmount });
    if (surplus >= CLASSIC_STATE_DUST) {
      builder.addOutput({ to: contract.address, amount: surplus });
    }
    return builder;
  };
  const placeholderFee = status.required > 200_000n ? 200_000n : status.required - CLASSIC_STATE_DUST;
  const draft = make(placeholderFee);
  const fee = feeFor(draft);
  if (fee > params.maxFee) {
    throw new Error(
      "Estimated payout fee " + fee.toString() + " sats exceeds this circle's " +
      params.maxFee.toString() + " sat maximum. Reduce the number of tiny contribution UTXOs.",
    );
  }
  const builder = make(fee);
  return {
    ...snapshot,
    builder,
    fee,
    round,
    recipient: params.members[round],
    payoutAmount: (surplus < CLASSIC_STATE_DUST ? pickedTotal : status.required) - fee,
  };
}

export function encodeClassicCircle(params: ClassicCircleParams): string {
  validateClassicCircle(params);
  const json = JSON.stringify({
    version: params.version,
    name: params.name,
    network: params.network,
    members: params.members,
    contribution: params.contribution.toString(),
    maxFee: params.maxFee.toString(),
    stateCategory: params.stateCategory,
  });
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeClassicCircle(encoded: string): ClassicCircleParams {
  if (!encoded || encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("Invalid Classic AjoChain invite link.");
  }
  let parsed: unknown;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    parsed = JSON.parse(decodeURIComponent(escape(atob(base64))));
  } catch {
    throw new Error("Could not read this circle invite link.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid circle invite data.");
  }
  const data = parsed as Record<string, unknown>;
  if (data.version !== 1 || typeof data.name !== "string" ||
      (data.network !== "mainnet" && data.network !== "chipnet") ||
      !Array.isArray(data.members) || !data.members.every((member) => typeof member === "string") ||
      typeof data.contribution !== "string" || !/^\d+$/.test(data.contribution) ||
      typeof data.maxFee !== "string" || !/^\d+$/.test(data.maxFee) ||
      typeof data.stateCategory !== "string") {
    throw new Error("Circle invite data is incomplete or unsupported.");
  }
  const params: ClassicCircleParams = {
    version: 1,
    name: data.name,
    network: data.network,
    members: data.members as string[],
    contribution: BigInt(data.contribution),
    maxFee: BigInt(data.maxFee),
    stateCategory: data.stateCategory,
  };
  validateClassicCircle(params);
  return params;
}

export function classicInviteUrl(params: ClassicCircleParams): string {
  return location.origin + location.pathname + "#/classic/" + encodeClassicCircle(params);
}
