// Front-end helpers for loading wallet balances quickly and reliably.
// They only orchestrate existing read-only lookups; nothing here signs or spends.

export type ScanAddressChoice = {
  address: string;
  confirmedSatoshis: string;
  unconfirmedSatoshis: string;
  hasHistory: boolean;
  hasPendingHistory: boolean;
};

/**
 * Addresses worth asking for PUSD: any address that ever held coins (a token
 * output always carries BCH dust, so an address with no history holds no
 * PUSD), plus the selected and Selene-current addresses.
 */
export function selectPusdScanAddresses(
  choices: readonly ScanAddressChoice[],
  alwaysInclude: readonly (string | null | undefined)[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (address: string | null | undefined) => {
    if (!address) return;
    const key = address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(address);
  };
  for (const address of alwaysInclude) add(address);
  for (const choice of choices) {
    let total = 0n;
    try { total = BigInt(choice.confirmedSatoshis) + BigInt(choice.unconfirmedSatoshis); } catch { total = 0n; }
    if (choice.hasHistory || choice.hasPendingHistory || total > 0n) add(choice.address);
  }
  return out;
}

/** Run lookups with a concurrency cap, keeping every success even if others fail. */
export async function settleWithConcurrency<T>(
  items: readonly string[],
  limit: number,
  run: (item: string) => Promise<T>,
): Promise<Array<{ item: string; ok: true; value: T } | { item: string; ok: false; error: unknown }>> {
  const results: Array<{ item: string; ok: true; value: T } | { item: string; ok: false; error: unknown }> =
    new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      try {
        results[index] = { item, ok: true, value: await run(item) };
      } catch (error) {
        results[index] = { item, ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export type PusdBalanceLike = {
  utxos: readonly { txid: string; vout: number; token?: { amount: bigint } | null }[];
};

/** Sum PUSD from the lookups that succeeded, once per coin, and list the addresses that failed. */
export function sumSettledPusd(
  results: ReadonlyArray<{ item: string; ok: true; value: PusdBalanceLike } | { item: string; ok: false; error: unknown }>,
): { total: bigint; byAddress: Record<string, string>; failed: string[]; succeeded: number } {
  const unique = new Map<string, bigint>();
  const byAddress: Record<string, string> = {};
  const failed: string[] = [];
  let succeeded = 0;
  for (const result of results) {
    if (!result.ok) { failed.push(result.item); continue; }
    succeeded++;
    let addressTotal = 0n;
    for (const utxo of result.value.utxos) {
      const amount = utxo.token?.amount ?? 0n;
      addressTotal += amount;
      unique.set(utxo.txid.toLowerCase() + ":" + utxo.vout, amount);
    }
    byAddress[result.item.toLowerCase()] = addressTotal.toString();
  }
  const total = [...unique.values()].reduce((sum, amount) => sum + amount, 0n);
  return { total, byAddress, failed, succeeded };
}

/**
 * Two-step scan: BCH first, then PUSD. onBchDone fires as soon as BCH is
 * known, so the wallet stops showing "Updating…" without waiting for PUSD.
 */
export async function runTwoStepWalletScan<B, P>(steps: {
  scanBch: () => Promise<B>;
  onBchDone: (bch: B) => void;
  scanPusd: (bch: B) => Promise<P>;
  onPusdDone: (pusd: P) => void;
  onPusdError: (cause: unknown) => void;
}): Promise<void> {
  const bch = await steps.scanBch();
  steps.onBchDone(bch);
  try {
    steps.onPusdDone(await steps.scanPusd(bch));
  } catch (cause) {
    steps.onPusdError(cause);
  }
}

/**
 * Never cancels a running scan. A request that arrives while one runs is
 * remembered, and exactly one more scan starts when the current one ends.
 */
export function createWalletScanScheduler() {
  let running = false;
  let queued = false;
  let runner: (() => Promise<void>) | null = null;
  const start = () => {
    if (!runner) return;
    running = true;
    const current = runner;
    void current().finally(() => {
      running = false;
      if (queued) {
        queued = false;
        start();
      }
    });
  };
  return {
    get running() { return running; },
    get queued() { return queued; },
    /** Ask for a scan. Returns true when a scan started now, false when it was queued. */
    request(run: () => Promise<void>): boolean {
      runner = run;
      if (running) { queued = true; return false; }
      start();
      return true;
    },
  };
}

export type WalletBalanceCache<C> = {
  savedAt: number;
  choices: C[];
  pusdTotal: string | null;
  pusdByAddress: Record<string, string>;
};

const BALANCE_CACHE_PREFIX = "ajochain:wallet-balance-cache:v1:";

export function walletBalanceCacheKey(network: string, firstReceiveAddress: string): string {
  return BALANCE_CACHE_PREFIX + network + ":" + firstReceiveAddress.toLowerCase();
}

export function readWalletBalanceCache<C>(storage: Pick<Storage, "getItem">, key: string): WalletBalanceCache<C> | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WalletBalanceCache<C>;
    if (!parsed || typeof parsed.savedAt !== "number" || !Array.isArray(parsed.choices)) return null;
    if (parsed.pusdTotal !== null && !/^\d+$/.test(String(parsed.pusdTotal))) return null;
    return { ...parsed, pusdByAddress: parsed.pusdByAddress ?? {} };
  } catch {
    return null;
  }
}

export function writeWalletBalanceCache<C>(storage: Pick<Storage, "setItem">, key: string, value: WalletBalanceCache<C>): void {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* storage full or unavailable */ }
}
