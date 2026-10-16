#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import {
  captureMilestoneEventSentrySnapshot,
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

if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1000) {
  process.stderr.write("invalid max-age-ms\n");
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

const sampledAt = new Date().toISOString();
await mkdir(root, { recursive: true });
const tapePath = dailySportsTapePath(root, sampledAt);

let accepted = 0;
let failures = 0;
for (const milestoneId of watchset.milestoneIds) {
  const result = await captureMilestoneEventSentrySnapshot(milestoneId);
  if (result.type !== "Accept") {
    failures += 1;
    process.stderr.write(JSON.stringify({
      type: "SentryReject",
      milestoneId,
      result,
    }) + "\n");
    continue;
  }

  const payload = result.object;
  await appendTapeRecord(tapePath, formTapeRecord({
    recordType: "milestone-attention",
    payload,
    capturedAt: payload.observedAt ?? sampledAt,
  }));
  accepted += 1;
}

process.stdout.write(JSON.stringify({
  type: "KalshiSportsEventSentrySample",
  sampledAt,
  tape: tapePath,
  watchsetId: watchset.id ?? null,
  requestedMilestones: watchset.milestoneIds.length,
  acceptedMilestones: accepted,
  failures,
  estimatedRestReads: watchset.milestoneIds.length,
}) + "\n");

if (watchset.milestoneIds.length > 0 && accepted === 0 && failures > 0) process.exitCode = 1;
