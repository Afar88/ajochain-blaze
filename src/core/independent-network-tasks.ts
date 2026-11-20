/**
 * Run independent network discovery tasks without allowing one network's RPC failure
 * to suppress discovery on the other network. Optional callbacks run as soon as
 * their corresponding task settles, without waiting for the other network.
 */
export async function settleIndependentTasks<A, B>(
  first: () => Promise<A>,
  second: () => Promise<B>,
  onFirstSettled?: (result: PromiseSettledResult<A>) => void,
  onSecondSettled?: (result: PromiseSettledResult<B>) => void,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  const run = <T>(task: () => Promise<T>, onSettled?: (result: PromiseSettledResult<T>) => void) =>
    Promise.resolve().then(task).then(
      (value): T => {
        onSettled?.({ status: "fulfilled", value });
        return value;
      },
      (reason): never => {
        onSettled?.({ status: "rejected", reason });
        throw reason;
      },
    );
  const results = await Promise.allSettled([
    run(first, onFirstSettled),
    run(second, onSecondSettled),
  ]);
  return results as [PromiseSettledResult<A>, PromiseSettledResult<B>];
}
