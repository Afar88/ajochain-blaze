export type ChainCircleClosedAs = "completed" | "cancelled";
export type ChainCircleSnapshot = {
  round: number | null;
  completed: boolean;
  closedAs?: ChainCircleClosedAs | null;
  completedAt?: number | null;
};
export type CircleStatusLabel = "active" | "completed" | "cancelled" | "unknown";
export type CircleStatusResult = {
  status: CircleStatusLabel;
  round: number | null;
  completedAt: number | null;
};

export function classifyCircleStatus(snapshot: ChainCircleSnapshot): CircleStatusResult {
  if (snapshot.closedAs === "cancelled") {
    return { status: "cancelled", round: snapshot.round, completedAt: snapshot.completedAt ?? null };
  }
  if (snapshot.closedAs === "completed" || snapshot.completed) {
    return { status: "completed", round: snapshot.round, completedAt: snapshot.completedAt ?? null };
  }
  return { status: "active", round: snapshot.round, completedAt: null };
}

export function unknownCircleStatus(): CircleStatusResult {
  return { status: "unknown", round: null, completedAt: null };
}

export async function checkCircleStatusesWithLimits<T>(
  items: readonly T[],
  readStatus: (item: T) => Promise<ChainCircleSnapshot>,
  options: {
    concurrency?: number;
    requestTimeoutMs?: number;
    overallTimeoutMs?: number;
  } = {},
): Promise<Array<{ item: T; result: CircleStatusResult }>> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 10_000);
  const overallTimeoutMs = Math.max(1, options.overallTimeoutMs ?? 45_000);
  const deadline = Date.now() + overallTimeoutMs;
  const results: Array<{ item: T; result: CircleStatusResult } | undefined> = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      const item = items[index];
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        results[index] = { item, result: unknownCircleStatus() };
        continue;
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let requestTimedOut = false;
      try {
        const snapshot = await Promise.race([
          readStatus(item),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              requestTimedOut = true;
              reject(new Error("Circle status check timed out."));
            }, Math.max(1, Math.min(requestTimeoutMs, remainingMs)));
          }),
        ]);
        results[index] = { item, result: classifyCircleStatus(snapshot) };
      } catch {
        results[index] = { item, result: unknownCircleStatus() };
        // A timed-out provider request may still be pending underneath the
        // timeout race. Stop this worker rather than starting another request
        // and exceeding the true in-flight concurrency bound.
        if (requestTimedOut) return;
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return items.map((item, index) => results[index] ?? { item, result: unknownCircleStatus() });
}

export function countCircleStatuses<T extends { status: CircleStatusLabel }>(circles: readonly T[]) {
  const active = circles.filter((circle) => circle.status === "active" || circle.status === "unknown").length;
  const completed = circles.filter((circle) => circle.status === "completed" || circle.status === "cancelled").length;
  const cancelled = circles.filter((circle) => circle.status === "cancelled").length;
  return { active, completed, cancelled };
}

export function shouldAutoHideDiscoveryMessage(statuses: readonly ("checking" | "success" | "timeout" | "error")[]) {
  return statuses.length > 0 && statuses.every((status) => status === "success");
}
