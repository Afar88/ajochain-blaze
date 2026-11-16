import {
  decodeClassicCircle,
  encodeClassicCircle,
  type ClassicCircleParams,
} from "./classic-bch";

export const CLASSIC_CIRCLE_STORAGE_KEY = "ajochain-blaze:classic-circles:v1";

export interface SavedClassicCircle {
  encoded: string;
  savedAt: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadSavedClassicCircles(storage: StorageLike): SavedClassicCircle[] {
  try {
    const raw = storage.getItem(CLASSIC_CIRCLE_STORAGE_KEY);
    if (!raw) return [];
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    const valid: SavedClassicCircle[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.encoded !== "string" ||
          !Number.isSafeInteger(candidate.savedAt)) continue;
      try {
        decodeClassicCircle(candidate.encoded);
        valid.push({ encoded: candidate.encoded, savedAt: candidate.savedAt as number });
      } catch {
        // Ignore corrupted or outdated local records; never treat them as chain state.
      }
    }
    return valid.slice(0, 100);
  } catch {
    return [];
  }
}

/** Browser-local account index: the blockchain remains the source of fund state. */
export function saveClassicCircle(
  storage: StorageLike,
  params: ClassicCircleParams,
  now = Date.now(),
): SavedClassicCircle[] {
  const encoded = encodeClassicCircle(params);
  const current = loadSavedClassicCircles(storage);
  const next = [
    { encoded, savedAt: now },
    ...current.filter((entry) => entry.encoded !== encoded),
  ].slice(0, 100);
  storage.setItem(CLASSIC_CIRCLE_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function restoreClassicCircleFromInvite(input: string): ClassicCircleParams {
  const value = input.trim();
  if (!value) throw new Error("Paste a circle invite link first.");
  let hash = value;
  try {
    const url = new URL(value);
    hash = url.hash || value;
  } catch {
    // A hash route or encoded fragment is accepted directly.
  }
  const match = hash.match(/#\/classic\/([A-Za-z0-9_-]+)$/) ??
    hash.match(/^\/?classic\/([A-Za-z0-9_-]+)$/);
  if (!match) throw new Error("This is not a recognised AjoChain Blaze Classic circle link.");
  return decodeClassicCircle(match[1]);
}

export function buildClassicInviteRoute(params: ClassicCircleParams): string {
  return "#/classic/" + encodeClassicCircle(params);
}
