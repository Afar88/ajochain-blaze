/**
 * Circles found by wallet discovery whose setup transaction is still waiting
 * for its first block. Stored by circle ID (state category) so My circles can
 * say "Waiting for first confirmation" until a later scan sees it mined.
 */
export const UNCONFIRMED_DISCOVERED_CIRCLES_KEY = "ajochain-blaze:unconfirmed-discovered-circles:v1";

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

export function readUnconfirmedCircleCategories(storage: Pick<Storage, "getItem">): Set<string> {
  try {
    const raw: unknown = JSON.parse(storage.getItem(UNCONFIRMED_DISCOVERED_CIRCLES_KEY) || "[]");
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((item): item is string => typeof item === "string" && /^[0-9a-f]{64}$/i.test(item))
      .map((item) => item.toLowerCase()));
  } catch {
    return new Set();
  }
}

/** Add circles still in the mempool; drop ones a scan now reports as mined. */
export function recordDiscoveredCircleConfirmations(
  storage: KeyValueStorage,
  found: readonly { stateCategory: string; confirmed: boolean }[],
): Set<string> {
  const next = readUnconfirmedCircleCategories(storage);
  for (const circle of found) {
    const category = circle.stateCategory.toLowerCase();
    if (circle.confirmed) next.delete(category);
    else next.add(category);
  }
  try { storage.setItem(UNCONFIRMED_DISCOVERED_CIRCLES_KEY, JSON.stringify([...next])); } catch { /* storage unavailable */ }
  return next;
}
