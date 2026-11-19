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
  // The creator is required to be member 1. This is the member order used by
  // circle creation and by the UI's initiator-only cancellation permissions.
  if (members[0] !== pkhToAddress(note.initiatorPkh, network)) return null;
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

/** Find every discoverable circle on `network` that lists one of the wallet's own addresses as a member. */
export async function discoverV2FeeCircles(
  provider: NetworkProvider,
  walletAddresses: readonly string[],
  maxTransactions = DEFAULT_MAX_TRANSACTIONS,
  network: DiscoveryNetwork = 'chipnet',
): Promise<V2FeeCircleParams[]> {
  await assertProviderNetwork(provider, network);
  const electrum = provider as NetworkProvider & { performRequest: (name: string, ...args: string[]) => Promise<unknown> };
  if (!Number.isSafeInteger(maxTransactions) || maxTransactions < 1 || maxTransactions > 2_000) {
    throw new Error('Circle discovery transaction limit must be between 1 and 2,000.');
  }
  const normalizedAddresses = [...new Set(walletAddresses.map((address) => address.trim().toLowerCase()).filter(Boolean))];
  const owned = new Set(normalizedAddresses);
  const historyByTxid = new Map<string, number>();
  let successfulHistoryLookups = 0;
  for (const address of normalizedAddresses) {
    const bytecode = cashAddressToLockingBytecode(address);
    if (typeof bytecode === 'string') continue;
    let history: unknown;
    try {
      history = await electrum.performRequest('blockchain.scripthash.get_history', binToHex(sha256.hash(bytecode.bytecode).reverse()));
      successfulHistoryLookups += 1;
    } catch {
      // Keep scanning other receive/change addresses if one lookup is unavailable.
      continue;
    }
    if (!Array.isArray(history)) continue;
    const recentForAddress = history.flatMap((entry) => {
      const item = entry as { tx_hash?: unknown; height?: unknown };
      if (!Number.isSafeInteger(item?.height) || (item.height as number) <= 0 ||
          typeof item?.tx_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(item.tx_hash)) return [];
      return [{ txid: item.tx_hash.toLowerCase(), height: item.height as number }];
    }).sort((a, b) => b.height - a.height || a.txid.localeCompare(b.txid)).slice(0, maxTransactions);
    for (const item of recentForAddress) {
      historyByTxid.set(item.txid, Math.max(historyByTxid.get(item.txid) ?? 0, item.height));
    }
  }
  if (normalizedAddresses.length > 0 && successfulHistoryLookups === 0) {
    throw new Error('Could not read ' + network + ' transaction history for any connected wallet address.');
  }
  // Apply the global cap after collecting the newest confirmed history from
  // every receive/change address; a busy first address must not starve the rest.
  const txids = [...historyByTxid.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTransactions)
    .map(([txid]) => txid);
  const found = new Map<string, V2FeeCircleParams>();
  for (const txid of txids) {
    try {
      const raw = await provider.getRawTransaction(txid);
      if (typeof raw !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(raw)) continue;
      const rawBytes = hexToBin(raw);
      // Bind downloaded bytes to the requested TXID before interpreting outputs.
      if (binToHex(hashTransactionUiOrder(rawBytes)).toLowerCase() !== txid) continue;
      const decoded = decodeTransaction(rawBytes);
      if (typeof decoded === 'string') continue;
      const params = parseV2FeeDiscoveryTransaction(decoded, provider, network);
      if (params && params.members.some((member) => owned.has(member.toLowerCase()))) {
        found.set(params.stateCategory, params);
      }
    } catch {
      // One stale or unavailable history item must not hide other verified circles.
      continue;
    }
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
