#!/usr/bin/env node
import {
  captureEventFeeContextByTicker,
  captureMarketSnapshot,
  captureMilestoneAttentionSnapshot,
  resolveActiveSportsWatchset,
  listOpenSportsEvents,
} from "../src/public-market-data.mjs";
import { appendTapeRecord, formTapeRecord } from "../src/research-tape.mjs";

const args = process.argv.slice(2);
const get = (name, fallback = null) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const out = get("out");
if (!out) {
  process.stderr.write("usage: capture-active-sports --out=FILE [--at=ISO] [--max-markets=N] [--max-milestones=N]\n");
  process.exit(2);
}

const at = get("at", new Date().toISOString());
const maxMarkets = Number(get("max-markets", "50"));
const maxMilestones = Number(get("max-milestones", "20"));

async function record(recordType, result) {
  if (result.type !== "Accept") {
    process.stderr.write(JSON.stringify(result) + "\n");
    return false;
  }
  const payload = result.object;
  const capturedAt = payload?.observedAt ?? payload?.retrievedAt ?? new Date().toISOString();
  const tape = formTapeRecord({ recordType, payload, capturedAt });
  await appendTapeRecord(out, tape);
  process.stdout.write(JSON.stringify({ type: "Recorded", id: tape.id, recordType, capturedAt }) + "\n");
  return true;
}

const catalog = await listOpenSportsEvents();
if (catalog.type !== "Accept") {
  process.stderr.write(JSON.stringify(catalog) + "\n");
  process.exit(1);
}

await record("open-sports-events", catalog);
const watchset = await resolveActiveSportsWatchset(catalog.object, {
  at,
  maxMarkets,
  maxMilestones,
});

const watchRecord = formTapeRecord({
  recordType: "active-sports-watchset",
  capturedAt: at,
  payload: {
    kind: "ActiveSportsWatchset",
    provider: "Kalshi",
    ...watchset,
  },
});
await appendTapeRecord(out, watchRecord);
process.stdout.write(JSON.stringify({
  type: "Watchset",
  id: watchRecord.id,
  markets: watchset.marketTickers.length,
  milestones: watchset.milestoneIds.length,
}) + "\n");

let failed = false;

let feeFailures = 0;
for (const eventTicker of watchset.eventTickers) {
  if (!await record("fee-context", await captureEventFeeContextByTicker(eventTicker))) {
    feeFailures += 1;
  }
}

for (const ticker of watchset.marketTickers) {
  if (!await record("market", await captureMarketSnapshot(ticker))) failed = true;
}
for (const milestone of watchset.milestoneIds) {
  if (!await record("milestone-attention", await captureMilestoneAttentionSnapshot(milestone))) failed = true;
}

if (feeFailures > 0) {
  process.stderr.write(JSON.stringify({ type: "FeeContextPartial", feeFailures }) + "\n");
}
if (failed) process.exitCode = 1;
