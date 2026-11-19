import { binToHex, cashAddressToLockingBytecode, hexToBin } from '@bitauth/libauth';

/** Plain BCH sent to each member at genesis so the member's own wallet history reveals the circle. */
export const V2_FEE_DISCOVERY_MARKER_SATS = 546n;
const NOTE_TAG = '414a4f44'; // "AJOD"
const NOTE_VERSION = 1;
export const V2_FEE_DISCOVERY_COVENANT_CODES = { 'fee-v3-auto-reserve-closing': 1 } as const;
export type V2FeeDiscoverableCovenant = keyof typeof V2_FEE_DISCOVERY_COVENANT_CODES;

export type V2FeeDiscoveryNote = {
  covenant: V2FeeDiscoverableCovenant;
  memberCount: number;
  contribution: bigint;
  maxFee: bigint;
  initiatorPkh: Uint8Array;
  treasuryLockingBytecode: Uint8Array;
};

export const isV2FeeDiscoverableCovenant = (covenant: string): covenant is V2FeeDiscoverableCovenant =>
  Object.prototype.hasOwnProperty.call(V2_FEE_DISCOVERY_COVENANT_CODES, covenant);

function lockingBytecode(address: string): Uint8Array {
  const result = cashAddressToLockingBytecode(address);
  if (typeof result === 'string') throw new Error(result);
  return result.bytecode;
}

function uint64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/** OP_RETURN "AJOD" <version | covenant | members | contribution | maxFee | initiator pkh | treasury script>. */
export function encodeV2FeeDiscoveryNote(note: V2FeeDiscoveryNote): Uint8Array {
  const treasury = note.treasuryLockingBytecode;
  if (note.initiatorPkh.length !== 20 || treasury.length < 1 || treasury.length > 40) throw new Error('Invalid discovery note details');
  const payload = new Uint8Array([
    NOTE_VERSION,
    V2_FEE_DISCOVERY_COVENANT_CODES[note.covenant],
    note.memberCount,
    ...uint64le(note.contribution),
    ...uint64le(note.maxFee),
    ...note.initiatorPkh,
    treasury.length,
    ...treasury,
  ]);
  return new Uint8Array([0x6a, 0x04, ...hexToBin(NOTE_TAG), payload.length, ...payload]);
}

export function decodeV2FeeDiscoveryNote(script: Uint8Array): V2FeeDiscoveryNote | null {
  if (script.length < 7 || script[0] !== 0x6a || script[1] !== 0x04 || binToHex(script.slice(2, 6)) !== NOTE_TAG) return null;
  const length = script[6];
  const payload = script.slice(7);
  if (length > 0x4b || payload.length !== length || payload.length < 40) return null;
  if (payload[0] !== NOTE_VERSION) return null;
  const covenant = (Object.keys(V2_FEE_DISCOVERY_COVENANT_CODES) as V2FeeDiscoverableCovenant[])
    .find((key) => V2_FEE_DISCOVERY_COVENANT_CODES[key] === payload[1]);
  if (!covenant) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const treasuryLength = payload[39];
  if (payload.length !== 40 + treasuryLength) return null;
  return {
    covenant,
    memberCount: payload[2],
    contribution: view.getBigUint64(3, true),
    maxFee: view.getBigUint64(11, true),
    initiatorPkh: payload.slice(19, 39),
    treasuryLockingBytecode: payload.slice(40),
  };
}

/** Outputs appended after the receipts of a discoverable genesis: one marker per member, then the note. */
export function v2FeeDiscoveryOutputs(params: {
  covenant: V2FeeDiscoverableCovenant;
  members: readonly string[];
  contribution: bigint;
  maxFee: bigint;
  initiatorPkh: Uint8Array;
  treasury: string;
}): { lockingBytecode: Uint8Array; valueSatoshis: bigint }[] {
  return [
    ...params.members.map((member) => ({ lockingBytecode: lockingBytecode(member), valueSatoshis: V2_FEE_DISCOVERY_MARKER_SATS })),
    {
      lockingBytecode: encodeV2FeeDiscoveryNote({
        covenant: params.covenant,
        memberCount: params.members.length,
        contribution: params.contribution,
        maxFee: params.maxFee,
        initiatorPkh: params.initiatorPkh,
        treasuryLockingBytecode: lockingBytecode(params.treasury),
      }),
      valueSatoshis: 0n,
    },
  ];
}
