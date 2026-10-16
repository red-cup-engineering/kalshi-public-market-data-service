#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import {
  captureMarketOrderbookSentrySnapshot,
} from "../src/public-market-data.mjs";
import {
  dailySportsTapePath,
  resolveSportsCaptureConfig,
} from "../src/capture-layout.mjs";
import { appendTapeRecord, formTapeRecord } from "../src/research-tape.mjs";

const args = process.argv.slice(2);
const get = (name, fallback = null) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const configured = resolveSportsCaptureConfig();
const root = get("root", configured.root);
const watchsetFile = get("watchset", process.env.KALSHI_SPORTS_WATCHSET_PATH);
if (!watchsetFile) throw new TypeError("kalshi-watchset-path-required");
const maxAgeMs = Number(get("max-age-ms", "360000"));
const maxMarkets = Number(get("max-markets", "4"));
const concurrency = Number(get("concurrency", "4"));

if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1000 ||
    !Number.isInteger(maxMarkets) || maxMarkets < 1 || maxMarkets > 20 ||
    !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
  process.stderr.write("invalid orderbook-sentry bounds\n");
  process.exit(2);
}

let watchset;
try {
  watchset = JSON.parse(await readFile(watchsetFile, "utf8"));
} catch (error) {
  if (error?.code === "ENOENT") {
    process.stdout.write(JSON.stringify({ type: "NoWatchset", watchsetFile }) + "\n");
    process.exit(0);
  }
  throw error;
}

if (watchset?.type !== "KalshiActiveSportsWatchset" ||
    !Array.isArray(watchset.marketTickers)) {
  throw new TypeError("valid-active-sports-watchset-required");
}

const generatedMs = Date.parse(watchset.generatedAt);
if (!Number.isFinite(generatedMs) || Date.now() - generatedMs > maxAgeMs) {
  process.stdout.write(JSON.stringify({
    type: "StaleWatchset",
    generatedAt: watchset.generatedAt ?? null,
    maxAgeMs,
  }) + "\n");
  process.exit(0);
}

const tickers = watchset.marketTickers.slice(0, maxMarkets);
const sampledAt = new Date().toISOString();
await mkdir(root, { recursive: true });
const tapePath = dailySportsTapePath(root, sampledAt);

const results = new Array(tickers.length);
let cursor = 0;
async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= tickers.length) return;
    const ticker = tickers[index];
    try {
      results[index] = {
        ticker,
        result: await captureMarketOrderbookSentrySnapshot(ticker),
      };
    } catch (error) {
      results[index] = {
        ticker,
        result: {
          type: "Reject",
          code: "orderbook-sentry-exception",
          detail: error instanceof Error ? error.message : String(error),
          venueWrite: false,
        },
      };
    }
  }
}
await Promise.all(
  Array.from({ length: Math.min(concurrency, Math.max(1, tickers.length)) }, () => worker()),
);

let accepted = 0;
let failures = 0;
for (const item of results) {
  if (!item) continue;
  if (item.result.type !== "Accept") {
    failures += 1;
    process.stderr.write(JSON.stringify({
      type: "OrderbookSentryReject",
      ticker: item.ticker,
      result: item.result,
    }) + "\n");
    continue;
  }

  const payload = item.result.object;
  await appendTapeRecord(tapePath, formTapeRecord({
    recordType: "market-orderbook-sentry",
    payload,
    capturedAt: payload.observedAt ?? sampledAt,
  }));
  accepted += 1;
}

process.stdout.write(JSON.stringify({
  type: "KalshiSportsOrderbookSentrySample",
  sampledAt,
  tape: tapePath,
  watchsetId: watchset.id ?? null,
  requestedMarkets: tickers.length,
  acceptedMarkets: accepted,
  failures,
  estimatedRestReads: tickers.length,
}) + "\n");

if (tickers.length > 0 && accepted === 0 && failures > 0) process.exitCode = 1;
