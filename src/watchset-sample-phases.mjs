const rejectFrom = (error) => Object.freeze({
  type: "Reject",
  code: "capture-exception",
  detail: error instanceof Error ? error.message : String(error),
  venueWrite: false,
});

async function runBounded(items, concurrency, run) {
  if (!Array.isArray(items)) throw new TypeError("sample-phase-items-required");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new TypeError("valid-sample-phase-concurrency-required");
  }
  if (typeof run !== "function") throw new TypeError("sample-phase-runner-required");

  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      try {
        results[index] = Object.freeze({
          item,
          result: await run(item, index),
        });
      } catch (error) {
        results[index] = Object.freeze({
          item,
          result: rejectFrom(error),
        });
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(1, items.length)) },
      () => worker(),
    ),
  );
  return Object.freeze(results);
}

export async function captureWatchsetMilestoneFirst({
  milestoneIds = [],
  marketTickers = [],
  concurrency = 2,
  captureMilestone,
  captureMarket,
  clock = () => new Date(),
} = {}) {
  if (!Array.isArray(milestoneIds) || !Array.isArray(marketTickers)) {
    throw new TypeError("watchset-sample-target-arrays-required");
  }
  if (typeof captureMilestone !== "function" || typeof captureMarket !== "function") {
    throw new TypeError("watchset-sample-capture-functions-required");
  }
  if (typeof clock !== "function") throw new TypeError("watchset-sample-clock-required");

  const startedAt = clock().toISOString();
  const milestoneResults = await runBounded(
    milestoneIds,
    concurrency,
    (milestoneId) => captureMilestone(milestoneId),
  );
  const milestonePhaseCompletedAt = clock().toISOString();

  // Deliberate barrier: no market request starts until all milestone/PBP
  // requests have completed. This makes a fresh event observed in this cycle
  // precede every market quote acquired in the same cycle.
  const marketPhaseStartedAt = clock().toISOString();
  const marketResults = await runBounded(
    marketTickers,
    concurrency,
    (ticker) => captureMarket(ticker),
  );
  const completedAt = clock().toISOString();

  return Object.freeze({
    type: "MilestoneFirstWatchsetSample",
    startedAt,
    milestonePhaseCompletedAt,
    marketPhaseStartedAt,
    completedAt,
    milestoneResults,
    marketResults,
  });
}
