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
): Promise<WalletConsolidationPlan> {
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
      if (utxo.token || utxo.satoshis <= 0n || seen.has(key)) continue;
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
