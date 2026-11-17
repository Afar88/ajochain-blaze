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
import { calculateGenesisSetupChange, CASH_TOKEN_GENESIS_SETUP_MIN_CHANGE_SATOSHIS, CASH_TOKEN_GENESIS_SETUP_OUTPUT_SATOSHIS, selectCashTokensGenesisUtxo } from "./cash-token-genesis";
import {
  CHIPNET_ELECTRUM_ENDPOINTS,
  ELECTRUM_PROTOCOL_VERSION,
  ELECTRUM_SOCKET_OPTIONS,
  ELECTRUM_TIMEOUT_MS,
  getChipnetElectrumEndpoints,
} from "./chipnet-electrum-config";

export type ClassicNetwork = "mainnet" | "chipnet";
export const CLASSIC_MIN_MEMBERS = MIN_CIRCLE_MEMBERS;
export const CLASSIC_MAX_MEMBERS = MAX_CIRCLE_MEMBERS;
export const CLASSIC_STATE_DUST = 1_000n;
export const CLASSIC_CHANGE_DUST = 546n;
export const CLASSIC_DEFAULT_MAX_FEE = 10_000n;

export class CashTokensGenesisUtxoMissingError extends Error {
  constructor() {
    super(
      "CashTokens category creation requires a spendable non-token wallet output at index 0. " +
      "A setup transaction can create the required output using existing BCH.",
    );
    this.name = "CashTokensGenesisUtxoMissingError";
  }
}

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
  chipnet: CHIPNET_ELECTRUM_ENDPOINTS.map(([host, port]) => [host, port]),
  mainnet: [
    ["bch.imaginary.cash", 50004],
    ["electroncash.dk", 50004],
  ],
};
const providers: Partial<Record<ClassicNetwork, Promise<NetworkProvider>>> = {};

function makeProvider(network: ClassicNetwork, host: string, port: number) {
  // CashScript 0.14 requires Electrum protocol 1.5.0 (including headers.get_tip
  // and token-aware listunspent). In browsers, keep the socket alive while the
  // wallet opens in another tab and the AjoChain page is temporarily hidden.
  const socket = new ElectrumWebSocket(host, {
    // Keep the visibility override scoped to Chipnet browser testing. Mainnet
    // retains the socket library's default visibility/reconnect behavior.
    ...(network === "chipnet" ? ELECTRUM_SOCKET_OPTIONS : { encrypted: true }),
    port,
  } as never);
  const client = new ElectrumClient(
    "AjoChain Blaze",
    ELECTRUM_PROTOCOL_VERSION,
    socket,
  );
  const provider = new ElectrumNetworkProvider(network, { electrum: client } as never);
  return { provider, client };
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Mainnet uses a strict multi-server read quorum and can never broadcast.
 * Chipnet keeps the first-responsive test provider with a local override.
 */
export function getClassicProvider(network: ClassicNetwork): Promise<NetworkProvider> {
  if (!providers[network]) {
    if (network === "mainnet") {
      const connections = servers.mainnet.map(([host, port]) =>
        makeProvider("mainnet", host, port),
      );
      const electrumProviders = connections.map(({ provider }) => provider);
      const quorum = new MainnetQuorumNetworkProvider(electrumProviders);
      providers.mainnet = quorum.getBlockHeight().then(() => quorum).catch(async (error) => {
        delete providers.mainnet;
        await Promise.allSettled(connections.map(({ client }) => client.disconnect()));
        throw new Error(
          "BCH Mainnet quorum could not be established (" +
          servers.mainnet.map(([host]) => host).join(", ") + "). " +
          errorMessage(error),
        );
      });
    } else {
      const configured = typeof localStorage !== "undefined"
        ? localStorage.getItem("ajochain-electrum-chipnet")
        : null;
      const endpoints = getChipnetElectrumEndpoints(configured);
      const attempts = endpoints.map(([host, port]) => {
        const { provider, client } = makeProvider("chipnet", host, port);
        const attempt = withTimeout(
          provider.getBlockHeight(),
          ELECTRUM_TIMEOUT_MS,
          host + ":" + port + " did not complete an Electrum 1.5.0 handshake within " + ELECTRUM_TIMEOUT_MS + " ms",
        ).then(() => ({ provider, client })).catch(async (error: unknown) => {
          // A timed-out WebSocket must not continue reconnecting in the background.
          await client.disconnect().catch(() => false);
          throw new Error(host + ":" + port + ": " + errorMessage(error));
        });
        return { client, attempt };
      });
      providers.chipnet = Promise.any(attempts.map(({ attempt }) => attempt))
        .then(async (winner) => {
          // The first endpoint to complete a real CashScript read wins. Close
          // any slower connections so they cannot linger or compete for mobile data.
          await Promise.allSettled(
            attempts
              .filter(({ client }) => client !== winner.client)
              .map(({ client }) => client.disconnect()),
          );
          return winner.provider;
        })
        .catch(async (error: unknown) => {
          delete providers.chipnet;
          await Promise.allSettled(attempts.map(({ client }) => client.disconnect()));
          const failures = error && typeof error === "object" &&
            "errors" in error && Array.isArray((error as { errors?: unknown }).errors)
            ? (error as { errors: unknown[] }).errors
            : [error];
          const details = failures.map(errorMessage).join("; ");
          throw new Error(
            "No Chipnet Electrum WebSocket endpoint completed the required 1.5.0 handshake (" +
            endpoints.map(([host, port]) => host + ":" + port).join(", ") + "). " +
            (details || "All connection attempts failed; retry after the network is available."),
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
  // getTransactionSize() includes the eventual P2PKH placeholder signature sizes
  // but skips balance/fee validation, so provisional builders can be measured
  // while the planner is still selecting enough wallet inputs.
  const byteLength = Number(builder.getTransactionSize());
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

/**
 * Build a separate, wallet-approved transaction that creates a clean BCH
 * output at vout 0. CashTokens category creation can then spend that outpoint.
 * Output 1 returns the remaining value as wallet change.
 */
function createGenesisSetupBuilder(
  provider: NetworkProvider,
  walletAddress: string,
  inputs: SpendableUtxo[],
  change: bigint,
) {
  const builder = new TransactionBuilder({ provider });
  inputs.forEach((utxo) => builder.addInput(utxo, placeholderP2PKHUnlocker(walletAddress)));
  // Keep this as the first output: the next transaction uses txid:vout 0.
  builder.addOutput({ to: walletAddress, amount: CASH_TOKEN_GENESIS_SETUP_OUTPUT_SATOSHIS });
  builder.addOutput({ to: walletAddress, amount: change });
  return builder;
}

/**
 * Prepare (but never broadcast) the Chipnet setup transaction. Signing and
 * broadcasting remain in the UI after an explicit Selene approval.
 */
export async function planClassicGenesisSetup(walletAddress: string) {
  const provider = await getClassicProvider("chipnet");
  const walletUtxos = (await provider.getUtxos(walletAddress))
    .filter((utxo) => !utxo.token && utxo.satoshis > 0n)
    .sort((a, b) =>
      a.satoshis === b.satoshis
        ? a.txid.localeCompare(b.txid) || a.vout - b.vout
        : a.satoshis > b.satoshis ? -1 : 1
    );

  if (walletUtxos.length === 0) {
    throw new Error("No spendable non-token BCH UTXOs were found in this Chipnet wallet. No setup transaction was created.");
  }

  const inputs: SpendableUtxo[] = [];
  let total = 0n;
  for (const utxo of walletUtxos) {
    inputs.push(utxo);
    total += utxo.satoshis;

    const provisional = createGenesisSetupBuilder(
      provider, walletAddress, inputs, CLASSIC_CHANGE_DUST,
    );
    const fee = feeFor(provisional);
    const change = calculateGenesisSetupChange(total, fee);
    if (change === undefined) continue;

    const builder = createGenesisSetupBuilder(provider, walletAddress, inputs, change);
    const wc = builder.generateWcTransactionObject({
      broadcast: false,
      userPrompt: "Prepare AjoChain CashTokens genesis output on Chipnet",
    });
    return {
      provider,
      builder,
      wc,
      walletInputs: inputs.map((_, index) => index),
      fee,
      outputSatoshis: CASH_TOKEN_GENESIS_SETUP_OUTPUT_SATOSHIS,
      totalInputSatoshis: total,
      changeSatoshis: change,
    };
  }

  throw new Error(
    "The wallet's available non-token BCH is not enough to create a " +
    CASH_TOKEN_GENESIS_SETUP_OUTPUT_SATOSHIS.toString() +
    "-satoshi vout-0 output, pay the miner fee, and retain at least " +
    CASH_TOKEN_GENESIS_SETUP_MIN_CHANGE_SATOSHIS.toString() +
    " sats of dust-safe change. No extra reserve is required. No transaction was prepared; do not add funds until the wallet UTXOs are reviewed.",
  );
}

export async function planClassicGenesis(
  draft: ClassicCircleDraft,
  walletAddress: string,
) {
  validateClassicCircle(draft);
  const provider = await getClassicProvider(draft.network);
  const walletUtxos = (await provider.getUtxos(walletAddress))
    .filter((utxo) => !utxo.token && utxo.satoshis > 0n)
    .sort((a, b) => a.satoshis === b.satoshis
      ? a.txid.localeCompare(b.txid) || a.vout - b.vout
      : a.satoshis > b.satoshis ? -1 : 1);
  const genesis = selectCashTokensGenesisUtxo(walletUtxos);
  if (!genesis) {
    throw new CashTokensGenesisUtxoMissingError();
  }
  const params: ClassicCircleParams = { ...draft, stateCategory: genesis.txid };
  const contract = classicCircleContract(params, provider);
  const inputs: SpendableUtxo[] = [genesis];
  const remainingUtxos = walletUtxos.filter((utxo) =>
    utxo.txid !== genesis.txid || utxo.vout !== genesis.vout,
  );
  let total = genesis.satoshis;
  let fee = 0n;
  let change = 0n;

  // Add wallet inputs only until the real estimated fee and dust-safe change
  // are covered. Do not impose an arbitrary 5,000-satoshi reserve.
  while (true) {
    const provisional = createGenesisBuilder(
      provider, walletAddress, inputs, contract.tokenAddress, params.stateCategory,
      CLASSIC_CHANGE_DUST,
    );
    fee = feeFor(provisional);
    change = total - CLASSIC_STATE_DUST - fee;
    if (change >= CLASSIC_CHANGE_DUST) break;

    const nextUtxo = remainingUtxos.shift();
    if (!nextUtxo) {
      throw new Error(
        "Not enough BCH to create the circle, pay its estimated miner fee, and keep " +
        CLASSIC_CHANGE_DUST.toString() + " sats of dust-safe change. " +
        "No extra reserve is required.",
      );
    }
    inputs.push(nextUtxo);
    total += nextUtxo.satoshis;
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
