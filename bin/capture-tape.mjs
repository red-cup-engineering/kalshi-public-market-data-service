#!/usr/bin/env node
import {
  captureMarketSnapshot,
  captureMilestoneAttentionSnapshot,
  listOpenSportsEvents,
} from "../src/public-market-data.mjs";
import { appendTapeRecord, formTapeRecord } from "../src/research-tape.mjs";

const args = process.argv.slice(2);
const outArg = args.find((arg) => arg.startsWith("--out="));
if (!outArg) {
  process.stderr.write("usage: capture-tape --out=FILE [--sports-catalog] [--market=TICKER ...] [--milestone=ID ...]\n");
  process.exit(2);
}
const out = outArg.slice("--out=".length);
const markets = args.filter((arg) => arg.startsWith("--market=")).map((arg) => arg.slice("--market=".length));
const milestones = args.filter((arg) => arg.startsWith("--milestone=")).map((arg) => arg.slice("--milestone=".length));
const sportsCatalog = args.includes("--sports-catalog");

if (markets.length > 50 || milestones.length > 50) {
  process.stderr.write("refusing more than 50 markets or 50 milestones in one bounded capture\n");
  process.exit(2);
}
if (!sportsCatalog && markets.length === 0 && milestones.length === 0) {
  process.stderr.write("at least one capture target is required\n");
  process.exit(2);
}

let failures = 0;

async function admit(recordType, result) {
  if (result.type !== "Accept") {
    failures += 1;
    process.stderr.write(JSON.stringify(result) + "\n");
    return;
  }
  const payload = result.object;
  const capturedAt = payload?.observedAt ?? payload?.retrievedAt ?? new Date().toISOString();
  const record = formTapeRecord({ recordType, payload, capturedAt, attention: result.attention ?? null });
  await appendTapeRecord(out, record);
  process.stdout.write(JSON.stringify({ type: "Recorded", id: record.id, recordType, out }) + "\n");
}

if (sportsCatalog) {
  await admit("open-sports-events", await listOpenSportsEvents());
}
for (const ticker of markets) {
  await admit("market", await captureMarketSnapshot(ticker));
}
for (const milestone of milestones) {
  await admit("milestone-attention", await captureMilestoneAttentionSnapshot(milestone));
}

if (failures > 0) process.exitCode = 1;
