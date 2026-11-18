export type SavedV2FeeCircleRecord = { encoded: string; savedAt: number };

export type V2FeeCircleRecordIdentity = {
  key: string;
  name: string;
  network: "mainnet" | "chipnet";
  stateCategory: string;
};

/**
 * A circle's label is not its identity. CashScript contract identity is based
 * on the network, covenant artifact and constructor arguments. This matches
 * equivalent saved/invite records even when the label or base64 encoding differs.
 */
export function getV2FeeCircleRecordIdentity(encoded: string): V2FeeCircleRecordIdentity | null {
  try {
    if (typeof encoded !== "string" || encoded.length < 8 || encoded.length > 20_000) return null;
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (value.version !== 2 ||
        typeof value.covenant !== "string" ||
        typeof value.name !== "string" || !value.name.trim() ||
        (value.network !== "chipnet" && value.network !== "mainnet") ||
        !Array.isArray(value.members) || value.members.length < 2 ||
        !value.members.every((member) => typeof member === "string" && member.length > 0) ||
        typeof value.contribution !== "string" || !/^[0-9]+$/.test(value.contribution) ||
        typeof value.maxFee !== "string" || !/^[0-9]+$/.test(value.maxFee) ||
        typeof value.stateCategory !== "string" || !/^[0-9a-f]{64}$/i.test(value.stateCategory) ||
        typeof value.initiator !== "string" || typeof value.treasury !== "string") return null;

    const stateCategory = value.stateCategory.toLowerCase();
    const key = JSON.stringify({
      network: value.network,
      covenant: value.covenant,
      members: value.members.map((member) => member.toLowerCase()),
      contribution: value.contribution,
      maxFee: value.maxFee,
      stateCategory,
      initiator: value.initiator.toLowerCase(),
      treasury: value.treasury.toLowerCase(),
    });
    return {
      key,
      name: value.name.trim(),
      network: value.network,
      stateCategory,
    };
  } catch {
    return null;
  }
}

/** Keep the newest saved copy of each on-chain circle, not one per local invite string. */
export function dedupeSavedV2FeeCircleRecords(records: unknown): SavedV2FeeCircleRecord[] {
  if (!Array.isArray(records)) return [];
  const candidates: SavedV2FeeCircleRecord[] = records
    .filter((entry): entry is SavedV2FeeCircleRecord =>
      Boolean(entry && typeof entry === "object" &&
        typeof (entry as SavedV2FeeCircleRecord).encoded === "string" &&
        Number.isSafeInteger((entry as SavedV2FeeCircleRecord).savedAt)),
    )
    .sort((a, b) => b.savedAt - a.savedAt);
  const seen = new Set<string>();
  const unique: SavedV2FeeCircleRecord[] = [];
  for (const entry of candidates) {
    const identity = getV2FeeCircleRecordIdentity(entry.encoded);
    if (!identity || seen.has(identity.key)) continue;
    seen.add(identity.key);
    unique.push(entry);
  }
  return unique.slice(0, 100);
}
