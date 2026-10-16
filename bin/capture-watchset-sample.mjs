#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import {
  captureMarketSnapshot,
  captureMilestoneAttentionSnapshot,
} from "../src/public-market-data.mjs";
import { dailySportsTapePath, resolveSportsCaptureConfig } from "../src/capture-layout.mjs";
import { appendTapeRecord, formTapeRecord } from "../src/research-tape.mjs";
import { captureWatchsetMilestoneFirst } from "../src/watchset-sample-phases.mjs";

const args = process.argv.slice(2);
const get = (name, fallback = null) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const configured = resolveSportsCaptureConfig();
const root = get("root", configured.root);
const watchsetFile = get("watchset", process.env.KALSHI_SPORTS_WATCHSET_PATH);
if (!watchsetFile) throw new TypeError("kalshi-watchset-path-required");
const maxAgeMs = Number(get("max-age-ms", "120000"));
const concurrency = Number(get("concurrency", process.env.KALSHI_SPORTS_SAMPLE_CONCURRENCY ?? "2"));
const sampledAt = new Date().toISOString();

if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1000 ||
    !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
  process.stderr.write("invalid max age or concurrency\n");
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
    !Array.isArray(watchset.marketTickers) ||
    !Array.isArray(watchset.milestoneIds)) {
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

const phased = await captureWatchsetMilestoneFirst({
  milestoneIds: watchset.milestoneIds,
  marketTickers: watchset.marketTickers,
  concurrency,
  captureMilestone: (milestoneId) => captureMilestoneAttentionSnapshot(milestoneId, {
    includePlayerStats: true,
    includeGameStats: true,
  }),
  captureMarket: (ticker) => captureMarketSnapshot(ticker),
});

const results = [
  ...phased.milestoneResults.map(({ item, result }) => ({
    task: {
      recordType: "milestone-attention",
      id: item,
    },
    result,
  })),
  ...phased.marketResults.map(({ item, result }) => ({
    task: {
      recordType: "market",
      id: item,
    },
    result,
  })),
];
await mkdir(root, { recursive: true });
const tapePath = dailySportsTapePath(root, sampledAt);
let accepted = 0;
let failures = 0;

for (const item of results) {
  if (!item) continue;
  if (item.result.type !== "Accept") {
    failures += 1;
    process.stderr.write(JSON.stringify({
      type: "CaptureReject",
      recordType: item.task.recordType,
      id: item.task.id,
      result: item.result,
    }) + "\n");
    continue;
  }
  const payload = item.result.object;
  const capturedAt = payload?.observedAt ?? payload?.retrievedAt ?? new Date().toISOString();
  await appendTapeRecord(tapePath, formTapeRecord({
    recordType: item.task.recordType,
    payload,
    capturedAt,
  }));
  accepted += 1;
}

process.stdout.write(JSON.stringify({
  type: "KalshiSportsWatchsetSample",
  sampledAt,
  tape: tapePath,
  watchsetId: watchset.id ?? null,
  requested: watchset.milestoneIds.length + watchset.marketTickers.length,
  requestedMilestones: watchset.milestoneIds.length,
  requestedMarkets: watchset.marketTickers.length,
  accepted,
  failures,
  concurrency,
  phaseOrder: ["milestone-attention", "market"],
  startedAt: phased.startedAt,
  milestonePhaseCompletedAt: phased.milestonePhaseCompletedAt,
  marketPhaseStartedAt: phased.marketPhaseStartedAt,
  completedAt: phased.completedAt,
}) + "\n");

if (watchset.milestoneIds.length + watchset.marketTickers.length > 0 &&
    accepted === 0 &&
    failures > 0) {
  process.exitCode = 1;
}
