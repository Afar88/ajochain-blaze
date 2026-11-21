/**
 * The last circle details read from the chain in this page session, by circle.
 * Reopening a circle shows these right away while a fresh read runs in the
 * background, instead of an empty "Checking…" screen. Nothing is persisted.
 */
const LIMIT = 30;
const snapshots = new Map<string, unknown>();

export function rememberSnapshot<T>(key: string | null | undefined, value: T): void {
  if (!key) return;
  snapshots.delete(key);
  snapshots.set(key, value);
  while (snapshots.size > LIMIT) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

export function recallSnapshot<T>(key: string | null | undefined): T | null {
  if (!key || !snapshots.has(key)) return null;
  return snapshots.get(key) as T;
}

export function forgetRememberedSnapshots(): void {
  snapshots.clear();
}
