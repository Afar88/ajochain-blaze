export type SavedCircleNetwork = "mainnet" | "chipnet";
export type SavedCircleStatus = "active" | "completed" | "cancelled" | "unknown";

export type SavedCircleDescriptor = {
  id: string;
  encoded: string;
  network: SavedCircleNetwork;
  kind: string;
  name: string;
  asset: "BCH" | "PUSD";
  contribution: string;
  memberCount: number;
};

export type SavedCircleMetadata = SavedCircleDescriptor & {
  status: SavedCircleStatus;
  completedAt: number | null;
  round: number | null;
  checkedAt: number | null;
};

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

export const SAVED_CIRCLE_METADATA_KEY = "ajochain-blaze:saved-circle-metadata:v1";

function isMetadata(value: unknown): value is SavedCircleMetadata {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" &&
    typeof item.encoded === "string" &&
    (item.network === "mainnet" || item.network === "chipnet") &&
    typeof item.kind === "string" &&
    typeof item.name === "string" &&
    (item.asset === "BCH" || item.asset === "PUSD") &&
    typeof item.contribution === "string" &&
    Number.isInteger(item.memberCount) &&
    (item.status === "active" || item.status === "completed" ||
      item.status === "cancelled" || item.status === "unknown");
}

export function readSavedCircleMetadata(storage: KeyValueStorage): SavedCircleMetadata[] {
  try {
    const raw: unknown = JSON.parse(storage.getItem(SAVED_CIRCLE_METADATA_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(isMetadata).map((item) => ({
      ...item,
      completedAt: Number.isSafeInteger(item.completedAt) ? item.completedAt : null,
      round: Number.isInteger(item.round) && Number(item.round) >= 0 ? Number(item.round) : null,
      checkedAt: Number.isSafeInteger(item.checkedAt) ? item.checkedAt : null,
    }));
  } catch {
    return [];
  }
}

/**
 * Add status metadata without rewriting any legacy saved-circle storage entry.
 * The original encoded invite is copied byte-for-byte into this additive index.
 * A new record begins Unknown until the read-only chain check completes.
 */
export function ensureSavedCircleMetadata(
  storage: KeyValueStorage,
  circles: SavedCircleDescriptor[],
): SavedCircleMetadata[] {
  const existing = readSavedCircleMetadata(storage);
  const byId = new Map(existing.map((record) => [record.id, record]));
  const next = circles.map((circle): SavedCircleMetadata => {
    const previous = byId.get(circle.id);
    return previous
      ? { ...previous, ...circle }
      : {
          ...circle,
          status: "unknown",
          completedAt: null,
          round: null,
          checkedAt: null,
        };
  });
  const present = new Set(next.map((record) => record.id));
  const preserved = existing.filter((record) => !present.has(record.id));
  const merged = [...next, ...preserved];
  if (JSON.stringify(merged) !== JSON.stringify(existing)) {
    try { storage.setItem(SAVED_CIRCLE_METADATA_KEY, JSON.stringify(merged)); } catch { /* local storage may be unavailable */ }
  }
  return next;
}

/** Persist a status derived from a fresh on-chain read; never invent a close time. */
export function updateSavedCircleChainStatus(
  storage: KeyValueStorage,
  circle: SavedCircleDescriptor,
  status: SavedCircleStatus,
  round: number | null,
  completedAt: number | null,
  checkedAt = Date.now(),
): SavedCircleMetadata {
  const records = readSavedCircleMetadata(storage);
  const previous = records.find((record) => record.id === circle.id);
  const closed = status === "completed" || status === "cancelled";
  const record: SavedCircleMetadata = {
    ...previous,
    ...circle,
    status,
    // A fresh chain read replaces legacy dates: when block time is unavailable,
    // do not preserve a browser-generated timestamp from older metadata.
    completedAt: closed && Number.isSafeInteger(completedAt) ? completedAt : null,
    round: Number.isInteger(round) && round !== null && round >= 0 ? round : null,
    checkedAt: Number.isSafeInteger(checkedAt) ? checkedAt : Date.now(),
  };
  const next = [...records.filter((entry) => entry.id !== circle.id), record];
  storage.setItem(SAVED_CIRCLE_METADATA_KEY, JSON.stringify(next));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("ajochain:saved-circles-changed"));
  }
  return record;
}

/**
 * Backwards-compatible helper for existing per-circle workspaces. A fresh
 * completed read keeps an already-known chain close time instead of replacing
 * it with the current browser time.
 */
export function updateSavedCircleProgress(
  storage: KeyValueStorage,
  circle: SavedCircleDescriptor,
  round: number | null,
  completed: boolean,
  now?: number,
): SavedCircleMetadata {
  const checkedAt = now ?? Date.now();
  const records = readSavedCircleMetadata(storage);
  const previous = records.find((record) => record.id === circle.id);
  const record: SavedCircleMetadata = {
    ...previous,
    ...circle,
    status: completed ? previous?.status === "cancelled" ? "cancelled" : "completed" : "active",
    completedAt: completed
      ? previous?.status === "cancelled" ? previous.completedAt
        : previous?.status === "completed" ? previous.completedAt : now ?? null
      : null,
    round: Number.isInteger(round) && round !== null && round >= 0 ? round : null,
    checkedAt,
  };
  const next = [...records.filter((entry) => entry.id !== circle.id), record];
  storage.setItem(SAVED_CIRCLE_METADATA_KEY, JSON.stringify(next));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("ajochain:saved-circles-changed"));
  }
  return record;
}

export function filterSavedCirclesByNetwork<T extends { network: SavedCircleNetwork }>(
  circles: T[],
  network: SavedCircleNetwork,
): T[] {
  return circles.filter((circle) => circle.network === network);
}

export function filterSavedCirclesByStatus<T extends { status: SavedCircleStatus }>(
  circles: T[],
  status: "active" | "completed",
): T[] {
  return circles.filter((circle) => status === "active"
    ? circle.status === "active" || circle.status === "unknown"
    : circle.status === "completed" || circle.status === "cancelled");
}
