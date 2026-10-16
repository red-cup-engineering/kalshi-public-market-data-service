import assert from "node:assert/strict";
import test from "node:test";

import { captureWatchsetMilestoneFirst } from "../src/watchset-sample-phases.mjs";

test("dense sample completes all milestone sensing before any market request starts", async () => {
  const log = [];
  const sample = await captureWatchsetMilestoneFirst({
    milestoneIds: ["mile-a", "mile-b"],
    marketTickers: ["market-a", "market-b", "market-c"],
    concurrency: 2,
    captureMilestone: async (id) => {
      log.push("milestone-start:" + id);
      await Promise.resolve();
      log.push("milestone-done:" + id);
      return { type: "Accept", object: { milestoneId: id } };
    },
    captureMarket: async (ticker) => {
      log.push("market-start:" + ticker);
      await Promise.resolve();
      log.push("market-done:" + ticker);
      return { type: "Accept", object: { ticker } };
    },
  });

  assert.equal(sample.milestoneResults.length, 2);
  assert.equal(sample.marketResults.length, 3);

  const lastMilestoneDone = Math.max(
    ...log.map((value, index) => value.startsWith("milestone-done:") ? index : -1),
  );
  const firstMarketStart = log.findIndex((value) => value.startsWith("market-start:"));
  assert.ok(lastMilestoneDone >= 0);
  assert.ok(firstMarketStart > lastMilestoneDone, log.join("\n"));
});

test("one failed milestone does not remove the phase barrier or prevent market sensing", async () => {
  const log = [];
  const sample = await captureWatchsetMilestoneFirst({
    milestoneIds: ["bad", "good"],
    marketTickers: ["market"],
    concurrency: 2,
    captureMilestone: async (id) => {
      log.push("milestone-start:" + id);
      if (id === "bad") throw new Error("boom");
      log.push("milestone-done:" + id);
      return { type: "Accept" };
    },
    captureMarket: async (ticker) => {
      log.push("market-start:" + ticker);
      return { type: "Accept" };
    },
  });

  assert.equal(sample.milestoneResults[0].result.type, "Reject");
  assert.equal(sample.milestoneResults[0].result.code, "capture-exception");
  assert.equal(sample.marketResults[0].result.type, "Accept");

  const firstMarketStart = log.findIndex((value) => value.startsWith("market-start:"));
  assert.ok(firstMarketStart > log.findIndex((value) => value === "milestone-done:good"));
});

test("phase timestamps make the causal ordering auditable", async () => {
  let now = Date.parse("2026-10-03T22:40:00.000Z");
  const clock = () => new Date(now);
  const sample = await captureWatchsetMilestoneFirst({
    milestoneIds: ["mile"],
    marketTickers: ["market"],
    concurrency: 1,
    clock,
    captureMilestone: async () => {
      now += 125;
      return { type: "Accept" };
    },
    captureMarket: async () => {
      now += 250;
      return { type: "Accept" };
    },
  });

  assert.equal(sample.startedAt, "2026-10-03T22:40:00.000Z");
  assert.equal(sample.milestonePhaseCompletedAt, "2026-10-03T22:40:00.125Z");
  assert.equal(sample.marketPhaseStartedAt, "2026-10-03T22:40:00.125Z");
  assert.equal(sample.completedAt, "2026-10-03T22:40:00.375Z");
});
