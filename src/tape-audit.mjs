const finiteTime = (value) => Number.isFinite(Date.parse(value));

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * q;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  const alpha = index - lo;
  return sorted[lo] * (1 - alpha) + sorted[hi] * alpha;
}

export function auditResearchTape(records, {
  expectedIntervalMs = 60_000,
  gapFactor = 2.5,
} = {}) {
  if (!Array.isArray(records)) throw new TypeError("tape-records-array-required");
  if (!Number.isFinite(expectedIntervalMs) || expectedIntervalMs <= 0 ||
      !Number.isFinite(gapFactor) || gapFactor <= 1) {
    throw new TypeError("valid-cadence-policy-required");
  }

  const byType = {};
  const ids = new Set();
  const duplicateIds = [];
  const times = [];
  const streams = new Map();
  let credentialSafe = true;
  let meteredRecordCount = 0, meteredRecordedRequests = 0, meteredResponseBytes = 0;

  for (const record of records) {
    if (!record || record.type !== "KalshiResearchTapeRecord" || !finiteTime(record.capturedAt)) {
      throw new TypeError("valid-kalshi-tape-record-required");
    }
    byType[record.recordType] = (byType[record.recordType] ?? 0) + 1;
    if (ids.has(record.id)) duplicateIds.push(record.id);
    ids.add(record.id);

    const ms = Date.parse(record.capturedAt);
    times.push(ms);

    let streamKey = null;
    if (record.recordType === "market" && record.payload?.ticker) {
      streamKey = "market:" + record.payload.ticker;
    } else if (record.recordType === "market-orderbook-sentry" && record.payload?.ticker) {
      streamKey = "orderbook-sentry:" + record.payload.ticker;
    } else if (record.recordType === "milestone-attention" && record.payload?.milestoneId) {
      streamKey = "milestone:" + record.payload.milestoneId;
    }
    if (streamKey) {
      if (!streams.has(streamKey)) streams.set(streamKey, []);
      streams.get(streamKey).push(ms);
    }

    // Count only source-recorded HTTP work, never an inferred provider bill.
    // Refusals emitted to stderr may incur further calls not represented here.
    if (record.attention !== undefined) {
      const a = record.attention;
      if (!a || !Number.isSafeInteger(a.requestCount) || a.requestCount < 1 ||
          !Number.isSafeInteger(a.payloadBytesEstimate) || a.payloadBytesEstimate < 0)
        throw new TypeError("invalid-recorded-provider-attention");
      meteredRecordCount++;
      meteredRecordedRequests += a.requestCount;
      meteredResponseBytes += a.payloadBytesEstimate;
    }
    const serialized = JSON.stringify(record);
    if (/(private.?key|access.?signature|authorization|api.?key)/i.test(serialized)) {
      credentialSafe = false;
    }
  }

  times.sort((a, b) => a - b);
  const streamReports = [];
  let longGapCount = 0;

  for (const [stream, samples] of streams) {
    samples.sort((a, b) => a - b);
    const intervals = [];
    for (let i = 1; i < samples.length; i += 1) intervals.push(samples[i] - samples[i - 1]);
    const longGaps = intervals.filter((ms) => ms > expectedIntervalMs * gapFactor);
    longGapCount += longGaps.length;

    streamReports.push(Object.freeze({
      stream,
      samples: samples.length,
      firstAt: new Date(samples[0]).toISOString(),
      lastAt: new Date(samples[samples.length - 1]).toISOString(),
      medianIntervalMs: quantile(intervals, 0.5),
      p95IntervalMs: quantile(intervals, 0.95),
      maxIntervalMs: intervals.length ? Math.max(...intervals) : null,
      longGapCount: longGaps.length,
    }));
  }

  streamReports.sort((a, b) => a.stream.localeCompare(b.stream));

  return Object.freeze({
    recordCount: records.length,
    byType: Object.freeze(byType),
    uniqueRecordCount: ids.size,
    duplicateIds: Object.freeze(duplicateIds),
    firstCapturedAt: times.length ? new Date(times[0]).toISOString() : null,
    lastCapturedAt: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    streamCount: streamReports.length,
    longGapCount,
    credentialSafe,
    meteredRecordCount,
    unmeteredRecordCount: records.length - meteredRecordCount,
    meteredRecordedRequests,
    meteredResponseBytesEstimate: meteredResponseBytes,
    // Cash and physical energy remain unknown; successful tape records do not
    // enumerate separate rejected polls or actual supplier billing.
    providerCashCost: null,
    streams: Object.freeze(streamReports),
  });
}
