import assert from "node:assert/strict";
import test from "node:test";

import {
  dailySportsTapePath,
  resolveSportsCaptureConfig,
} from "../src/capture-layout.mjs";

test("capture defaults are conservative and persistent-host oriented", () => {
  const config = resolveSportsCaptureConfig({});
  assert.equal(config.root, "/var/lib/kalshi-sports-research/tapes");
  assert.equal(config.maxMarkets, 12);
  assert.equal(config.maxMilestones, 6);
});

test("daily tape path rotates on UTC date boundaries deterministically", () => {
  assert.equal(
    dailySportsTapePath("/var/lib/test", "2026-10-03T23:59:59.999Z"),
    "/var/lib/test/2026-10-03.jsonl",
  );
  assert.equal(
    dailySportsTapePath("/var/lib/test", "2026-10-04T00:00:00.000Z"),
    "/var/lib/test/2026-10-04.jsonl",
  );
});

test("capture bounds refuse accidental fan-out", () => {
  assert.throws(
    () => resolveSportsCaptureConfig({ KALSHI_SPORTS_MAX_MARKETS: "101" }),
    /invalid-sports-market-bound/,
  );
  assert.throws(
    () => resolveSportsCaptureConfig({ KALSHI_SPORTS_MAX_MILESTONES: "51" }),
    /invalid-sports-milestone-bound/,
  );
});
