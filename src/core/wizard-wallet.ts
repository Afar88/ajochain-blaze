// WizardConnect wallet integration (dapp side).
// Pairing is handled by WizardConnect. The wallet supplies xpubs; AjoChain
// derives receive addresses locally and asks the wallet to sign transactions.
import { initiateDappRelay, RelayMsgAction, type DappRelayResult } from '@wizardconnect/core';
import { DappConnectionManager, loadSession } from '@wizardconnect/dapp';
import { binToHex, createVirtualMachineBch2026, decodeCashAddress, decodeTransactionBCH, encodeTransactionOutputs, hash160, hexToBin } from '@bitauth/libauth';
import { sourceOutputToRelay, transactionToHex } from '@wizardconnect/core/hdwalletv1-serialize';
import { pkhToAddress, type Net } from './bch-address';

export const WIZARDCONNECT_RECEIVE_CHILD_INDEX = 0;
export const DEFAULT_RECEIVE_ADDRESS_SEARCH_LIMIT = 50;
/** WizardConnect hdwalletv1 "change" child path (childIndexOfPathName("change")). */
export const WIZARDCONNECT_CHANGE_CHILD_INDEX = 1;

export type WalletPathBranch = 'receive' | 'change';
export type WalletInputPath = { branch: WalletPathBranch; index: number };
export type WalletAddressEntry = WalletInputPath & { address: string };

export function wizardConnectReceiveAddressIndexes(receiveLimit: number, selectedIndex: number): number[] {
  if (!Number.isSafeInteger(receiveLimit) || receiveLimit < 0 || receiveLimit > 10000 ||
      !Number.isSafeInteger(selectedIndex) || selectedIndex < 0 || selectedIndex > 100000) {
    throw new Error("WizardConnect receive-address indexes are outside the supported range.");
  }
  const indexes = Array.from({ length: receiveLimit + 1 }, (_, index) => index);
  if (!indexes.includes(selectedIndex)) indexes.push(selectedIndex);
  return indexes.sort((left, right) => left - right);
}

export function deriveWizardConnectAddress(
  protocol: string | null,
  getPubkey: ((childIndex: number, addressIndex: bigint) => Uint8Array | undefined) | null,
  network: Net,
  branch: WalletPathBranch,
  addressIndex: number,
): string | null {
  if (protocol !== 'hdwalletv1' || !getPubkey ||
      !Number.isSafeInteger(addressIndex) || addressIndex < 0) return null;
  const childIndex = branch === 'change' ? WIZARDCONNECT_CHANGE_CHILD_INDEX : WIZARDCONNECT_RECEIVE_CHILD_INDEX;
  const publicKey = getPubkey(childIndex, BigInt(addressIndex));
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 33 ||
      (publicKey[0] !== 0x02 && publicKey[0] !== 0x03)) return null;
  return pkhToAddress(hash160(publicKey), network);
}

/**
 * Derive a BCH receive address from the active WizardConnect hdwalletv1
 * receive xpub. Never return a cached address or an address from another
 * protocol/session: 0 is the documented WizardConnect "receive" child path.
 */
const CASH_ADDRESS_PREFIX: Record<Net, string> = { mainnet: 'bitcoincash', chipnet: 'bchtest' };

export function findWizardConnectReceiveIndex(
  address: string,
  protocol: string | null,
  getPubkey: ((childIndex: number, addressIndex: bigint) => Uint8Array | undefined) | null,
  network: Net,
  maxIndex = DEFAULT_RECEIVE_ADDRESS_SEARCH_LIMIT,
): number | null {
  if (!Number.isSafeInteger(maxIndex) || maxIndex < 0 || maxIndex > 10000) {
    throw new Error('Receive-address search limit must be between 0 and 10,000.');
  }
  const trimmed = address.trim().toLowerCase();
  if (!trimmed) return null;
  const expectedPrefix = CASH_ADDRESS_PREFIX[network];
  const otherNetwork: Net = network === 'mainnet' ? 'chipnet' : 'mainnet';
  const candidates = trimmed.includes(':')
    ? [trimmed]
    : [expectedPrefix + ':' + trimmed, CASH_ADDRESS_PREFIX[otherNetwork] + ':' + trimmed];
  const decoded = candidates.map((candidate) => decodeCashAddress(candidate)).find((result) => typeof result !== 'string');
  if (!decoded) throw new Error('That is not a valid Bitcoin Cash address. Copy it again from Selene.');
  if (decoded.type !== 'p2pkh' && decoded.type !== 'p2pkhWithTokens') {
    throw new Error('That is not a Selene receive address. Copy the address from Selene\'s Receive screen.');
  }
  if (decoded.prefix !== expectedPrefix) {
    const addressNetwork = decoded.prefix === 'bchtest' ? 'Chipnet' : decoded.prefix === 'bitcoincash' ? 'Mainnet' : decoded.prefix;
    throw new Error(
      'This is a ' + addressNetwork + ' address, but the site is set to ' +
      (network === 'chipnet' ? 'Chipnet' : 'Mainnet') + '. Switch the site and Selene to the same network, then match again.',
    );
  }
  const target = binToHex(decoded.payload);
  for (let i = 0; i <= maxIndex; i++) {
    if (protocol !== 'hdwalletv1' || !getPubkey) return null;
    const publicKey = getPubkey(WIZARDCONNECT_RECEIVE_CHILD_INDEX, BigInt(i));
    if (!(publicKey instanceof Uint8Array) || publicKey.length !== 33 ||
        (publicKey[0] !== 0x02 && publicKey[0] !== 0x03)) continue;
    if (binToHex(hash160(publicKey)) === target) return i;
  }
  return null;
}

export function deriveWizardConnectReceiveAddress(
  protocol: string | null,
  getPubkey: ((childIndex: number, addressIndex: bigint) => Uint8Array | undefined) | null,
  network: Net,
  addressIndex: number,
): string | null {
  if (protocol !== "hdwalletv1" || !getPubkey ||
      !Number.isSafeInteger(addressIndex) || addressIndex < 0) return null;
  const publicKey = getPubkey(WIZARDCONNECT_RECEIVE_CHILD_INDEX, BigInt(addressIndex));
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 33 ||
      (publicKey[0] !== 0x02 && publicKey[0] !== 0x03)) return null;
  return pkhToAddress(hash160(publicKey), network);
}

export type WalletState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnecting' | 'disconnected';

type Listener = () => void;

/** Keep temporary relay drops visible as recoverable, rather than as a dead wallet session. */
export function wizardRelayStatusMessage(status: string, detail?: string): string | null {
  if (status === "connected") return null;
  const reason = typeof detail === "string" ? detail.trim() : "";
  return reason
    ? "WizardConnect relay interrupted: " + reason + ". AjoChain is retrying automatically."
    : "WizardConnect relay is reconnecting. Keep this page open and return after Selene.";
}

const PATHS_STORAGE_KEY = 'ajochain:wizardconnect-paths:v1';
const RECEIVE_INDEX_STORAGE_KEY = 'ajochain:wizardconnect-receive-index:v1';


function restorePublicPaths(mgr: DappConnectionManager) {
  try {
    const raw = localStorage.getItem(PATHS_STORAGE_KEY);
    if (!raw) return;
    const paths: any = JSON.parse(raw);
    if (!Array.isArray(paths)) throw new Error('Invalid cached WizardConnect paths');
    mgr.restoreSessionPaths(paths);
  } catch {
    // Never let stale/corrupt public derivation data block a fresh connection.
    try { localStorage.removeItem(PATHS_STORAGE_KEY); } catch { /* best effort */ }
  }
}

function savePublicPaths(mgr: DappConnectionManager) {
  try {
    const paths = mgr.getSessionPaths();
    if (Array.isArray(paths) && paths.length) localStorage.setItem(PATHS_STORAGE_KEY, JSON.stringify(paths));
  } catch { /* public path caching is an enhancement, not a connection requirement */ }
}

function loadReceiveIndex() {
  try {
    const value = Number(localStorage.getItem(RECEIVE_INDEX_STORAGE_KEY));
    return Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : 0;
  } catch { return 0; }
}

/**
 * Convert CashScript's native transaction object to WizardConnect's canonical
 * relay representation. Transactions travel as raw hex; source outputs use
 * WizardConnect's serializer (hex byte arrays and extended-JSON BigInts).
 */
export function buildWizardSignRequest(
  wcObject: any,
  walletInputs: number[],
  receiveIndex: number | ReadonlyMap<number, WalletInputPath>,
  prompt: string,
  sequence: number,
) {
  const transaction = wcObject?.transaction;
  const sourceOutputs = wcObject?.sourceOutputs;
  if (!Array.isArray(transaction?.inputs) || !Array.isArray(transaction?.outputs) ||
      !Array.isArray(sourceOutputs) || sourceOutputs.length !== transaction.inputs.length) {
    throw new Error('CashScript returned an incomplete wallet-signing request (transaction/source-output count mismatch).');
  }

  const inputPaths = walletInputs.map((inputIndex) => {
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= transaction.inputs.length) {
      throw new Error(`Invalid wallet signing input index: ${inputIndex}`);
    }
    if (typeof receiveIndex === 'number') return [inputIndex, 'receive', receiveIndex] as [number, string, number];
    const path = receiveIndex.get(inputIndex);
    if (!path || (path.branch !== 'receive' && path.branch !== 'change') ||
        !Number.isSafeInteger(path.index) || path.index < 0) {
      throw new Error(`Missing or invalid wallet path for signing input ${inputIndex}.`);
    }
    return [inputIndex, path.branch, path.index] as [number, string, number];
  });
  if (new Set(walletInputs).size !== walletInputs.length) {
    throw new Error('Wallet signing request contains duplicate input indexes.');
  }

  // The relay is JSON-based: never pass native transaction objects containing
  // BigInt or Uint8Array values. WizardConnect requires the transaction as raw
  // BCH transaction hex and source outputs in its canonical relay-safe format.
  const relayTransaction = transactionToHex(
    transaction.inputs,
    transaction.outputs,
    transaction.version,
    transaction.locktime,
  );
  const relaySourceOutputs = transaction.inputs.map((input: unknown, index: number) => {
    const sourceOutput = { ...(input as object), ...sourceOutputs[index] } as any;
    const relaySourceOutput = sourceOutputToRelay(sourceOutput) as Record<string, any>;

    // The reference serializer omits CashScript covenant metadata. Selene
    // needs this contract descriptor to recognise P2SH32 inputs, replace the
    // placeholder signature/public key and build the correct covenant spend.
    const contract = sourceOutput.contract;
    if (contract) {
      const redeemScript = contract.redeemScript instanceof Uint8Array
        ? binToHex(contract.redeemScript)
        : typeof contract.redeemScript === "string"
          ? contract.redeemScript.toLowerCase()
          : "";
      const contractName = contract.artifact?.contractName;
      const functionName = contract.abiFunction?.name;
      if (!redeemScript || typeof contractName !== "string" || !contractName ||
          typeof functionName !== "string" || !functionName) {
        throw new Error("CashScript wallet input is missing its contract name, ABI function or redeem script.");
      }
      const abiInputs = Array.isArray(contract.abiFunction.inputs)
        ? contract.abiFunction.inputs.map((entry: any) => ({
            ...(typeof entry?.name === "string" ? { name: entry.name } : {}),
            ...(typeof entry?.type === "string" ? { type: entry.type } : {}),
          }))
        : [];
      relaySourceOutput.contract = {
        abiFunction: { name: functionName, inputs: abiInputs },
        redeemScript,
        artifact: { contractName },
      };
    }
    return relaySourceOutput;
  });

  const request = {
    action: RelayMsgAction.SignTransactionRequest,
    sequence,
    time: Math.floor(Date.now() / 1000),
    transaction: {
      transaction: relayTransaction,
      sourceOutputs: relaySourceOutputs,
      broadcast: false,
      userPrompt: prompt,
    },
    inputPaths,
  };

  // Fail locally with a useful error if a future change reintroduces native
  // BigInt/byte arrays into the JSON relay payload. This runs before Selene is
  // contacted, and intentionally does not weaken any amount or tx validation.
  try {
    JSON.stringify(request);
  } catch (error) {
    throw new Error(
      "WizardConnect signing request is not JSON-serializable: " +
      (error instanceof Error ? error.message : String(error)),
    );
  }
  return request;
}


/**
 * Verify that the wallet returned a valid serialization of the transaction
 * AjoChain asked it to sign. Unlocking scripts may change; transaction intent
 * (version, locktime, input outpoints/order/sequence, and every output) may not.
 * This is a dapp-side integrity check, not a substitute for covenant validation.
 */
/**
 * Parse a push-only unlocking script. P2PKH wallet inputs use two pushes:
 * signature (including the sighash byte) and public key.
 */
export function readPushOnlyUnlockingScript(script: Uint8Array): Uint8Array[] {
  const pushes: Uint8Array[] = [];
  let offset = 0;
  while (offset < script.length) {
    const opcode = script[offset++];
    let length: number;
    // Bitcoin's IsPushOnly semantics include small-integer opcodes.
    // Convert them to minimally encoded stack values for ABI inspection.
    if (opcode === 0x00) {
      pushes.push(new Uint8Array());
      continue;
    } else if (opcode === 0x4f) {
      pushes.push(Uint8Array.from([0x81]));
      continue;
    } else if (opcode >= 0x51 && opcode <= 0x60) {
      pushes.push(Uint8Array.from([opcode - 0x50]));
      continue;
    } else if (opcode <= 75) {
      length = opcode;
    } else if (opcode === 0x4c) {
      if (offset + 1 > script.length) throw new Error("Malformed PUSHDATA1 unlocking script.");
      length = script[offset++];
    } else if (opcode === 0x4d) {
      if (offset + 2 > script.length) throw new Error("Malformed PUSHDATA2 unlocking script.");
      length = script[offset] | (script[offset + 1] << 8);
      offset += 2;
    } else if (opcode === 0x4e) {
      if (offset + 4 > script.length) throw new Error("Malformed PUSHDATA4 unlocking script.");
      length = new DataView(script.buffer, script.byteOffset + offset, 4).getUint32(0, true);
      offset += 4;
    } else {
      throw new Error("Wallet-owned input contains a non-push opcode in its unlocking script.");
    }
    if (offset + length > script.length) throw new Error("Unlocking script push exceeds its available bytes.");
    pushes.push(script.slice(offset, offset + length));
    offset += length;
  }
  return pushes;
}

/**
 * WizardConnect's hdwalletv1 protocol requires SIGHASH_ALL | FORKID | UTXOS
 * (0x61). A wallet-owned P2PKH input signed with a weaker flag is rejected.
 */
export function assertRequiredWalletSighash(script: Uint8Array): void {
  const pushes = readPushOnlyUnlockingScript(script);
  if (pushes.length !== 2) {
    throw new Error("Wallet-owned P2PKH input must contain exactly a signature and public-key push.");
  }
  const signature = pushes[0];
  const publicKey = pushes[1];
  if (signature.length < 2 || signature[signature.length - 1] !== 0x61) {
    throw new Error("Wallet signature must use SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_UTXOS (0x61).");
  }
  if (publicKey.length !== 33 && publicKey.length !== 65) {
    throw new Error("Wallet-owned input did not contain a valid compressed or uncompressed public key.");
  }
}

/**
 * Recognize a 64-byte Schnorr or canonical DER ECDSA signature argument,
 * including its trailing BCH sighash byte. Cryptographic validity remains
 * the BCH 2026 VM's job.
 */
function isBchTransactionSignature(push: Uint8Array): boolean {
  // Cashonize/Selene commonly uses Schnorr (64-byte signature + 0x61 sighash).
  if (push.length === 65) return true;
  // Some compatible wallets can return DER-encoded ECDSA signatures.
  if (push.length < 9 || push.length > 73 || push[0] !== 0x30 ||
      push[1] !== push.length - 3 || push[2] !== 0x02) return false;

  const rLength = push[3];
  if (rLength === 0 || rLength > 33) return false;
  const sTagIndex = 4 + rLength;
  if (sTagIndex + 2 >= push.length - 1 || push[sTagIndex] !== 0x02) return false;
  const sLength = push[sTagIndex + 1];
  if (sLength === 0 || sLength > 33 || 6 + rLength + sLength !== push.length - 1) return false;

  const rFirst = push[4];
  const sFirst = push[sTagIndex + 2];
  if ((rFirst & 0x80) !== 0 || (sFirst & 0x80) !== 0) return false;
  if (rLength > 1 && rFirst === 0 && (push[5] & 0x80) === 0) return false;
  if (sLength > 1 && sFirst === 0 && (push[sTagIndex + 3] & 0x80) === 0) return false;
  return true;
}

/**
 * CashScript P2SH32 unlockers put ABI arguments before the final redeem-script
 * push. Enforce the WizardConnect 0x61 policy on each DER signature argument.
 */
export function assertRequiredContractWalletSighash(script: Uint8Array): void {
  const pushes = readPushOnlyUnlockingScript(script);
  const argumentsOnly = pushes.slice(0, -1);
  const signatures = argumentsOnly.filter(isBchTransactionSignature);
  if (signatures.length === 0) {
    throw new Error("Wallet-signed covenant input is missing its transaction signature argument.");
  }
  if (signatures.some((signature) => signature[signature.length - 1] !== 0x61)) {
    throw new Error("Wallet covenant signature must use SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_UTXOS (0x61).");
  }
}

/** Ensure every P2PKH prevout is explicitly included in the wallet signing request. */
export function assertP2pkhWalletInputCoverage(
  sourceOutputs: readonly { lockingBytecode: Uint8Array }[],
  walletInputs: readonly number[],
): void {
  const requested = new Set(walletInputs);
  for (let index = 0; index < sourceOutputs.length; index += 1) {
    const script = binToHex(sourceOutputs[index]?.lockingBytecode ?? new Uint8Array()).toLowerCase();
    if (/^76a914[0-9a-f]{40}88ac$/.test(script) && !requested.has(index)) {
      throw new Error(`P2PKH funding input ${index} is missing from the wallet signing input indexes.`);
    }
  }
}

export function verifySignedTransaction(
  signedHex: string,
  expected: any,
  expectedSourceOutputs?: any[],
  walletInputs: number[] = [],
) {
  if (typeof signedHex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(signedHex)) {
    throw new Error('Wallet returned malformed transaction hex.');
  }
  const decoded = decodeTransactionBCH(hexToBin(signedHex));
  if (typeof decoded === 'string') {
    throw new Error(`Wallet returned an invalid BCH transaction: ${decoded}`);
  }
  if (!expected || !Array.isArray(expected.inputs) || !Array.isArray(expected.outputs)) {
    throw new Error('Original transaction is incomplete; refusing to broadcast.');
  }
  if (!Array.isArray(expectedSourceOutputs) || expectedSourceOutputs.length !== expected.inputs.length) {
    throw new Error('Exact previous-output data is missing; refusing to trust a wallet signature.');
  }
  if (decoded.version !== expected.version || decoded.locktime !== expected.locktime) {
    throw new Error('Wallet changed transaction version or locktime; refusing to broadcast.');
  }
  if (decoded.inputs.length !== expected.inputs.length) {
    throw new Error('Wallet changed transaction inputs; refusing to broadcast.');
  }
  for (let i = 0; i < expected.inputs.length; i++) {
    const actual = decoded.inputs[i];
    const planned = expected.inputs[i];
    if (binToHex(actual.outpointTransactionHash) !== binToHex(planned.outpointTransactionHash) ||
        actual.outpointIndex !== planned.outpointIndex ||
        actual.sequenceNumber !== planned.sequenceNumber) {
      throw new Error(`Wallet changed transaction input ${i}; refusing to broadcast.`);
    }
  }
  if (binToHex(encodeTransactionOutputs(decoded.outputs)) !==
      binToHex(encodeTransactionOutputs(expected.outputs))) {
    throw new Error('Wallet changed transaction outputs or CashTokens; refusing to broadcast.');
  }

  const seenWalletInputs = new Set<number>();
  for (const index of walletInputs) {
    if (!Number.isInteger(index) || index < 0 || index >= decoded.inputs.length || seenWalletInputs.has(index)) {
      throw new Error('Wallet signing input indexes are invalid or duplicated.');
    }
    seenWalletInputs.add(index);
    const sourceScript = binToHex(expectedSourceOutputs[index]?.lockingBytecode ?? new Uint8Array()).toLowerCase();
    // Check the wallet protocol's required sighash on both ordinary BCH
    // funding inputs and CashScript P2SH32 inputs carrying wallet ABI signatures.
    if (/^76a914[0-9a-f]{40}88ac$/.test(sourceScript)) {
      assertRequiredWalletSighash(decoded.inputs[index].unlockingBytecode);
    } else if (/^aa20[0-9a-f]{64}87$/.test(sourceScript)) {
      assertRequiredContractWalletSighash(decoded.inputs[index].unlockingBytecode);
    } else {
      throw new Error("Cannot verify the required 0x61 sighash for this wallet-signed input script; refusing to broadcast.");
    }
  }

  assertP2pkhWalletInputCoverage(expectedSourceOutputs, walletInputs);

  const vmResult = createVirtualMachineBch2026().verify({
    transaction: decoded,
    sourceOutputs: expectedSourceOutputs,
  });
  if (vmResult !== true) {
    throw new Error('Signed BCH transaction failed local BCH 2026 VM verification: ' + String(vmResult));
  }
  return decoded;
}

class WizardWallet {
  state: WalletState = 'idle';
  uri: string | null = null;
  qrUri: string | null = null;
  walletName: string | null = null;
  /** Receive-address index selected by matching Selene's displayed address. */
  receiveIndex = loadReceiveIndex();
  error: string | null = null;
  private mgr: DappConnectionManager | null = null;
  private relay: DappRelayResult | null = null;
  private listeners: Listener[] = [];
  // Invalidates callbacks from managers that have been replaced or disconnected.
  private generation = 0;
  private connectionWatchdog: ReturnType<typeof setTimeout> | null = null;
  // Foreground/focus/online can fire in quick succession on mobile browsers.
  private lastResumeAttemptAt = 0;

  onChange(fn: Listener) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((listener) => listener !== fn); }; }
  private emit() { this.listeners.forEach((f) => f()); }

  private clearConnectionWatchdog() {
    if (this.connectionWatchdog) clearTimeout(this.connectionWatchdog);
    this.connectionWatchdog = null;
  }

  private startConnectionWatchdog(
    mgr: DappConnectionManager,
    generation: number,
    existing: boolean,
  ) {
    this.clearConnectionWatchdog();
    this.connectionWatchdog = setTimeout(() => {
      if (!this.isCurrent(mgr, generation) || this.state !== "connecting") return;
      this.error = existing
        ? "Selene has not completed the saved-session handshake. Retry the saved session or start a fresh pairing."
        : "Still waiting for Selene. Keep AjoChain open, or start a fresh pairing.";
      this.emit();
    }, 20_000);
  }

  private isCurrent(mgr: DappConnectionManager, generation: number) {
    return this.mgr === mgr && this.generation === generation;
  }

  private cleanup(mgr: DappConnectionManager | null, relay: DappRelayResult | null, clearSession = true) {
    try { relay?.cleanup(); } catch { /* cleanup must not block local disconnect */ }
    if (clearSession) {
      try { mgr?.clearStoredSession(); } catch { /* best effort */ }
    }
    try { mgr?.destroy(); } catch { /* best effort */ }
  }

  connect(existing?: { privateKey: string; secret: string; walletPublicKey: string }) {
    // Do not create overlapping relays/managers. A reconnecting manager owns its retry loop.
    if (this.state === 'connecting' || this.state === 'reconnecting' ||
        this.state === 'connected' || this.state === 'disconnecting') return;
    this.clearConnectionWatchdog();
    this.error = null;
    // Keep the previously matched public receive index when resuming a saved session.
    // A fresh pairing starts at index 0 and can be matched again by the user.
    this.receiveIndex = existing ? loadReceiveIndex() : 0;
    this.state = 'connecting';
    const generation = ++this.generation;
    const icon = new URL('favicon.svg', location.href).toString();
    const mgr = new DappConnectionManager('AjoChain', icon);
    // Restore public xpub paths before the relay handshake so cached addresses
    // remain derivable during a page reload. These paths cannot sign or spend.
    restorePublicPaths(mgr);
    this.mgr = mgr;

    mgr.on('walletready', () => {
      if (!this.isCurrent(mgr, generation)) return;
      this.clearConnectionWatchdog();
      this.walletName = mgr.walletName;
      savePublicPaths(mgr);
      this.error = null;
      this.state = 'connected';
      this.emit();
    });
    mgr.on('reconnecting', () => {
      if (!this.isCurrent(mgr, generation)) return;
      this.state = 'reconnecting';
      this.emit();
    });
    mgr.on('disconnect', (reason, detail) => {
      if (!this.isCurrent(mgr, generation)) return;
      this.clearConnectionWatchdog();
      const relay = this.relay;
      const reasonText = String(reason ?? "");
      const detailText = typeof detail === "string" ? detail.trim() : "";
      const protocolMismatch = reasonText === "protocol_mismatch";
      this.generation++;
      this.mgr = null;
      this.relay = null;
      this.uri = null;
      this.qrUri = null;
      this.walletName = null;
      this.receiveIndex = loadReceiveIndex();
      this.state = 'disconnected';
      this.error = detailText || (protocolMismatch
        ? "Selene and AjoChain could not agree on a WizardConnect protocol. Start a fresh pairing."
        : "Selene closed the WizardConnect session. Start a fresh pairing to reconnect.");
      // A DappConnectionManager disconnect is a remote wallet disconnect or a
      // protocol mismatch, not an ordinary background relay interruption.
      // Such a session must not be silently resumed with stale credentials.
      this.cleanup(mgr, relay, true);
      this.emit();
    });

    try {
      const relay = initiateDappRelay((payload) => {
        if (!this.isCurrent(mgr, generation)) return;
        mgr.updateConnection(payload.client, payload.status);
        const status = payload.status as { status?: string; error?: string | null };
        if (status.status === "reconnecting" || status.status === "disconnected") {
          this.clearConnectionWatchdog();
          this.state = "reconnecting";
          this.error = wizardRelayStatusMessage(status.status, status.error ?? undefined);
          this.emit();
        } else if (status.status === "connected") {
          // The relay is back; wait for wallet_ready before marking the wallet
          // connected again. Give the resumed handshake its own timeout.
          this.error = null;
          if (this.state !== "connected") {
            this.state = "connecting";
            this.startConnectionWatchdog(mgr, generation, Boolean(existing));
          }
          this.emit();
        }
      }, { existingCredentials: existing });
      if (!this.isCurrent(mgr, generation)) {
        this.cleanup(mgr, relay);
        return;
      }
      this.relay = relay;
      if (!existing) { this.uri = relay.uri; this.qrUri = relay.qrUri; }
      mgr.attachRelay(relay);
      this.startConnectionWatchdog(mgr, generation, Boolean(existing));
    } catch (e) {
      if (this.isCurrent(mgr, generation)) {
        this.clearConnectionWatchdog();
        this.error = e instanceof Error ? e.message : 'Failed to start WizardConnect relay';
        this.mgr = null;
        this.relay = null;
        this.state = 'idle';
        this.cleanup(mgr, null);
      }
    }
    this.emit();
  }

  /** Discard a stalled/stale pairing and create a fresh WizardConnect relay. */
  startFreshPairing() {
    if (this.state === 'connected' || this.state === 'disconnecting') return;
    const mgr = this.mgr;
    const relay = this.relay;
    this.generation++;
    this.mgr = null;
    this.relay = null;
    this.clearConnectionWatchdog();
    this.cleanup(mgr, relay, true);
    this.uri = null;
    this.qrUri = null;
    this.walletName = null;
    this.receiveIndex = 0;
    try {
      localStorage.removeItem(PATHS_STORAGE_KEY);
      localStorage.removeItem(RECEIVE_INDEX_STORAGE_KEY);
    } catch { /* best effort */ }
    this.error = null;
    this.state = 'idle';
    this.emit();
    this.connect();
  }

  /** Resume a stored WizardConnect session after reload or mobile app switching. */
  tryResume(): boolean {
    if (this.state !== 'idle' && this.state !== 'disconnected') return false;
    const now = Date.now();
    if (now - this.lastResumeAttemptAt < 5000) return false;
    try {
      const s = loadSession();
      if (s?.walletPublicKey) {
        this.lastResumeAttemptAt = now;
        this.walletName = s.walletName ?? null;
        this.connect({ privateKey: s.privateKey, secret: s.secret, walletPublicKey: s.walletPublicKey });
        return true;
      }
      return false;
    } catch (e) {
      this.lastResumeAttemptAt = now;
      this.error = e instanceof Error ? e.message : 'Could not restore the saved wallet session';
      this.state = 'idle';
      this.emit();
      return false;
    }
  }

  /**
   * Explicitly retry a saved session after the user sees a stalled-session
   * warning. Unlike automatic focus recovery, a manual retry may replace a
   * currently reconnecting manager and bypasses the lifecycle-event throttle.
   * The encrypted saved credentials are deliberately preserved.
   */
  retrySavedSession(): boolean {
    if (this.state === 'connected' || this.state === 'disconnecting') return false;
    let saved: ReturnType<typeof loadSession> | null = null;
    try {
      saved = loadSession();
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : 'Could not read the saved wallet session';
      this.emit();
      return false;
    }
    if (!saved?.walletPublicKey) return false;

    const mgr = this.mgr;
    const relay = this.relay;
    this.generation++;
    this.mgr = null;
    this.relay = null;
    this.clearConnectionWatchdog();
    // Stop the stale relay/manager, but do not delete the encrypted session.
    this.cleanup(mgr, relay, false);
    this.uri = null;
    this.qrUri = null;
    this.walletName = saved.walletName ?? this.walletName;
    this.error = null;
    this.state = 'idle';
    this.lastResumeAttemptAt = 0;
    this.emit();
    return this.tryResume();
  }

  async disconnect() {
    if (this.state === 'disconnecting') return;
    const mgr = this.mgr;
    const relay = this.relay;
    this.clearConnectionWatchdog();
    // Invalidate all manager/relay callbacks before awaiting the remote disconnect.
    this.generation++;
    this.mgr = null;
    this.relay = null;
    this.state = 'disconnecting';
    this.emit();
    try {
      await mgr?.sendDisconnect();
    } catch {
      // Local cleanup still completes if the wallet is offline or the relay has expired.
    } finally {
      this.cleanup(mgr, relay);
      this.uri = null;
      this.qrUri = null;
      this.walletName = null;
      this.receiveIndex = 0;
      try {
        localStorage.removeItem(PATHS_STORAGE_KEY);
        localStorage.removeItem(RECEIVE_INDEX_STORAGE_KEY);
      } catch { /* best effort */ }
      this.error = null;
      this.state = 'idle';
      this.emit();
    }
  }

  /** Derive the active Selene receive address from its live WizardConnect xpub. */
  address(network: Net): string | null {
    if (this.state !== "connected" || !this.mgr) return null;
    return deriveWizardConnectReceiveAddress(
      this.mgr.protocol,
      (childIndex, index) => this.mgr?.getPubkey(childIndex, index),
      network,
      this.receiveIndex,
    );
  }

  /** Match a Selene receive address against the live WizardConnect receive xpub. */
  matchReceiveAddress(address: string, network: Net, maxIndex = DEFAULT_RECEIVE_ADDRESS_SEARCH_LIMIT): number | null {
    if (this.state !== "connected" || !this.mgr || this.mgr.protocol !== "hdwalletv1") {
      throw new Error("Connect Selene through WizardConnect before matching a receive address.");
    }
    const mgr = this.mgr;
    const i = findWizardConnectReceiveIndex(
      address,
      mgr.protocol,
      (childIndex, index) => mgr.getPubkey(childIndex, index),
      network,
      maxIndex,
    );
    if (i === null) return null;
    this.receiveIndex = i;
    try { localStorage.setItem(RECEIVE_INDEX_STORAGE_KEY, String(i)); } catch { /* best effort */ }
    this.emit();
    return i;
  }

  /** Ask the connected wallet to sign, then verify intent without broadcasting. */
  /** Public receive and change addresses of the connected wallet, for coin discovery. */
  listWalletAddresses(network: Net, receiveLimit = DEFAULT_RECEIVE_ADDRESS_SEARCH_LIMIT, changeLimit = 20): WalletAddressEntry[] {
    if (this.state !== 'connected' || !this.mgr || this.mgr.protocol !== 'hdwalletv1') {
      throw new Error('Connect Selene through WizardConnect before scanning wallet addresses.');
    }
    const mgr = this.mgr;
    const entries: WalletAddressEntry[] = [];
    const receiveIndexes = wizardConnectReceiveAddressIndexes(receiveLimit, this.receiveIndex);
    const limits: [WalletPathBranch, number[]][] = [
      ['receive', receiveIndexes],
      ['change', Array.from({ length: changeLimit + 1 }, (_, index) => index)],
    ];
    for (const [branch, indexes] of limits) {
      for (const index of indexes) {
        const address = deriveWizardConnectAddress(mgr.protocol, (childIndex, i) => mgr.getPubkey(childIndex, i), network, branch, index);
        if (address) entries.push({ branch, index, address });
      }
    }
    return entries;
  }

  async signAndVerify(wcObject: any, walletInputs: number[], prompt: string, inputPaths?: ReadonlyMap<number, WalletInputPath>) {
    if (!this.mgr || this.state !== 'connected') throw new Error('Connect a wallet first');
    const mgr = this.mgr;
    const generation = this.generation;
    const request = buildWizardSignRequest(wcObject, walletInputs, inputPaths ?? this.receiveIndex, prompt, mgr.nextSequence());
    const res = await mgr.sendSignRequest(request as Parameters<typeof mgr.sendSignRequest>[0]);
    if (!this.isCurrent(mgr, generation) || this.state !== 'connected') {
      throw new Error('Wallet connection changed before signing completed. Please reconnect and try again.');
    }
    if (res.error) throw new Error(res.error);
    const signedTransaction = res.signedTransaction;
    if (typeof signedTransaction !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(signedTransaction)) {
      throw new Error('Selene did not return a valid signed transaction. The transaction was not broadcast.');
    }
    const decoded = verifySignedTransaction(signedTransaction, wcObject?.transaction, wcObject?.sourceOutputs, walletInputs);
    return { signedTransaction, decoded };
  }
}

export const wallet = new WizardWallet();

// Mobile browsers may suspend the relay while Selene is foregrounded. Resume only
// when the page returns, and throttle duplicate focus/visibility events.
if (typeof window !== 'undefined') {
  const resume = () => {
    if (document.visibilityState === 'visible') wallet.tryResume();
  };
  window.addEventListener('focus', resume);
  window.addEventListener('online', resume);
  window.addEventListener('pageshow', resume);
  document.addEventListener('visibilitychange', resume);
}