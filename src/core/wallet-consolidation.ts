import { hexToBin, binToHex, sha256 } from "@bitauth/libauth";
import { TransactionBuilder, placeholderP2PKHUnlocker, type NetworkProvider, type SpendableUtxo } from "cashscript";
import type { WalletAddressEntry, WalletInputPath } from "./wizard-wallet";

const DUST = 546n;
const MAX_CONSOLIDATION_INPUTS = 80;

export interface WalletConsolidationPlan {
  wc: ReturnType<TransactionBuilder["generateWcTransactionObject"]>;
  walletInputs: number[];
  inputPaths: Map<number, WalletInputPath>;
  inputCount: number;
  totalSatoshis: bigint;
  fee: bigint;
  outputSatoshis: bigint;
  destination: string;
}

/** Chipnet shares the testnet4 genesis block; Mainnet's genesis differs. */
export const CHIPNET_GENESIS_BLOCK_HASH = "000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b";

/** Refuse to plan unless the Electrum endpoint proves it serves Chipnet, so Mainnet coins can't be swept. */
export async function assertChipnetProvider(provider: NetworkProvider): Promise<void> {
  const electrum = provider as NetworkProvider & { performRequest?: (name: string, ...args: number[]) => Promise<unknown> };
  if (typeof electrum.performRequest !== "function") throw new Error("Cannot verify that the BCH server is on Chipnet.");
  const header = await electrum.performRequest("blockchain.block.header", 0);
  if (typeof header !== "string" || !/^[0-9a-f]{160}$/i.test(header)) throw new Error("Cannot verify that the BCH server is on Chipnet.");
  const hash = binToHex(sha256.hash(sha256.hash(hexToBin(header))).reverse());
  if (hash !== CHIPNET_GENESIS_BLOCK_HASH) throw new Error("The BCH server is not on Chipnet. Nothing was prepared.");
}

function feeFor(builder: TransactionBuilder): bigint {
  return BigInt(Math.ceil(Number(builder.getTransactionSize()))) + 20n;
}

/**
 * Move every plain BCH coin held at the connected wallet's receive and change
 * addresses into one coin at `destination`. CashToken outputs are never spent.
 */
export async function planWalletConsolidation(
  provider: NetworkProvider,
  addresses: readonly WalletAddressEntry[],
  destination: string,
  excludeOutpoints: ReadonlySet<string> = new Set(),
): Promise<WalletConsolidationPlan> {
  await assertChipnetProvider(provider);
  const target = destination.trim().toLowerCase();
  if (!addresses.some((entry) => entry.address.toLowerCase() === target)) {
    throw new Error("The destination is not one of this wallet's addresses.");
  }
  const seen = new Set<string>();
  const coins: { utxo: SpendableUtxo; entry: WalletAddressEntry }[] = [];
  const results = await Promise.all(addresses.map(async (entry) => ({ entry, utxos: await provider.getUtxos(entry.address) })));
  for (const { entry, utxos } of results) {
    for (const utxo of utxos) {
      const key = utxo.txid + ":" + utxo.vout;
      if (utxo.token || utxo.satoshis <= 0n || seen.has(key) || excludeOutpoints.has(key.toLowerCase())) continue;
      seen.add(key);
      coins.push({ utxo, entry });
    }
  }
  coins.sort((a, b) => (a.utxo.satoshis === b.utxo.satoshis ? 0 : a.utxo.satoshis > b.utxo.satoshis ? -1 : 1));
  const selected = coins.slice(0, MAX_CONSOLIDATION_INPUTS);
  if (selected.length === 0) throw new Error("No plain BCH coins were found in this wallet's addresses.");
  if (selected.length === 1 && selected[0].entry.address.toLowerCase() === target) {
    throw new Error("Your BCH is already in a single coin at this address.");
  }

  const totalSatoshis = selected.reduce((sum, coin) => sum + coin.utxo.satoshis, 0n);
  const build = (outputSatoshis: bigint) => {
    const builder = new TransactionBuilder({ provider });
    selected.forEach(({ utxo, entry }) => builder.addInput(utxo, placeholderP2PKHUnlocker(entry.address)));
    builder.addOutput({ to: destination.trim(), amount: outputSatoshis });
    return builder;
  };
  const fee = feeFor(build(DUST));
  const outputSatoshis = totalSatoshis - fee;
  if (outputSatoshis < DUST) throw new Error("These coins are too small to cover the network fee.");
  const builder = build(outputSatoshis);
  const wc = builder.generateWcTransactionObject({ broadcast: false, userPrompt: "Gather your BCH into one coin for AjoChain" });
  const inputPaths = new Map<number, WalletInputPath>();
  selected.forEach(({ entry }, index) => inputPaths.set(index, { branch: entry.branch, index: entry.index }));
  return {
    wc,
    walletInputs: selected.map((_, index) => index),
    inputPaths,
    inputCount: selected.length,
    totalSatoshis,
    fee,
    outputSatoshis,
    destination: destination.trim(),
  };
}
