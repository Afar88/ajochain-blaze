// WizardConnect wallet integration (dapp side).
// Pairing is handled by WizardConnect. The wallet supplies xpubs; AjoChain
// derives receive addresses locally and asks the wallet to sign transactions.
import { initiateDappRelay, RelayMsgAction, type DappRelayResult } from '@wizardconnect/core';
import { DappConnectionManager, loadSession } from '@wizardconnect/dapp';
import { binToHex, createVirtualMachineBch2026, decodeTransactionBCH, encodeTransactionOutputs, hash160, hexToBin } from '@bitauth/libauth';
import { sourceOutputToRelay } from '@wizardconnect/core/hdwalletv1-serialize';
import { pkhToAddress, type Net } from './bch-address';

export type WalletState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnecting' | 'disconnected';

type Listener = () => void;

/** Preserve the wallet manager's actual disconnect reason instead of hiding it. */
export function describeWizardWalletDisconnect(reason: unknown, message?: unknown): string {
  const reasonText = reason === null || reason === undefined ? "" : String(reason).trim();
  const messageText = typeof message === "string" ? message.trim() : "";
  const label = reasonText ? " (" + reasonText + ")" : "";
  const detail = messageText ? " " + messageText : "";
  return "Selene closed the WizardConnect session" + label + "." + detail +
    (messageText ? "" : " Choose Retry saved session or Fresh pairing to reconnect.");
}

const PATHS_STORAGE_KEY = 'ajochain:wizardconnect-paths:v1';
const RECEIVE_INDEX_STORAGE_KEY = 'ajochain:wizardconnect-receive-index:v1';
const ADDRESS_STORAGE_KEY = 'ajochain:wizardconnect-addresses:v1';

function loadCachedAddress(network: Net): string | null {
  try {
    const cached = JSON.parse(localStorage.getItem(ADDRESS_STORAGE_KEY) || '{}');
    const address = cached?.[network];
    return typeof address === 'string' && address.length > 10 ? address : null;
  } catch { return null; }
}

function saveCachedAddress(network: Net, address: string) {
  try {
    const cached = JSON.parse(localStorage.getItem(ADDRESS_STORAGE_KEY) || '{}');
    cached[network] = address;
    localStorage.setItem(ADDRESS_STORAGE_KEY, JSON.stringify(cached));
  } catch { /* cached public address is a display fallback only */ }
}

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
  receiveIndex: number,
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
    return [inputIndex, 'receive', receiveIndex] as [number, string, number];
  });
  if (new Set(walletInputs).size !== walletInputs.length) {
    throw new Error('Wallet signing request contains duplicate input indexes.');
  }

  const relaySourceOutputs = transaction.inputs.map((input: unknown, index: number) =>
    sourceOutputToRelay({ ...(input as object), ...sourceOutputs[index] }),
  );

  return {
    action: RelayMsgAction.SignTransactionRequest,
    sequence,
    time: Math.floor(Date.now() / 1000),
    transaction: {
      transaction: {
        inputs: transaction.inputs,
        outputs: transaction.outputs,
        version: transaction.version,
        locktime: transaction.locktime,
      },
      sourceOutputs: relaySourceOutputs,
      broadcast: false,
      userPrompt: prompt,
    },
    inputPaths,
  };
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
    if (opcode <= 75) {
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
 * Recognize a canonical DER ECDSA signature argument including its trailing
 * BCH sighash byte. Cryptographic validity remains the BCH 2026 VM's job.
 */
function isDerTransactionSignature(push: Uint8Array): boolean {
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
  const signatures = argumentsOnly.filter(isDerTransactionSignature);
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
  // A peer-level disconnect (remote disconnect or protocol mismatch) is not a
  // transient socket drop. Do not silently recreate the same closed subscription
  // on every focus event; wait for an explicit user retry or fresh pairing.
  private manualReconnectRequired = false;

  onChange(fn: Listener) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((listener) => listener !== fn); }; }
  private emit() { this.listeners.forEach((f) => f()); }

  private clearConnectionWatchdog() {
    if (this.connectionWatchdog) clearTimeout(this.connectionWatchdog);
    this.connectionWatchdog = null;
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
    if (!existing) this.manualReconnectRequired = false;
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
      this.error = null;
      this.state = 'reconnecting';
      this.emit();
    });
    mgr.on('disconnect', (reason, message) => {
      if (!this.isCurrent(mgr, generation)) return;
      this.clearConnectionWatchdog();
      const relay = this.relay;
      this.generation++;
      this.mgr = null;
      this.relay = null;
      this.uri = null;
      this.qrUri = null;
      this.walletName = null;
      this.receiveIndex = loadReceiveIndex();
      this.state = 'disconnected';
      this.manualReconnectRequired = true;
      this.error = describeWizardWalletDisconnect(reason, message);
      // This manager event means the wallet explicitly disconnected or the
      // protocol handshake failed. Preserve credentials for a user-requested
      // retry, but do not repeatedly resubscribe in background focus handlers.
      this.cleanup(mgr, relay, false);
      this.emit();
    });

    try {
      const relay = initiateDappRelay((payload) => {
        if (this.isCurrent(mgr, generation)) mgr.updateConnection(payload.client, payload.status);
      }, { existingCredentials: existing });
      if (!this.isCurrent(mgr, generation)) {
        this.cleanup(mgr, relay);
        return;
      }
      this.relay = relay;
      if (!existing) { this.uri = relay.uri; this.qrUri = relay.qrUri; }
      mgr.attachRelay(relay);
      this.connectionWatchdog = setTimeout(() => {
        if (!this.isCurrent(mgr, generation) || this.state !== 'connecting') return;
        this.error = existing
          ? 'Your saved Selene session has not responded. Retry the saved session or start a fresh pairing.'
          : 'Still waiting for Selene. Keep AjoChain open, or start a fresh pairing.';
        this.emit();
      }, 20000);
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
    if (this.manualReconnectRequired) return false;
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
    this.manualReconnectRequired = false;
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
    this.manualReconnectRequired = false;
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
        localStorage.removeItem(ADDRESS_STORAGE_KEY);
      } catch { /* best effort */ }
      this.error = null;
      this.state = 'idle';
      this.emit();
    }
  }

  /** WizardConnect receive address at the currently selected BIP32 address index. */
  address(network: Net): string | null {
    const pk = this.mgr?.getPubkey(0, BigInt(this.receiveIndex));
    if (pk) {
      const address = pkhToAddress(hash160(pk), network);
      saveCachedAddress(network, address);
      return address;
    }
    // Keep the last verified public address visible while the mobile relay
    // reconnects. This is display-only and does not imply an active session.
    return loadCachedAddress(network);
  }

  /** Match a Selene receive address against the xpub supplied by WizardConnect. */
  matchReceiveAddress(address: string, network: Net, maxIndex = 50): number | null {
    if (this.state !== 'connected' || !this.mgr) throw new Error('Connect your Selene wallet first');
    const target = address.trim().toLowerCase();
    if (!target) return null;
    for (let i = 0; i <= maxIndex; i++) {
      const pk = this.mgr.getPubkey(0, BigInt(i));
      if (!pk) return null;
      if (pkhToAddress(hash160(pk), network).toLowerCase() === target) {
        this.receiveIndex = i;
        try { localStorage.setItem(RECEIVE_INDEX_STORAGE_KEY, String(i)); } catch { /* best effort */ }
        this.emit();
        return i;
      }
    }
    return null;
  }

  /** Ask the connected wallet to sign, then verify intent without broadcasting. */
  async signAndVerify(wcObject: any, walletInputs: number[], prompt: string) {
    if (!this.mgr || this.state !== 'connected') throw new Error('Connect a wallet first');
    const mgr = this.mgr;
    const generation = this.generation;
    const request = buildWizardSignRequest(wcObject, walletInputs, this.receiveIndex, prompt, mgr.nextSequence());
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