import {
  binToHex,
  cashAddressToLockingBytecode,
  decodeTransaction,
  hexToBin,
  hashTransactionUiOrder,
  lockingBytecodeToCashAddress,
  sha256,
  type Transaction,
} from '@bitauth/libauth';
import type { NetworkProvider } from 'cashscript';
import { pkhToAddress } from './bch-address';
import { createV2FeeCircleContract, v2FeeReceiptCommitment, v2FeeStateCommitment, V2_FEE_RECEIPT_OUTPUT_SATOSHIS, V2_FEE_STATE_OUTPUT_SATOSHIS, type V2FeeCircleParams } from './v2-fee-bch';
import { decodeV2FeeDiscoveryNote, V2_FEE_DISCOVERY_MARKER_SATS } from './v2-fee-discovery-note';
import { assertProviderNetwork } from './wallet-consolidation';

type DiscoveryNetwork = 'chipnet' | 'mainnet';

const DEFAULT_MAX_TRANSACTIONS = 300;
const DEFAULT_DISCOVERY_CONCURRENCY = 6;
const DEFAULT_DISCOVERY_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_DISCOVERY_OVERALL_TIMEOUT_MS = 45_000;

export type V2FeeDiscoveryOptions = {
  /** Addresses the caller wants searched before the remaining wallet address set. */
  priorityAddresses?: readonly string[];
  concurrency?: number;
  requestTimeoutMs?: number;
  overallTimeoutMs?: number;
  /** Called once when an individual RPC or the overall scan reaches its deadline. */
  onTimeout?: () => void;
};

class DiscoveryRequestTimeoutError extends Error {
  constructor() {
    super("Circle discovery request timed out.");
    this.name = "DiscoveryRequestTimeoutError";
  }
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<void>,
  isExpired: () => boolean,
  onExpired: () => void,
): Promise<void> {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      if (isExpired()) {
        onExpired();
        return;
      }
      const index = nextIndex++;
      await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
}

function p2pkhAddress(bytecode: Uint8Array, network: DiscoveryNetwork): string | null {
  if (bytecode.length !== 25 || bytecode[0] !== 0x76 || bytecode[1] !== 0xa9 || bytecode[2] !== 0x14 ||
      bytecode[23] !== 0x88 || bytecode[24] !== 0xac) return null;
  return pkhToAddress(bytecode.slice(3, 23), network);
}

function contractBytecodeHex(params: V2FeeCircleParams, provider: NetworkProvider): string {
  const bytecode = createV2FeeCircleContract(params, provider).lockingBytecode as string | Uint8Array;
  return (typeof bytecode === 'string' ? bytecode : binToHex(bytecode)).toLowerCase();
}

/**
 * Rebuild circle parameters from a discoverable genesis transaction and accept them
 * only if they derive the exact covenant that holds the freshly minted state and receipts.
 */
export function parseV2FeeDiscoveryTransaction(tx: Transaction, provider: NetworkProvider, network: DiscoveryNetwork = 'chipnet'): V2FeeCircleParams | null {
  const noteOutput = tx.outputs.find((output) => output.valueSatoshis === 0n && output.lockingBytecode[0] === 0x6a);
  const note = noteOutput ? decodeV2FeeDiscoveryNote(noteOutput.lockingBytecode) : null;
  if (note && (note.covenant === 'fee-v3-auto-reserve-mainnet') !== (network === 'mainnet')) return null;
  if (!note || tx.inputs.length === 0 || tx.inputs[0].outpointIndex !== 0) return null;
  const memberCount = note.memberCount;
  if (memberCount < 2 || memberCount > 5 || tx.outputs.length < 2 * memberCount + 2) return null;
  const category = binToHex(tx.inputs[0].outpointTransactionHash);
  const tokenMatches = (index: number, capability: string, commitment: string) => {
    const token = tx.outputs[index].token;
    return token !== undefined && binToHex(token.category) === category && token.amount === 0n &&
      token.nft?.capability === capability && binToHex(token.nft.commitment) === commitment;
  };
  if (tx.outputs[0].valueSatoshis !== V2_FEE_STATE_OUTPUT_SATOSHIS ||
      !tokenMatches(0, 'minting', v2FeeStateCommitment(0, false))) return null;
  for (let i = 0; i < memberCount; i++) {
    const receipt = tx.outputs[1 + i];
    if (receipt.valueSatoshis !== V2_FEE_RECEIPT_OUTPUT_SATOSHIS ||
        !tokenMatches(1 + i, 'none', v2FeeReceiptCommitment(i, 0n))) return null;
  }
  const members: string[] = [];
  for (let i = 0; i < memberCount; i++) {
    const marker = tx.outputs[1 + memberCount + i];
    const address = marker.token === undefined && marker.valueSatoshis === V2_FEE_DISCOVERY_MARKER_SATS
      ? p2pkhAddress(marker.lockingBytecode, network)
      : null;
    if (!address) return null;
    members.push(address);
  }
  if (tx.outputs[1 + 2 * memberCount] !== noteOutput) return null;
  const treasury = lockingBytecodeToCashAddress(network === 'mainnet'
    ? { prefix: 'bitcoincash', bytecode: note.treasuryLockingBytecode, tokenSupport: true }
    : { prefix: 'bchtest', bytecode: note.treasuryLockingBytecode });
  if (typeof treasury === 'string') return null;
  // Chipnet creation keeps the creator first. Mainnet creation accepts any member order;
  // the initiator is independently bound in the discovery note and exact covenant constructor.
  if (network === 'chipnet' && members[0] !== pkhToAddress(note.initiatorPkh, network)) return null;
  let params: V2FeeCircleParams;
  try {
    params = {
      version: 2,
      covenant: note.covenant,
      name: 'Found circle ' + category.slice(0, 8),
      network,
      members,
      contribution: note.contribution,
      maxFee: note.maxFee,
      stateCategory: category,
      initiator: pkhToAddress(note.initiatorPkh, network),
      treasury: treasury.address,
    };
    const expected = contractBytecodeHex(params, provider);
    for (let i = 0; i <= memberCount; i++) {
      if (binToHex(tx.outputs[i].lockingBytecode).toLowerCase() !== expected) return null;
    }
  } catch {
    return null;
  }
  return params;
}

/**
 * Find every discoverable circle on `network` that lists one of the wallet's own addresses as a member.
 *
 * Wallet addresses should be supplied in priority order, or passed through
 * `priorityAddresses`. All RPC reads retain their provider's existing quorum
 * agreement checks; this function only bounds concurrency and how long it waits.
 */
export async function discoverV2FeeCircles(
  provider: NetworkProvider,
  walletAddresses: readonly string[],
  maxTransactions = DEFAULT_MAX_TRANSACTIONS,
  network: DiscoveryNetwork = 'chipnet',
  options: V2FeeDiscoveryOptions = {},
): Promise<V2FeeCircleParams[]> {
  const concurrency = options.concurrency ?? DEFAULT_DISCOVERY_CONCURRENCY;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_DISCOVERY_REQUEST_TIMEOUT_MS;
  const overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_DISCOVERY_OVERALL_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxTransactions) || maxTransactions < 1 || maxTransactions > 2_000) {
    throw new Error('Circle discovery transaction limit must be between 1 and 2,000.');
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 12 ||
      !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
      !Number.isSafeInteger(overallTimeoutMs) || overallTimeoutMs < 1) {
    throw new Error('Circle discovery concurrency and timeout settings are invalid.');
  }

  const normalizedInput = [...new Set(walletAddresses.map((address) => address.trim().toLowerCase()).filter(Boolean))];
  const inputSet = new Set(normalizedInput);
  const priorityAddresses = (options.priorityAddresses ?? [])
    .map((address) => address.trim().toLowerCase())
    .filter((address, index, list) => inputSet.has(address) && list.indexOf(address) === index);
  const prioritySet = new Set(priorityAddresses);
  const normalizedAddresses = [
    ...priorityAddresses,
    ...normalizedInput.filter((address) => !prioritySet.has(address)),
  ];
  const owned = new Set(normalizedAddresses);
  const deadline = Date.now() + overallTimeoutMs;
  let didTimeout = false;
  const noteTimeout = () => {
    if (didTimeout) return;
    didTimeout = true;
    options.onTimeout?.();
  };
  const isExpired = () => Date.now() >= deadline;
  const request = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      noteTimeout();
      throw new DiscoveryRequestTimeoutError();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new DiscoveryRequestTimeoutError()), Math.min(requestTimeoutMs, remaining));
        }),
      ]);
    } catch (error) {
      if (error instanceof DiscoveryRequestTimeoutError) noteTimeout();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const electrum = provider as NetworkProvider & { performRequest: (name: string, ...args: string[]) => Promise<unknown> };
  try {
    await request(() => assertProviderNetwork(provider, network));
  } catch (error) {
    if (error instanceof DiscoveryRequestTimeoutError) return [];
    throw error;
  }

  const historyByTxid = new Map<string, number>();
  let successfulHistoryLookups = 0;
  await mapConcurrent(
    normalizedAddresses,
    concurrency,
    async (address) => {
      const bytecode = cashAddressToLockingBytecode(address);
      if (typeof bytecode === 'string') return;
      try {
        const scriptHash = binToHex(sha256.hash(bytecode.bytecode).reverse());
        const history = await request(() =>
          electrum.performRequest('blockchain.scripthash.get_history', scriptHash),
        );
        successfulHistoryLookups += 1;
        if (!Array.isArray(history)) return;
        const recentForAddress = history.flatMap((entry) => {
          const item = entry as { tx_hash?: unknown; height?: unknown };
          if (!Number.isSafeInteger(item?.height) || (item.height as number) <= 0 ||
              typeof item?.tx_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(item.tx_hash)) return [];
          return [{ txid: item.tx_hash.toLowerCase(), height: item.height as number }];
        }).sort((a, b) => b.height - a.height || a.txid.localeCompare(b.txid)).slice(0, maxTransactions);
        for (const item of recentForAddress) {
          historyByTxid.set(item.txid, Math.max(historyByTxid.get(item.txid) ?? 0, item.height));
        }
      } catch {
        // An unavailable or timed-out address is skipped without blocking other workers.
      }
    },
    isExpired,
    noteTimeout,
  );

  if (normalizedAddresses.length > 0 && successfulHistoryLookups === 0 && !didTimeout) {
    throw new Error('Could not read ' + network + ' transaction history for any connected wallet address.');
  }

  // Apply the global cap after collecting the newest confirmed history from
  // every address that answered before the deadline.
  const txids = [...historyByTxid.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTransactions)
    .map(([txid]) => txid);

  const decodedByIndex = new Array<V2FeeCircleParams | null>(txids.length).fill(null);
  await mapConcurrent(
    txids,
    concurrency,
    async (txid, index) => {
      try {
        const raw = await request(() => provider.getRawTransaction(txid));
        if (typeof raw !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(raw)) return;
        const rawBytes = hexToBin(raw);
        // Bind downloaded bytes to the requested TXID before interpreting outputs.
        if (binToHex(hashTransactionUiOrder(rawBytes)).toLowerCase() !== txid) return;
        const decoded = decodeTransaction(rawBytes);
        if (typeof decoded === 'string') return;
        const params = parseV2FeeDiscoveryTransaction(decoded, provider, network);
        if (params && params.members.some((member) => owned.has(member.toLowerCase()))) {
          decodedByIndex[index] = params;
        }
      } catch {
        // One stale, unavailable, or timed-out history item cannot hide other circles.
      }
    },
    isExpired,
    noteTimeout,
  );

  const found = new Map<string, V2FeeCircleParams>();
  for (const params of decodedByIndex) {
    if (params) found.set(params.stateCategory, params);
  }
  return [...found.values()];
}

export function encodeV2FeeCircleParams(params: V2FeeCircleParams): string {
  const json = JSON.stringify({ ...params, contribution: params.contribution.toString(), maxFee: params.maxFee.toString() });
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
