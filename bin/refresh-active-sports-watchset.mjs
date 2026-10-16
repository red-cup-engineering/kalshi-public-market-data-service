#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  captureEventFeeContextByTicker,
  listOpenSportsEvents,
  resolveActiveSportsWatchset,
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
const watchsetOut = get("watchset-out", "/var/lib/kalshi-sports-research/watchset/current.json");
const at = get("at", new Date().toISOString());
const maxMarkets = Number(get("max-markets", String(configured.maxMarkets)));
const maxMilestones = Number(get("max-milestones", String(configured.maxMilestones)));
const samplingIntervalMs = Number(get("sampling-interval-ms", "15000"));
const selectionMode = get("selection-mode", "structured-reaction");
const maxMarketsPerMilestone = Number(get("max-markets-per-milestone", "4"));
const maxResearchSpreadDollars = Number(get("max-research-spread-dollars", "0.20"));
const maxBookProbes = Number(get("max-book-probes", String(Math.min(maxMarkets * 2, 100))));
const catalogIn = get("catalog-in");
const skipFeeContext = args.includes("--skip-fee-context");

if (!Number.isInteger(maxMarkets) || maxMarkets < 1 || maxMarkets > 100 ||
    !Number.isInteger(maxMilestones) || maxMilestones < 1 || maxMilestones > 50 ||
    !Number.isInteger(maxMarketsPerMilestone) ||
    maxMarketsPerMilestone < 1 ||
    maxMarketsPerMilestone > maxMarkets ||
    !["temporal", "structured-reaction", "structured-executable-reaction", "structured-book-validated-reaction"].includes(selectionMode) ||
    !Number.isFinite(maxResearchSpreadDollars) ||
    maxResearchSpreadDollars < 0 ||
    maxResearchSpreadDollars > 1 ||
    !Number.isInteger(maxBookProbes) ||
    maxBookProbes < 1 ||
    maxBookProbes > 500 ||
    !Number.isInteger(samplingIntervalMs) || samplingIntervalMs < 1000) {
  process.stderr.write("invalid watchset bounds or sampling interval\n");
  process.exit(2);
}

await mkdir(root, { recursive: true });
const tapePath = dailySportsTapePath(root, at);

let catalogPayload;
if (catalogIn) {
  const loaded = JSON.parse(await readFile(catalogIn, "utf8"));
  catalogPayload = loaded?.type === "Accept" ? loaded.object : loaded;
  if (!catalogPayload || catalogPayload.kind !== "OpenSportsEventsSnapshot") {
    throw new TypeError("valid-open-sports-catalog-file-required");
  }
} else {
  const catalog = await listOpenSportsEvents({ maxPages: 10 });
  if (catalog.type !== "Accept") {
    process.stderr.write(JSON.stringify(catalog) + "\n");
    process.exit(1);
  }
  catalogPayload = catalog.object;
}
const catalogCapturedAt = catalogPayload?.observedAt ?? catalogPayload?.retrievedAt ?? at;
await appendTapeRecord(tapePath, formTapeRecord({
  recordType: "open-sports-events",
  payload: catalogPayload,
  capturedAt: catalogCapturedAt,
}));

const watchset = await resolveActiveSportsWatchset(catalogPayload, {
  at,
  maxMarkets,
  maxMilestones,
  maxMarketsPerMilestone,
  selectionMode,
  maxResearchSpreadDollars,
  maxBookProbes,
});

const watchPayload = {
  provider: "Kalshi",
  kind: "ActiveSportsWatchset",
  generatedAt: at,
  samplingIntervalMs,
  ...watchset,
};
const watchRecord = formTapeRecord({
  recordType: "active-sports-watchset",
  capturedAt: at,
  payload: watchPayload,
});
await appendTapeRecord(tapePath, watchRecord);

const current = {
  type: "KalshiActiveSportsWatchset",
  schemaVersion: 1,
  id: watchRecord.id,
  tapeRecordId: watchRecord.id,
  ...watchPayload,
};
await mkdir(dirname(watchsetOut), { recursive: true });
const tmp = watchsetOut + ".tmp";
await writeFile(tmp, JSON.stringify(current, null, 2) + "\n", "utf8");
await rename(tmp, watchsetOut);

let feeFailures = 0;
if (!skipFeeContext) {
  for (const eventTicker of watchset.eventTickers) {
    const fee = await captureEventFeeContextByTicker(eventTicker);
    if (fee.type !== "Accept") {
      feeFailures += 1;
      process.stderr.write(JSON.stringify(fee) + "\n");
      continue;
    }
    const payload = fee.object;
    await appendTapeRecord(tapePath, formTapeRecord({
      recordType: "fee-context",
      payload,
      capturedAt: payload?.observedAt ?? payload?.retrievedAt ?? at,
    }));
  }
}

process.stdout.write(JSON.stringify({
  type: "KalshiSportsWatchsetRefresh",
  at,
  tape: tapePath,
  watchset: watchsetOut,
  watchsetId: watchRecord.id,
  markets: watchset.marketTickers.length,
  milestones: watchset.milestoneIds.length,
  selectionMode,
  maxMarketsPerMilestone,
  maxResearchSpreadDollars,
  maxBookProbes,
  bookProbeCount: watchset.bookProbeCount ?? 0,
  samplingIntervalMs,
  catalogSource: catalogIn ? "file" : "live",
  feeContext: skipFeeContext ? "skipped" : "captured",
  feeFailures,
}) + "\n");
