/**
 * Run independent network discovery tasks without allowing one network's RPC failure
 * to suppress discovery on the other network.
 */
export async function settleIndependentTasks<A, B>(
  first: () => Promise<A>,
  second: () => Promise<B>,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  const results = await Promise.allSettled([
    Promise.resolve().then(first),
    Promise.resolve().then(second),
  ]);
  return results as [PromiseSettledResult<A>, PromiseSettledResult<B>];
}
