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
export async function registerCircleForDiscovery(encoded: string, genesisTxid?: string): Promise<void> {
  if (typeof encoded !== "string" || encoded.length > 20_000 ||
      (genesisTxid !== undefined && !/^[0-9a-f]{64}$/i.test(genesisTxid))) {
    throw new Error("Circle discovery registration contains an invalid invite or genesis transaction ID.");
  }
  await postCircleRegistry({
    action: "register",
    encoded,
    ...(genesisTxid ? { genesisTxid: genesisTxid.toLowerCase() } : {}),
  });
}

const backfilledLocalCircles = new Set<string>();

/**
 * Backfill circles saved before the dedicated registry was configured.
 * Only a connected wallet whose receive branch matches a member can submit
 * the invite, and each circle is independently re-read from Chipnet first.
 * This is a discovery repair path, not a source of financial state.
 */
export async function registerSavedCirclesForDiscovery(
  addresses: readonly string[],
  encodedInvites: readonly string[],
): Promise<void> {
  const walletAddresses = new Set(
    addresses.map((address) => address.trim().toLowerCase()).filter(Boolean),
  );
  const candidates = [...new Set(encodedInvites)].filter((encoded) =>
    typeof encoded === "string" && encoded.length <= 20_000 &&
    !backfilledLocalCircles.has(encoded),
  );
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const encoded = candidates[next++];
      try {
        const params = decodeV2FeeCircle(encoded);
        if (params.network !== "chipnet" ||
            !params.members.some((member) => walletAddresses.has(member.toLowerCase()))) {
          continue;
        }
        await readV2FeeCircle(params);
        await registerCircleForDiscovery(encoded);
        backfilledLocalCircles.add(encoded);
      } catch {
        // Keep failures eligible for a later retry after the chain/database recovers.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, () => worker()));
}

/**
 * Fetch candidate invites for the connected wallet's public receive branch.
 * The registry is never treated as financial state: each candidate is decoded,
 * checked against the requested wallet addresses, then independently read from
 * Chipnet before it can be persisted in the local menu.
 */
export async function discoverVerifiedCircles(
  addresses: readonly string[],
  alreadySaved: readonly string[] = [],
): Promise<DiscoveredCircleRecord[]> {
  const walletAddresses = [...new Set(addresses.map((address) => address.trim().toLowerCase()).filter(Boolean))];
  if (walletAddresses.length === 0) return [];
  const result = await postCircleRegistry({ action: "discover", addresses: walletAddresses });
  if (!Array.isArray(result.circles)) return [];

  const known = new Set(alreadySaved);
  const candidates: Array<{ encoded: string; savedAt: number }> = [];
  for (const candidate of result.circles.slice(0, 100)) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as Record<string, unknown>;
    if (typeof row.encoded !== "string" || row.encoded.length > 20_000 || known.has(row.encoded)) continue;
    try {
      const params = decodeV2FeeCircle(row.encoded);
      if (params.network !== "chipnet" ||
          (typeof row.stateCategory === "string" && row.stateCategory.toLowerCase() !== params.stateCategory.toLowerCase()) ||
          (typeof row.network === "string" && row.network !== params.network) ||
          !params.members.some((member) => walletAddresses.includes(member.toLowerCase()))) {
        continue;
      }
      const created = typeof row.createdAt === "string" ? Date.parse(row.createdAt) : Number(row.savedAt);
      candidates.push({
        encoded: row.encoded,
        savedAt: Number.isFinite(created) && created > 0 ? created : Date.now(),
      });
    } catch {
      // Ignore malformed or non-member candidates before spending a chain read.
    }
  }

  // Do not serially wait on dozens of independent chain reads. A small worker
  // pool keeps first-load discovery responsive without flooding Chipnet nodes.
  const verified: DiscoveredCircleRecord[] = [];
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const index = next++;
      const candidate = candidates[index];
      try {
        const params = decodeV2FeeCircle(candidate.encoded);
        await readV2FeeCircle(params);
        verified.push(candidate);
      } catch {
        // Ignore stale or non-existent on-chain candidates.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, () => worker()));
  return dedupeSavedV2FeeCircleRecords(verified);
}
