#!/usr/bin/env node
import {
  captureMarketSnapshot,
  captureMilestoneAttentionSnapshot,
} from "../src/public-market-data.mjs";
import { appendTapeRecord, formTapeRecord } from "../src/research-tape.mjs";

const args = process.argv.slice(2);
const value = (name, fallback = null) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const out = value("out");
const intervalMs = Number(value("interval-ms", "5000"));
const count = Number(value("count", "1"));
const markets = args.filter((arg) => arg.startsWith("--market=")).map((arg) => arg.slice(9));
const milestones = args.filter((arg) => arg.startsWith("--milestone=")).map((arg) => arg.slice(12));

if (!out || !Number.isInteger(intervalMs) || intervalMs < 250 ||
    !Number.isInteger(count) || count < 1 || count > 100000 ||
    markets.length + milestones.length === 0 ||
    markets.length > 50 || milestones.length > 50) {
  process.stderr.write("usage: capture-poll --out=FILE --interval-ms=N --count=N [--market=T ...] [--milestone=ID ...]\n");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

let failed = false;
for (let iteration = 0; iteration < count; iteration += 1) {
  const started = Date.now();

  for (const ticker of markets) {
    if (!await record("market", await captureMarketSnapshot(ticker))) failed = true;
  }
  for (const milestone of milestones) {
    if (!await record("milestone-attention", await captureMilestoneAttentionSnapshot(milestone))) failed = true;
  }

  if (iteration + 1 < count) {
    const elapsed = Date.now() - started;
    await sleep(Math.max(0, intervalMs - elapsed));
  }
}

if (failed) process.exitCode = 1;
