#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import {
  captureEventFeeContextByTicker,
  captureMarketSnapshot,
  captureMilestoneAttentionSnapshot,
  resolveActiveSportsWatchset,
  listOpenSportsEvents,
} from "../src/public-market-data.mjs";
import { appendTapeRecord, formTapeRecord } from "../src/research-tape.mjs";
import { dailySportsTapePath, resolveSportsCaptureConfig } from "../src/capture-layout.mjs";

const { root, maxMarkets, maxMilestones } = resolveSportsCaptureConfig();
const observedAt = new Date().toISOString();
const out = dailySportsTapePath(root, observedAt);

await mkdir(root, { recursive: true });

async function record(recordType, result) {
  if (result.type !== "Accept") {
    process.stderr.write(JSON.stringify({
      type: "CaptureReject",
      recordType,
      at: new Date().toISOString(),
      result,
    }) + "\n");
    return false;
  }

  const payload = result.object;
  const capturedAt = payload?.observedAt ?? payload?.retrievedAt ?? new Date().toISOString();
  const tape = formTapeRecord({ recordType, payload, capturedAt });
  await appendTapeRecord(out, tape);
  return true;
}

const catalog = await listOpenSportsEvents({ maxPages: 10 });
if (catalog.type !== "Accept") {
  process.stderr.write(JSON.stringify(catalog) + "\n");
  process.exit(1);
}
await record("open-sports-events", catalog);

const watchset = await resolveActiveSportsWatchset(catalog.object, {
  at: observedAt,
  maxMarkets,
  maxMilestones,
});

const watchRecord = formTapeRecord({
  recordType: "active-sports-watchset",
  capturedAt: observedAt,
  payload: {
    provider: "Kalshi",
    kind: "ActiveSportsWatchset",
    ...watchset,
  },
});
await appendTapeRecord(out, watchRecord);

let feeAccepted = 0;
let marketAccepted = 0;
let milestoneAccepted = 0;
let failures = 0;

for (const eventTicker of watchset.eventTickers) {
  if (await record("fee-context", await captureEventFeeContextByTicker(eventTicker))) feeAccepted += 1;
  else failures += 1;
}

for (const ticker of watchset.marketTickers) {
  if (await record("market", await captureMarketSnapshot(ticker))) marketAccepted += 1;
  else failures += 1;
}

for (const milestoneId of watchset.milestoneIds) {
  if (await record(
    "milestone-attention",
    await captureMilestoneAttentionSnapshot(milestoneId, {
      includePlayerStats: true,
      includeGameStats: true,
    }),
  )) milestoneAccepted += 1;
  else failures += 1;
}

process.stdout.write(JSON.stringify({
  type: "KalshiSportsCaptureCycle",
  observedAt,
  tape: out,
  watchsetId: watchRecord.id,
  catalogSportsEvents: Array.isArray(catalog.object?.events) ? catalog.object.events.length : 0,
  catalogSportsMilestones: Array.isArray(catalog.object?.milestones) ? catalog.object.milestones.length : 0,
  requestedFeeContexts: watchset.eventTickers.length,
  acceptedFeeContexts: feeAccepted,
  requestedMarkets: watchset.marketTickers.length,
  acceptedMarkets: marketAccepted,
  requestedMilestones: watchset.milestoneIds.length,
  acceptedMilestones: milestoneAccepted,
  failures,
}) + "\n");

if (failures > 0 && marketAccepted + milestoneAccepted === 0 &&
    watchset.marketTickers.length + watchset.milestoneIds.length > 0) {
  process.exitCode = 1;
}
