import assert from "node:assert/strict";
import test from "node:test";

import {
  describeMarketObservability,
  resolveActiveSportsWatchset,
} from "../src/public-market-data.mjs";

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "error",
    async json() { return payload; },
  };
}

test("market observability distinguishes a usable two-sided book from one-sided acquisition", () => {
  const twoSided = describeMarketObservability({
    ticker: "TWO",
    yes_bid_dollars: "0.45",
    yes_ask_dollars: "0.50",
    no_bid_dollars: "0.50",
    yes_bid_size_fp: "12.5",
    yes_ask_size_fp: "8.0",
    liquidity_dollars: "240.0",
    volume_24h_fp: "180.0",
  });
  assert.equal(twoSided.twoSided, true);
  assert.equal(twoSided.yesBid, 0.45);
  assert.equal(twoSided.yesAsk, 0.50);
  assert.ok(Math.abs(twoSided.spread - 0.05) < 1e-12);

  const oneSided = describeMarketObservability({
    ticker: "ONE",
    yes_bid_dollars: "0.97",
    no_bid_dollars: "",
    liquidity_dollars: "5000",
  });
  assert.equal(oneSided.twoSided, false);
  assert.equal(oneSided.spread, null);
  assert.equal(oneSided.liquidityDollars, 5000);
});

test("structured-reaction watchsets spend scarce market slots on jointly observable contracts first", async () => {
  const snapshot = {
    kind: "OpenSportsEventsSnapshot",
    events: [],
    milestones: [{
      id: "M1",
      type: "soccer_game",
      start_date: "2026-10-03T20:00:00Z",
      end_date: "2026-10-03T22:00:00Z",
      related_event_tickers: ["E1"],
      primary_event_tickers: ["E1"],
      details: {
        status: "in_progress",
        coverage: { play_by_play: true },
      },
    }],
  };

  const seen = [];
  const watchset = await resolveActiveSportsWatchset(snapshot, {
    at: "2026-10-03T21:00:00Z",
    maxMarkets: 1,
    maxMilestones: 1,
    maxMarketsPerMilestone: 1,
    selectionMode: "structured-reaction",
    fetchImpl: async (url) => {
      seen.push(String(url));
      return response({
        markets: [
          {
            ticker: "ONE-SIDED",
            status: "active",
            yes_bid_dollars: "0.97",
            yes_ask_dollars: "",
            no_bid_dollars: "",
            liquidity_dollars: "9000",
            volume_24h_fp: "2000",
          },
          {
            ticker: "TWO-SIDED",
            status: "active",
            yes_bid_dollars: "0.45",
            yes_ask_dollars: "0.50",
            no_bid_dollars: "0.50",
            liquidity_dollars: "200",
            volume_24h_fp: "100",
          },
        ],
        cursor: "",
      });
    },
    clock: () => new Date("2026-10-03T21:00:00Z"),
  });

  assert.equal(seen.length, 1);
  assert.deepEqual(watchset.marketTickers, ["TWO-SIDED"]);
  assert.deepEqual(watchset.milestoneIds, ["M1"]);
  assert.equal(watchset.selection[0].twoSidedMarketCount, 1);
  assert.ok(Math.abs(watchset.selection[0].medianSelectedSpread - 0.05) < 1e-12);

  const witness = watchset.discovery[0];
  assert.deepEqual(witness.selectedMarketTickers, ["TWO-SIDED"]);
  assert.equal(witness.selectedMarketObservability[0].twoSided, true);
  assert.equal(witness.openMarketObservability.length, 2);
  assert.equal(witness.openMarketObservability[0].ticker, "TWO-SIDED");
  assert.equal(witness.openMarketObservability[1].ticker, "ONE-SIDED");
});

test("temporal selection preserves provider market order for compatibility", async () => {
  const snapshot = {
    kind: "OpenSportsEventsSnapshot",
    events: [],
    milestones: [{
      id: "M1",
      type: "soccer_game",
      start_date: "2026-10-03T20:00:00Z",
      end_date: "2026-10-03T22:00:00Z",
      related_event_tickers: ["E1"],
      primary_event_tickers: ["E1"],
      details: { status: "in_progress" },
    }],
  };

  const watchset = await resolveActiveSportsWatchset(snapshot, {
    at: "2026-10-03T21:00:00Z",
    maxMarkets: 1,
    maxMilestones: 1,
    maxMarketsPerMilestone: 1,
    selectionMode: "temporal",
    fetchImpl: async () => response({
      markets: [
        { ticker: "FIRST", status: "active", yes_bid_dollars: "0.97" },
        {
          ticker: "SECOND",
          status: "active",
          yes_bid_dollars: "0.45",
          yes_ask_dollars: "0.50",
          no_bid_dollars: "0.50",
        },
      ],
      cursor: "",
    }),
    clock: () => new Date("2026-10-03T21:00:00Z"),
  });

  assert.deepEqual(watchset.marketTickers, ["FIRST"]);
});
