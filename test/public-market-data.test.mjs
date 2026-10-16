import assert from "node:assert/strict";
import test from "node:test";

import {
  KALSHI_PUBLIC_BASE,
  captureEventFeeContext,
  captureEventFeeContextByTicker,
  captureMarketSnapshot,
  captureMilestoneEventSentrySnapshot,
  getEvent,
  getMarkets,
  getOrderbook,
  getGameStats,
  getMilestoneLiveData,
  getMilestones,
  getSportsFilters,
  listOpenSportsEvents,
  listSportsMilestones,
  deriveActiveSportsWatchset,
  describeMarketObservability,
  describeOrderbookObservability,
  resolveActiveSportsWatchset,
} from "../src/public-market-data.mjs";

const fixedClock = () => new Date("2026-10-03T19:50:00.000Z");

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "error",
    async json() { return payload; },
  };
}

test("public market reads use current production host and no credentials", async () => {
  const seen = [];
  const result = await getMarkets({
    status: "open",
    seriesTicker: "KXTEST",
    limit: 1000,
    clock: fixedClock,
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), options });
      return response({ markets: [], cursor: "" });
    },
  });

  assert.equal(KALSHI_PUBLIC_BASE, "https://external-api.kalshi.com/trade-api/v2");
  assert.equal(result.type, "Accept");
  const url = new URL(seen[0].url);
  assert.equal(url.pathname, "/trade-api/v2/markets");
  assert.equal(url.searchParams.get("status"), "open");
  assert.equal(url.searchParams.get("series_ticker"), "KXTEST");
  assert.equal(seen[0].options.headers["KALSHI-ACCESS-KEY"], undefined);
});

test("unbounded market page requests fail closed", async () => {
  await assert.rejects(
    () => getMarkets({ limit: 1001, fetchImpl: async () => response({}) }),
    /limit-out-of-range/,
  );
});

test("orderbook preserves Kalshi bid-only book for research-side normalization", async () => {
  const result = await getOrderbook("KXTEST-YES", {
    clock: fixedClock,
    fetchImpl: async () => response({
      orderbook_fp: {
        yes_dollars: [["0.6000", "12.00"]],
        no_dollars: [["0.3800", "7.00"]],
      },
    }),
  });

  assert.deepEqual(result.object.orderbook_fp.yes_dollars, [["0.6000", "12.00"]]);
  assert.deepEqual(result.object.orderbook_fp.no_dollars, [["0.3800", "7.00"]]);
});

test("sports discovery joins open events to the dedicated milestones endpoint", async () => {
  const seen = [];
  const result = await listOpenSportsEvents({
    maxPages: 2,
    milestoneMaxPages: 2,
    clock: fixedClock,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      seen.push(parsed);
      if (parsed.pathname.endsWith("/events")) {
        return response({
          events: [
            {
              event_ticker: "SPORT-1",
              category: "Sports",
              title: "Example game",
              markets: [{ ticker: "SPORT-1-WIN", rules_primary: "Example rule" }],
            },
            {
              event_ticker: "OTHER-1",
              category: "Weather",
              markets: [],
            },
          ],
          cursor: "",
        });
      }
      if (parsed.pathname.endsWith("/milestones")) {
        return response({
          milestones: [
            {
              id: "mile-sport-1",
              category: "Sports",
              type: "soccer_game",
              start_date: "2026-10-03T19:00:00Z",
              end_date: "2026-10-03T21:00:00Z",
              related_event_tickers: ["SPORT-1"],
              primary_event_tickers: ["SPORT-1"],
            },
            {
              id: "mile-unrelated",
              category: "Sports",
              type: "soccer_game",
              start_date: "2026-10-03T19:00:00Z",
              end_date: "2026-10-03T21:00:00Z",
              related_event_tickers: ["SPORT-OTHER"],
            },
          ],
          cursor: "",
        });
      }
      return response({}, 404);
    },
  });

  assert.equal(result.object.events.length, 1);
  assert.equal(result.object.events[0].markets[0].rules_primary, "Example rule");
  assert.equal(result.object.milestones.length, 2);
  assert.deepEqual(result.object.milestones.map((item) => item.id), ["mile-sport-1", "mile-unrelated"]);
  assert.equal(result.object.milestoneMinimumStartDate, "2026-10-03T07:50:00.000Z");
  assert.ok(seen.some((url) =>
    url.pathname.endsWith("/events") &&
    url.searchParams.get("with_milestones") === "false"));
  assert.ok(seen.some((url) =>
    url.pathname.endsWith("/milestones") &&
    url.searchParams.get("category") === "Sports" &&
    url.searchParams.get("limit") === "500"));
  assert.match(result.id, /^ni:\/\/\/sha-256;/);
});

test("dedicated milestone reads are bounded and preserve venue filters", async () => {
  let seen;
  const result = await getMilestones({
    limit: 500,
    minimumStartDate: "2026-10-03T07:50:00Z",
    category: "Sports",
    relatedEventTicker: "SPORT-1",
    clock: fixedClock,
    fetchImpl: async (url, options) => {
      seen = { url: new URL(url), options };
      return response({ milestones: [], cursor: "" });
    },
  });

  assert.equal(result.type, "Accept");
  assert.equal(seen.url.pathname, "/trade-api/v2/milestones");
  assert.equal(seen.url.searchParams.get("limit"), "500");
  assert.equal(seen.url.searchParams.get("category"), "Sports");
  assert.equal(seen.url.searchParams.get("related_event_ticker"), "SPORT-1");
  assert.equal(seen.options.headers["KALSHI-ACCESS-KEY"], undefined);
});

test("sports milestone pagination deduplicates milestone ids", async () => {
  let calls = 0;
  const result = await listSportsMilestones({
    minimumStartDate: "2026-10-03T07:50:00Z",
    maxPages: 2,
    clock: fixedClock,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return response({
          milestones: [{ id: "M1", category: "Sports", start_date: "2026-10-03T19:00:00Z" }],
          cursor: "next",
        });
      }
      return response({
        milestones: [
          { id: "M1", category: "Sports", start_date: "2026-10-03T19:00:00Z" },
          { id: "M2", category: "Sports", start_date: "2026-10-03T20:00:00Z" },
        ],
        cursor: "",
      });
    },
  });
  assert.deepEqual(result.object.milestones.map((item) => item.id), ["M1", "M2"]);
  assert.equal(result.object.truncated, false);
});

test("snapshot binds market rules, current book, trades and provenance", async () => {
  const result = await captureMarketSnapshot("KXTEST-YES", {
    clock: fixedClock,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/orderbook")) {
        return response({ orderbook_fp: { yes_dollars: [["0.60", "10"]], no_dollars: [["0.39", "11"]] } });
      }
      if (path.endsWith("/markets/trades")) {
        return response({ trades: [{ trade_id: "t1", ticker: "KXTEST-YES" }], cursor: "" });
      }
      if (path.endsWith("/markets/KXTEST-YES")) {
        return response({ market: { ticker: "KXTEST-YES", rules_primary: "Exact settlement rule" } });
      }
      return response({}, 404);
    },
  });

  assert.equal(result.type, "Accept");
  assert.equal(result.object.market.rules_primary, "Exact settlement rule");
  assert.equal(result.object.orderbook.yes_dollars[0][0], "0.60");
  assert.equal(result.object.trades[0].trade_id, "t1");
  assert.equal(result.object.retrievedAt, "2026-10-03T19:50:00.000Z");
  assert.equal(result.object.observedAt, result.object.retrievedAt);
  assert.match(result.object.provenance.market, /external-api\.kalshi\.com/);
});


test("sports filter discovery is a credential-free public read", async () => {
  let seen;
  const result = await getSportsFilters({
    clock: fixedClock,
    fetchImpl: async (url, options) => {
      seen = { url: String(url), options };
      return response({ filters_by_sports: { Soccer: {} }, sport_ordering: ["Soccer"] });
    },
  });

  assert.equal(result.object.sport_ordering[0], "Soccer");
  assert.equal(new URL(seen.url).pathname, "/trade-api/v2/search/filters_by_sport");
  assert.equal(seen.options.headers["KALSHI-ACCESS-KEY"], undefined);
});

test("milestone live data can request player stats without authentication", async () => {
  let seen;
  const result = await getMilestoneLiveData("milestone-123", {
    includePlayerStats: true,
    clock: fixedClock,
    fetchImpl: async (url, options) => {
      seen = { url: String(url), options };
      return response({ live_data: { type: "sports", details: { players: [] }, milestone_id: "milestone-123" } });
    },
  });

  const url = new URL(seen.url);
  assert.equal(url.pathname, "/trade-api/v2/live_data/milestone/milestone-123");
  assert.equal(url.searchParams.get("include_player_stats"), "true");
  assert.equal(seen.options.headers["KALSHI-ACCESS-KEY"], undefined);
  assert.equal(result.object.live_data.milestone_id, "milestone-123");
});

test("game stats preserve play-by-play as raw structured attention", async () => {
  const result = await getGameStats("milestone-123", {
    clock: fixedClock,
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, "/trade-api/v2/live_data/milestone/milestone-123/game_stats");
      return response({ pbp: { periods: [{ events: [{ id: "play-1" }] }] } });
    },
  });

  assert.equal(result.object.pbp.periods[0].events[0].id, "play-1");
});


test("active watchset selects game-time milestones and their nested markets, not every sports event", () => {
  const snapshot = {
    kind: "OpenSportsEventsSnapshot",
    events: [
      {
        event_ticker: "GAME-NOW",
        markets: [{ ticker: "GAME-NOW-WIN" }, { ticker: "GAME-NOW-SPREAD" }],
      },
      {
        event_ticker: "CAREER-LONG",
        markets: [{ ticker: "CAREER-LONG-1" }],
      },
    ],
    milestones: [
      {
        id: "mile-now",
        category: "Sports",
        start_date: "2026-10-03T19:30:00Z",
        end_date: "2026-10-03T22:00:00Z",
        related_event_tickers: ["GAME-NOW"],
        primary_event_tickers: ["GAME-NOW"],
      },
      {
        id: "mile-next-week",
        category: "Sports",
        start_date: "2026-10-10T19:30:00Z",
        end_date: "2026-10-10T22:00:00Z",
        related_event_tickers: ["CAREER-LONG"],
      },
    ],
  };

  const watchset = deriveActiveSportsWatchset(snapshot, {
    at: "2026-10-03T20:00:00Z",
    prestartMinutes: 30,
    postendMinutes: 30,
  });

  assert.deepEqual(watchset.milestoneIds, ["mile-now"]);
  assert.deepEqual(watchset.eventTickers, ["GAME-NOW"]);
  assert.deepEqual(watchset.marketTickers, ["GAME-NOW-WIN", "GAME-NOW-SPREAD"]);
});


test("fee context captures series metadata plus event overrides and change schedules", async () => {
  const event = {
    event_ticker: "SPORT-1",
    series_ticker: "KXSPORT",
    fee_type_override: "quadratic_with_maker_fees",
    fee_multiplier_override: 1,
  };

  const seen = [];
  const result = await captureEventFeeContext(event, {
    clock: fixedClock,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      seen.push(parsed.pathname + parsed.search);
      if (parsed.pathname.endsWith("/series/KXSPORT")) {
        return response({
          series: {
            ticker: "KXSPORT",
            fee_type: "quadratic",
            fee_multiplier: 0.5,
          },
        });
      }
      if (parsed.pathname.endsWith("/series/fee_changes")) {
        return response({
          fee_changes: [{
            id: "series-change-1",
            series_ticker: "KXSPORT",
            fee_type: "quadratic",
            fee_multiplier: 1,
            scheduled_ts: "2026-10-03T21:00:00Z",
          }],
        });
      }
      if (parsed.pathname.endsWith("/events/fee_changes")) {
        return response({
          fee_changes: [{
            id: "event-change-1",
            event_ticker: "SPORT-1",
            fee_type_override: null,
            fee_multiplier_override: null,
            scheduled_ts: "2026-10-03T22:00:00Z",
          }],
          cursor: "",
        });
      }
      return response({}, 404);
    },
  });

  assert.equal(result.type, "Accept");
  assert.equal(result.object.kind, "FeeContextSnapshot");
  assert.equal(result.object.current.seriesFeeType, "quadratic");
  assert.equal(result.object.current.seriesFeeMultiplier, 0.5);
  assert.equal(result.object.current.eventFeeTypeOverride, "quadratic_with_maker_fees");
  assert.equal(result.object.current.eventFeeMultiplierOverride, 1);
  assert.equal(result.object.scheduledAndHistorical.seriesFeeChanges.length, 1);
  assert.equal(result.object.scheduledAndHistorical.eventFeeChanges.length, 1);
  assert.ok(seen.some((url) => url.includes("/series/fee_changes") && url.includes("show_historical=true")));
  assert.ok(seen.some((url) => url.includes("/events/fee_changes") && url.includes("event_ticker=SPORT-1")));
});


test("milestone-first watchset resolves directly to currently open markets", async () => {
  const snapshot = {
    kind: "OpenSportsEventsSnapshot",
    events: [],
    milestones: [
      {
        id: "mile-now",
        category: "Sports",
        type: "tennis_tournament_singles",
        start_date: "2026-10-03T19:30:00Z",
        related_event_tickers: ["EVENT-NOW"],
        primary_event_tickers: ["EVENT-NOW"],
      },
      {
        id: "mile-old",
        category: "Sports",
        type: "tennis_tournament_singles",
        start_date: "2026-10-03T10:00:00Z",
        related_event_tickers: ["EVENT-OLD"],
      },
    ],
  };

  const seen = [];
  const watchset = await resolveActiveSportsWatchset(snapshot, {
    at: "2026-10-03T20:00:00Z",
    maxMarkets: 10,
    maxMilestones: 5,
    unknownEndMaxAgeMinutes: 360,
    clock: fixedClock,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      seen.push(parsed);
      if (parsed.searchParams.get("event_ticker") === "EVENT-NOW") {
        return response({
          markets: [
            { ticker: "EVENT-NOW-WIN", status: "active" },
            { ticker: "EVENT-NOW-CLOSED", status: "closed" },
          ],
          cursor: "",
        });
      }
      return response({ markets: [], cursor: "" });
    },
  });

  assert.equal(watchset.candidateMilestoneCount, 1);
  assert.deepEqual(watchset.milestoneIds, ["mile-now"]);
  assert.deepEqual(watchset.eventTickers, ["EVENT-NOW"]);
  assert.deepEqual(watchset.marketTickers, ["EVENT-NOW-WIN"]);
  assert.ok(seen.some((url) =>
    url.pathname.endsWith("/markets") &&
    url.searchParams.get("event_ticker") === "EVENT-NOW" &&
    url.searchParams.get("status") === "open"));
});

test("milestone-first watchset refuses to call a stale unknown-duration game active forever", async () => {
  let calls = 0;
  const watchset = await resolveActiveSportsWatchset({
    kind: "OpenSportsEventsSnapshot",
    events: [],
    milestones: [{
      id: "mile-old",
      start_date: "2026-10-03T10:00:00Z",
      related_event_tickers: ["EVENT-OLD"],
    }],
  }, {
    at: "2026-10-03T20:00:00Z",
    unknownEndMaxAgeMinutes: 360,
    fetchImpl: async () => {
      calls += 1;
      return response({ markets: [], cursor: "" });
    },
  });

  assert.equal(calls, 0);
  assert.equal(watchset.candidateMilestoneCount, 0);
  assert.deepEqual(watchset.marketTickers, []);
});


test("single event lookup is public and preserves series metadata needed for fees", async () => {
  let seen;
  const result = await getEvent("SPORT-LATE", {
    clock: fixedClock,
    fetchImpl: async (url, options) => {
      seen = { url: new URL(url), options };
      return response({
        event: {
          event_ticker: "SPORT-LATE",
          series_ticker: "KXSPORT",
          category: "Sports",
        },
      });
    },
  });

  assert.equal(result.type, "Accept");
  assert.equal(seen.url.pathname, "/trade-api/v2/events/SPORT-LATE");
  assert.equal(seen.url.searchParams.get("with_nested_markets"), "false");
  assert.equal(seen.options.headers["KALSHI-ACCESS-KEY"], undefined);
  assert.equal(result.object.event.series_ticker, "KXSPORT");
});

test("fee context resolves an admitted milestone event even when catalog pagination omitted it", async () => {
  const seen = [];
  const result = await captureEventFeeContextByTicker("SPORT-LATE", {
    clock: fixedClock,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      seen.push(parsed.pathname + parsed.search);

      if (parsed.pathname.endsWith("/events/SPORT-LATE")) {
        return response({
          event: {
            event_ticker: "SPORT-LATE",
            series_ticker: "KXSPORT",
            fee_type_override: null,
            fee_multiplier_override: null,
          },
        });
      }
      if (parsed.pathname.endsWith("/series/KXSPORT")) {
        return response({
          series: {
            ticker: "KXSPORT",
            fee_type: "quadratic",
            fee_multiplier: 1,
          },
        });
      }
      if (parsed.pathname.endsWith("/series/fee_changes")) {
        return response({ fee_changes: [] });
      }
      if (parsed.pathname.endsWith("/events/fee_changes")) {
        return response({ fee_changes: [], cursor: "" });
      }
      return response({}, 404);
    },
  });

  assert.equal(result.type, "Accept");
  assert.equal(result.object.kind, "FeeContextSnapshot");
  assert.equal(result.object.eventTicker, "SPORT-LATE");
  assert.equal(result.object.seriesTicker, "KXSPORT");
  assert.equal(result.object.current.seriesFeeType, "quadratic");
  assert.equal(result.object.current.seriesFeeMultiplier, 1);
  assert.ok(seen.some((url) => url.startsWith("/trade-api/v2/events/SPORT-LATE")));
  assert.equal(
    result.object.provenance.event,
    "https://external-api.kalshi.com/trade-api/v2/events/SPORT-LATE?with_nested_markets=false",
  );
});

test("fee context by ticker fails closed when authoritative event lacks a series ticker", async () => {
  const result = await captureEventFeeContextByTicker("SPORT-BROKEN", {
    clock: fixedClock,
    fetchImpl: async () => response({
      event: { event_ticker: "SPORT-BROKEN" },
    }),
  });

  assert.equal(result.type, "Reject");
  assert.equal(result.code, "event-fee-context-metadata-incomplete");
  assert.equal(result.venueWrite, false);
});

test("structured-reaction selection prefers started PBP-capable soccer over scheduled market-rich MMA", async () => {
  const snapshot = {
    kind: "OpenSportsEventsSnapshot",
    events: [],
    milestones: [
      {
        id: "mma-scheduled",
        type: "mma_match",
        start_date: "2026-10-03T20:05:00Z",
        details: { status: "scheduled", coverage: {} },
        related_event_tickers: ["MMA-EVENT"],
      },
      {
        id: "soccer-started",
        type: "soccer_tournament_multi_leg",
        start_date: "2026-10-03T19:58:00Z",
        details: {
          status: "not_started",
          coverage: {
            basic_play_by_play: true,
            deeper_play_by_play: true,
          },
        },
        related_event_tickers: ["SOCCER-EVENT"],
      },
    ],
  };

  const watchset = await resolveActiveSportsWatchset(snapshot, {
    at: "2026-10-03T20:00:00Z",
    maxMarkets: 6,
    maxMilestones: 6,
    maxMarketsPerMilestone: 3,
    selectionMode: "structured-reaction",
    fetchImpl: async (url) => {
      const event = new URL(url).searchParams.get("event_ticker");
      if (event === "SOCCER-EVENT") {
        return response({
          markets: [
            {
              ticker: "SOCCER-WIN",
              status: "active",
              yes_bid_dollars: "0.48",
              yes_ask_dollars: "0.50",
              no_bid_dollars: "0.50",
              liquidity_dollars: "500",
            },
            {
              ticker: "SOCCER-SPREAD",
              status: "active",
              yes_bid_dollars: "0.46",
              yes_ask_dollars: "0.50",
              no_bid_dollars: "0.50",
              liquidity_dollars: "400",
            },
            {
              ticker: "SOCCER-TOTAL",
              status: "active",
              yes_bid_dollars: "0.44",
              yes_ask_dollars: "0.50",
              no_bid_dollars: "0.50",
              liquidity_dollars: "300",
            },
            {
              ticker: "SOCCER-BTTS",
              status: "active",
              yes_bid_dollars: "0.97",
              no_bid_dollars: "",
              liquidity_dollars: "9000",
            },
          ],
          cursor: "",
        });
      }
      if (event === "MMA-EVENT") {
        return response({
          markets: Array.from({ length: 10 }, (_, index) => ({
            ticker: `MMA-${index + 1}`,
            status: "active",
          })),
          cursor: "",
        });
      }
      return response({ markets: [], cursor: "" });
    },
  });

  assert.equal(watchset.selectionPolicy.mode, "structured-reaction");
  assert.equal(watchset.selectionPolicy.maxMarketsPerMilestone, 3);
  assert.equal(watchset.selection[0].milestoneId, "soccer-started");
  assert.equal(watchset.selection[0].playByPlayCoverageLevel, 3);
  assert.equal(watchset.selection[0].startedByClock, true);
  assert.equal(watchset.selection[0].providerStatus, "not_started");
  assert.equal(watchset.selection[0].admittedMarketCount, 3);
  assert.equal(watchset.selection[1].milestoneId, "mma-scheduled");
  assert.equal(watchset.selection[1].prestartStatus, true);
  assert.equal(watchset.selection[1].admittedMarketCount, 3);

  assert.deepEqual(watchset.milestoneIds, ["soccer-started", "mma-scheduled"]);
  assert.deepEqual(watchset.marketTickers.slice(0, 3), [
    "SOCCER-WIN",
    "SOCCER-SPREAD",
    "SOCCER-TOTAL",
  ]);
  assert.deepEqual(watchset.marketTickers.slice(3), ["MMA-1", "MMA-10", "MMA-2"]);
});

test("per-milestone market cap prevents one contract-rich game from monopolizing the attention budget", async () => {
  const snapshot = {
    kind: "OpenSportsEventsSnapshot",
    events: [],
    milestones: [
      {
        id: "game-a",
        start_date: "2026-10-03T19:59:00Z",
        related_event_tickers: ["EVENT-A"],
      },
      {
        id: "game-b",
        start_date: "2026-10-03T19:58:00Z",
        related_event_tickers: ["EVENT-B"],
      },
    ],
  };

  const watchset = await resolveActiveSportsWatchset(snapshot, {
    at: "2026-10-03T20:00:00Z",
    maxMarkets: 4,
    maxMilestones: 2,
    maxMarketsPerMilestone: 2,
    selectionMode: "temporal",
    fetchImpl: async (url) => {
      const event = new URL(url).searchParams.get("event_ticker");
      return response({
        markets: Array.from({ length: 8 }, (_, index) => ({
          ticker: `${event}-M${index + 1}`,
          status: "active",
        })),
        cursor: "",
      });
    },
  });

  assert.equal(watchset.marketTickers.length, 4);
  assert.equal(watchset.selection.length, 2);
  assert.equal(watchset.selection[0].admittedMarketCount, 2);
  assert.equal(watchset.selection[1].admittedMarketCount, 2);
  assert.ok(watchset.marketTickers.some((ticker) => ticker.startsWith("EVENT-A-")));
  assert.ok(watchset.marketTickers.some((ticker) => ticker.startsWith("EVENT-B-")));
});

test("temporal selection remains the compatibility default", async () => {
  const snapshot = {
    kind: "OpenSportsEventsSnapshot",
    events: [],
    milestones: [
      {
        id: "near-no-pbp",
        start_date: "2026-10-03T20:01:00Z",
        details: { coverage: {} },
        related_event_tickers: ["NEAR"],
      },
      {
        id: "far-pbp",
        start_date: "2026-10-03T19:50:00Z",
        details: { coverage: { basic_play_by_play: true } },
        related_event_tickers: ["FAR"],
      },
    ],
  };

  const watchset = await resolveActiveSportsWatchset(snapshot, {
    at: "2026-10-03T20:00:00Z",
    maxMarkets: 1,
    maxMilestones: 2,
    fetchImpl: async (url) => response({
      markets: [{
        ticker: new URL(url).searchParams.get("event_ticker") + "-WIN",
        status: "active",
      }],
      cursor: "",
    }),
  });

  assert.equal(watchset.selectionPolicy.mode, "temporal");
  assert.equal(watchset.selection[0].milestoneId, "near-no-pbp");
  assert.deepEqual(watchset.marketTickers, ["NEAR-WIN"]);
});


test("structured-reaction readiness prefers a started unknown-coverage game over a prestart PBP game", async () => {
  const snapshot = {
    kind: "OpenSportsEventsSnapshot",
    events: [],
    milestones: [
      {
        id: "started-unknown",
        start_date: "2026-10-03T19:59:00Z",
        details: { status: "not_started", coverage: {} },
        related_event_tickers: ["STARTED"],
      },
      {
        id: "prestart-pbp",
        start_date: "2026-10-03T20:10:00Z",
        details: { status: "scheduled", coverage: { deeper_play_by_play: true } },
        related_event_tickers: ["PRESTART"],
      },
    ],
  };

  const watchset = await resolveActiveSportsWatchset(snapshot, {
    at: "2026-10-03T20:00:00Z",
    maxMarkets: 1,
    maxMilestones: 2,
    maxMarketsPerMilestone: 1,
    selectionMode: "structured-reaction",
    fetchImpl: async (url) => response({
      markets: [{
        ticker: new URL(url).searchParams.get("event_ticker") + "-WIN",
        status: "active",
      }],
      cursor: "",
    }),
  });

  assert.equal(watchset.selection[0].milestoneId, "started-unknown");
  assert.equal(watchset.selection[0].reactionReadiness, 2);
  assert.equal(watchset.selection[1], undefined);
  assert.deepEqual(watchset.marketTickers, ["STARTED-WIN"]);
});


test("structured-executable-reaction spends research budget only on two-sided books within the spread gate", async () => {
  const snapshot = {
    kind: "OpenSportsEventsSnapshot",
    events: [],
    milestones: [
      {
        id: "soccer-live",
        type: "soccer_match",
        start_date: "2026-10-03T19:55:00Z",
        details: {
          status: "in_progress",
          coverage: { deeper_play_by_play: true },
        },
        related_event_tickers: ["SOCCER-LIVE"],
      },
    ],
  };

  const watchset = await resolveActiveSportsWatchset(snapshot, {
    at: "2026-10-03T20:00:00Z",
    maxMarkets: 2,
    maxMilestones: 1,
    maxMarketsPerMilestone: 2,
    selectionMode: "structured-executable-reaction",
    maxResearchSpreadDollars: 0.20,
    fetchImpl: async () => response({
      markets: [
        {
          ticker: "ONE-SIDED-HUGE",
          status: "active",
          yes_bid_dollars: "0.97",
          yes_ask_dollars: "0.99",
          no_bid_dollars: "",
          liquidity_dollars: "9000",
        },
        {
          ticker: "TWO-SIDED-WIDE",
          status: "active",
          yes_bid_dollars: "0.10",
          yes_ask_dollars: "0.90",
          no_bid_dollars: "0.10",
          liquidity_dollars: "8000",
        },
        {
          ticker: "TWO-SIDED-TIGHT",
          status: "active",
          yes_bid_dollars: "0.48",
          yes_ask_dollars: "0.52",
          no_bid_dollars: "0.48",
          liquidity_dollars: "300",
          volume_24h_fp: "1200",
        },
      ],
      cursor: "",
    }),
  });

  assert.equal(watchset.selectionPolicy.mode, "structured-executable-reaction");
  assert.equal(watchset.selectionPolicy.maxResearchSpreadDollars, 0.20);
  assert.deepEqual(watchset.marketTickers, ["TWO-SIDED-TIGHT"]);
  assert.deepEqual(watchset.milestoneIds, ["soccer-live"]);
  assert.equal(watchset.selection[0].admittedMarketCount, 1);
  assert.equal(watchset.selection[0].twoSidedMarketCount, 1);
  assert.equal(watchset.selection[0].medianSelectedSpread, 0.040000000000000036);

  const witness = watchset.discovery[0];
  assert.deepEqual(witness.openMarketTickers, [
    "TWO-SIDED-TIGHT",
    "TWO-SIDED-WIDE",
    "ONE-SIDED-HUGE",
  ]);
  assert.deepEqual(witness.eligibleMarketTickers, ["TWO-SIDED-TIGHT"]);
  assert.equal(witness.selectedMarketObservability[0].twoSided, true);
});

test("structured-executable-reaction skips an otherwise attractive milestone when none of its markets are measurable", async () => {
  const snapshot = {
    kind: "OpenSportsEventsSnapshot",
    events: [],
    milestones: [
      {
        id: "first-unmeasurable",
        start_date: "2026-10-03T19:59:00Z",
        details: { coverage: { deeper_play_by_play: true } },
        related_event_tickers: ["BAD-BOOKS"],
      },
      {
        id: "second-measurable",
        start_date: "2026-10-03T19:58:00Z",
        details: { coverage: { deeper_play_by_play: true } },
        related_event_tickers: ["GOOD-BOOKS"],
      },
    ],
  };

  const watchset = await resolveActiveSportsWatchset(snapshot, {
    at: "2026-10-03T20:00:00Z",
    maxMarkets: 1,
    maxMilestones: 2,
    maxMarketsPerMilestone: 1,
    selectionMode: "structured-executable-reaction",
    maxResearchSpreadDollars: 0.20,
    fetchImpl: async (url) => {
      const event = new URL(url).searchParams.get("event_ticker");
      if (event === "BAD-BOOKS") {
        return response({
          markets: [{
            ticker: "BAD-ONE-SIDED",
            status: "active",
            yes_bid_dollars: "0.90",
            no_bid_dollars: "",
            liquidity_dollars: "10000",
          }],
          cursor: "",
        });
      }
      return response({
        markets: [{
          ticker: "GOOD-TWO-SIDED",
          status: "active",
          yes_bid_dollars: "0.55",
          no_bid_dollars: "0.40",
          liquidity_dollars: "100",
        }],
        cursor: "",
      });
    },
  });

  assert.equal(watchset.selection[0].milestoneId, "first-unmeasurable");
  assert.equal(watchset.selection[0].admitted, false);
  assert.equal(watchset.selection[1].milestoneId, "second-measurable");
  assert.equal(watchset.selection[1].admitted, true);
  assert.deepEqual(watchset.milestoneIds, ["second-measurable"]);
  assert.deepEqual(watchset.marketTickers, ["GOOD-TWO-SIDED"]);
});


test("market observability uses reciprocal NO bid as authoritative YES ask when both are present", () => {
  const descriptor = describeMarketObservability({
    ticker: "KX-MISMATCH",
    yes_bid_dollars: "0.40",
    yes_ask_dollars: "0.90",
    no_bid_dollars: "0.55",
    liquidity_dollars: "100",
  });

  assert.equal(descriptor.twoSided, true);
  assert.equal(descriptor.yesAsk, 0.44999999999999996);
  assert.equal(descriptor.spread, 0.04999999999999993);
});


test("orderbook observability uses actual bid-only depth rather than market-summary claims", () => {
  const descriptor = describeOrderbookObservability({
    yes_dollars: [["0.48", "12"]],
    no_dollars: [["0.48", "9"]],
  });
  assert.equal(descriptor.twoSided, true);
  assert.equal(descriptor.yesBid, 0.48);
  assert.equal(descriptor.noBid, 0.48);
  assert.equal(descriptor.yesAsk, 0.52);
  assert.equal(descriptor.spread, 0.040000000000000036);
  assert.equal(descriptor.yesBidQuantity, 12);
  assert.equal(descriptor.noBidQuantity, 9);
});

test("book-validated attention rejects a summary false positive and probes the next candidate", async () => {
  const snapshot = {
    kind: "OpenSportsEventsSnapshot",
    events: [],
    milestones: [{
      id: "live-soccer",
      start_date: "2026-10-03T19:55:00Z",
      details: {
        status: "in_progress",
        coverage: { deeper_play_by_play: true },
      },
      related_event_tickers: ["LIVE-EVENT"],
    }],
  };

  const seenOrderbooks = [];
  const watchset = await resolveActiveSportsWatchset(snapshot, {
    at: "2026-10-03T20:00:00Z",
    maxMarkets: 1,
    maxMilestones: 1,
    maxMarketsPerMilestone: 1,
    selectionMode: "structured-book-validated-reaction",
    maxResearchSpreadDollars: 0.20,
    maxBookProbes: 2,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/markets")) {
        return response({
          markets: [
            {
              ticker: "SUMMARY-GOOD-BOOK-DEAD",
              status: "active",
              yes_bid_dollars: "0.48",
              no_bid_dollars: "0.48",
              liquidity_dollars: "1000",
            },
            {
              ticker: "SUMMARY-GOOD-BOOK-GOOD",
              status: "active",
              yes_bid_dollars: "0.47",
              no_bid_dollars: "0.48",
              liquidity_dollars: "100",
            },
          ],
          cursor: "",
        });
      }

      if (parsed.pathname.endsWith("/SUMMARY-GOOD-BOOK-DEAD/orderbook")) {
        seenOrderbooks.push("dead");
        return response({
          orderbook_fp: {
            yes_dollars: [["0.48", "10"]],
            no_dollars: [],
          },
        });
      }

      if (parsed.pathname.endsWith("/SUMMARY-GOOD-BOOK-GOOD/orderbook")) {
        seenOrderbooks.push("good");
        return response({
          orderbook_fp: {
            yes_dollars: [["0.47", "8"]],
            no_dollars: [["0.48", "9"]],
          },
        });
      }

      return response({}, 404);
    },
  });

  assert.deepEqual(seenOrderbooks, ["dead", "good"]);
  assert.equal(watchset.bookProbeCount, 2);
  assert.deepEqual(watchset.marketTickers, ["SUMMARY-GOOD-BOOK-GOOD"]);
  assert.deepEqual(watchset.milestoneIds, ["live-soccer"]);
  assert.equal(watchset.selection[0].admittedMarketCount, 1);

  const witness = watchset.discovery[0];
  assert.deepEqual(witness.eligibleMarketTickers, [
    "SUMMARY-GOOD-BOOK-DEAD",
    "SUMMARY-GOOD-BOOK-GOOD",
  ]);
  assert.deepEqual(witness.validatedMarketTickers, ["SUMMARY-GOOD-BOOK-GOOD"]);
  assert.equal(witness.bookProbes.length, 2);
  assert.equal(witness.bookProbes[0].accepted, false);
  assert.equal(witness.bookProbes[0].bookObservability.twoSided, false);
  assert.equal(witness.bookProbes[1].accepted, true);
  assert.equal(witness.bookProbes[1].bookObservability.twoSided, true);
});

test("book-validated attention fails closed at its explicit probe budget", async () => {
  const snapshot = {
    kind: "OpenSportsEventsSnapshot",
    events: [],
    milestones: [{
      id: "bounded-probes",
      start_date: "2026-10-03T19:55:00Z",
      details: { coverage: { deeper_play_by_play: true } },
      related_event_tickers: ["BOUNDED"],
    }],
  };

  let probes = 0;
  const watchset = await resolveActiveSportsWatchset(snapshot, {
    at: "2026-10-03T20:00:00Z",
    maxMarkets: 1,
    maxMilestones: 1,
    maxMarketsPerMilestone: 1,
    selectionMode: "structured-book-validated-reaction",
    maxResearchSpreadDollars: 0.20,
    maxBookProbes: 1,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/markets")) {
        return response({
          markets: [
            {
              ticker: "BAD-FIRST",
              status: "active",
              yes_bid_dollars: "0.48",
              no_bid_dollars: "0.48",
            },
            {
              ticker: "GOOD-SECOND",
              status: "active",
              yes_bid_dollars: "0.47",
              no_bid_dollars: "0.48",
            },
          ],
          cursor: "",
        });
      }
      probes += 1;
      return response({
        orderbook_fp: {
          yes_dollars: [["0.48", "10"]],
          no_dollars: [],
        },
      });
    },
  });

  assert.equal(probes, 1);
  assert.equal(watchset.bookProbeCount, 1);
  assert.deepEqual(watchset.marketTickers, []);
  assert.deepEqual(watchset.milestoneIds, []);
  assert.equal(watchset.selection[0].admitted, false);
});


test("event-sentry capture uses only the milestone game-stats endpoint and remains analysis-compatible", async () => {
  const seen = [];
  const result = await captureMilestoneEventSentrySnapshot("mile-sentry", {
    clock: fixedClock,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      seen.push(parsed.pathname + parsed.search);
      return response({
        pbp: {
          periods: [{
            events: [{
              type: "soccer_event",
              event_type: "shot_off_target",
              clock: "40:23",
            }],
          }],
        },
      });
    },
  });

  assert.equal(result.type, "Accept");
  assert.deepEqual(seen, [
    "/trade-api/v2/live_data/milestone/mile-sentry/game_stats",
  ]);
  assert.equal(result.object.kind, "MilestoneAttentionSnapshot");
  assert.equal(result.object.attentionMode, "event-sentry");
  assert.equal(result.object.liveData, null);
  assert.equal(result.object.gameStatsStatus, "available");
  assert.equal(result.object.gameStats.periods[0].events[0].event_type, "shot_off_target");
  assert.match(result.object.provenance.gameStats, /game_stats$/);
});
