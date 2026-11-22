/**
 * Circle names are kept off-chain by design: the genesis discovery note stores only
 * covenant, member count, contribution, max fee, initiator and treasury. A circle found
 * by "Find my circles" on a phone that never saw its invite therefore gets a stand-in
 * name ("Found circle <first 8 of token category>") from discovery.
 *
 * These helpers keep the real name whenever any saved copy on this phone has it, and
 * show a friendlier stand-in ("Circle a9a3bca6") when none does.
 */
const FOUND_CIRCLE_FALLBACK = /^found circle ([0-9a-f]{8})$/i;
const FRIENDLY_FALLBACK = /^circle ([0-9a-f]{8})$/i;

/** True for the stand-in name discovery gives a circle with no saved name. */
export function isFallbackCircleName(name: string | null | undefined): boolean {
  const trimmed = (name ?? "").trim();
  return !trimmed || FOUND_CIRCLE_FALLBACK.test(trimmed) || FRIENDLY_FALLBACK.test(trimmed);
}

/** The name to show: the real name, or "Circle a9a3bca6" for a found circle. */
export function circleDisplayName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  const found = trimmed.match(FOUND_CIRCLE_FALLBACK);
  if (found) return "Circle " + found[1].toLowerCase();
  return trimmed || "Ajo circle";
}

/** Prefer a real, creator-set name over a stand-in name. */
export function preferRealCircleName(current: string, candidate: string | null | undefined): string {
  if (candidate && isFallbackCircleName(current) && !isFallbackCircleName(candidate)) return candidate;
  return current;
}
