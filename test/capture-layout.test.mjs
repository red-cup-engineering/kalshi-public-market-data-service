import assert from "node:assert/strict";
import test from "node:test";

import {
  dailySportsTapePath,
  resolveSportsCaptureConfig,
} from "../src/capture-layout.mjs";

test("the consuming Operations instance must supply the tape root", () => {
  assert.throws(() => resolveSportsCaptureConfig({}), /sports-tape-root-required/);
  const config = resolveSportsCaptureConfig({ KALSHI_SPORTS_TAPE_ROOT: "/tmp/tape" });
  assert.equal(config.root, "/tmp/tape");
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
    () => resolveSportsCaptureConfig({ KALSHI_SPORTS_TAPE_ROOT: "/tmp/tape", KALSHI_SPORTS_MAX_MARKETS: "101" }),
    /invalid-sports-market-bound/,
  );
  assert.throws(
    () => resolveSportsCaptureConfig({ KALSHI_SPORTS_TAPE_ROOT: "/tmp/tape", KALSHI_SPORTS_MAX_MILESTONES: "51" }),
    /invalid-sports-milestone-bound/,
  );
});
