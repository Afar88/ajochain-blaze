import { decodeV2FeeCircle, readV2FeeCircle } from "./v2-fee-bch";
import { dedupeSavedV2FeeCircleRecords } from "./v2-fee-circle-records";

export type DiscoveredCircleRecord = {
  encoded: string;
  savedAt: number;
};

async function postCircleRegistry(body: Record<string, unknown>) {
  const response = await fetch("/api/circles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({})) as {
    error?: string;
    circles?: unknown[];
    circle?: unknown;
  };
  if (!response.ok) {
    throw new Error(result.error || "AjoChain Blaze circle discovery is unavailable.");
  }
  return result;
}

/** Register only after Selene-approved genesis has been accepted by Chipnet. */
export async function registerCircleForDiscovery(encoded: string, genesisTxid: string): Promise<void> {
  if (typeof encoded !== "string" || encoded.length > 20_000 ||
      !/^[0-9a-f]{64}$/i.test(genesisTxid)) {
    throw new Error("Circle discovery registration contains an invalid invite or genesis transaction ID.");
  }
  await postCircleRegistry({ action: "register", encoded, genesisTxid: genesisTxid.toLowerCase() });
}

/**
 * Fetch candidate invites for the connected wallet's public receive branch.
 * The registry is never treated as financial state: each candidate is decoded,
 * checked against the requested wallet addresses, then independently read from
 * Chipnet before it can be persisted in the local menu.
 */
export async function discoverVerifiedCircles(addresses: readonly string[]): Promise<DiscoveredCircleRecord[]> {
  const walletAddresses = [...new Set(addresses.map((address) => address.trim().toLowerCase()).filter(Boolean))];
  if (walletAddresses.length === 0) return [];
  const result = await postCircleRegistry({ action: "discover", addresses: walletAddresses });
  if (!Array.isArray(result.circles)) return [];

  const verified: DiscoveredCircleRecord[] = [];
  for (const candidate of result.circles.slice(0, 50)) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as Record<string, unknown>;
    if (typeof row.encoded !== "string" || row.encoded.length > 20_000) continue;
    try {
      const params = decodeV2FeeCircle(row.encoded);
      if (params.network !== "chipnet" ||
          (typeof row.stateCategory === "string" && row.stateCategory.toLowerCase() !== params.stateCategory.toLowerCase()) ||
          (typeof row.network === "string" && row.network !== params.network) ||
          !params.members.some((member) => walletAddresses.includes(member.toLowerCase()))) {
        continue;
      }
      await readV2FeeCircle(params);
      const created = typeof row.createdAt === "string" ? Date.parse(row.createdAt) : Number(row.savedAt);
      verified.push({
        encoded: row.encoded,
        savedAt: Number.isFinite(created) && created > 0 ? created : Date.now(),
      });
    } catch {
      // Ignore malformed, stale, or non-existent on-chain candidates.
    }
  }
  return dedupeSavedV2FeeCircleRecords(verified);
}
