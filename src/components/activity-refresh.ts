/** How many circles the activity page reads from the network at once. */
export const ACTIVITY_READ_CONCURRENCY = 4;
/** Wait this long after the last "circles changed" event before re-reading. */
export const ACTIVITY_REFRESH_DEBOUNCE_MS = 500;

/**
 * Map items with an async reader, running at most `limit` reads at a time.
 * Results keep the input order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  read: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await read(items[index], index);
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
