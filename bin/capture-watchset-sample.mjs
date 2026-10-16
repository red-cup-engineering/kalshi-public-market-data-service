#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import {
  captureMarketSnapshot,
  captureMilestoneAttentionSnapshot,
} from "../src/public-market-data.mjs";
import { dailySportsTapePath, resolveSportsCaptureConfig } from "../src/capture-layout.mjs";
import { appendTapeRecord, formTapeRecord } from "../src/research-tape.mjs";

const args = process.argv.slice(2);
const get = (name, fallback = null) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const configured = resolveSportsCaptureConfig();
const root = get("root", configured.root);
const watchsetFile = get("watchset", "/var/lib/kalshi-sports-research/watchset/current.json");
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

const tasks = [
  ...watchset.marketTickers.map((ticker) => ({
    recordType: "market",
    id: ticker,
    run: () => captureMarketSnapshot(ticker),
  })),
  ...watchset.milestoneIds.map((milestoneId) => ({
    recordType: "milestone-attention",
    id: milestoneId,
    run: () => captureMilestoneAttentionSnapshot(milestoneId, {
      includePlayerStats: true,
      includeGameStats: true,
    }),
  })),
];

const results = new Array(tasks.length);
let cursor = 0;
async function worker() {
  while (true) {
    const index = cursor;
    cursor += 1;
    if (index >= tasks.length) return;
    const task = tasks[index];
    try {
      results[index] = { task, result: await task.run() };
    } catch (error) {
      results[index] = {
        task,
        result: {
          type: "Reject",
          code: "capture-exception",
          detail: error instanceof Error ? error.message : String(error),
          venueWrite: false,
        },
      };
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, tasks.length)) }, () => worker()));

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
  requested: tasks.length,
  accepted,
  failures,
  concurrency,
}) + "\n");

if (tasks.length > 0 && accepted === 0 && failures > 0) process.exitCode = 1;
