import assert from "node:assert/strict";
import test from "node:test";

import {
  captureMarketSnapshot,
  captureMilestoneAttentionSnapshot,
  getMarket,
} from "../src/public-market-data.mjs";

const fixedClock = () => new Date("2026-10-03T22:15:00.000Z");

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "error",
    async json() { return payload; },
  };
}

test("one public REST read carries a machine-measured attention receipt", async () => {
  const result = await getMarket("KXTEST", {
    clock: fixedClock,
    fetchImpl: async () => response({
      market: { ticker: "KXTEST", yes_bid_dollars: "0.50" },
    }),
  });

  assert.equal(result.type, "Accept");
  assert.equal(result.attention.transport, "rest");
  assert.equal(result.attention.requestCount, 1);
  assert.equal(result.attention.status, 200);
  assert.equal(result.attention.outcome, "accept");
  assert.ok(Number.isFinite(result.attention.durationMs));
  assert.ok(result.attention.durationMs >= 0);
  assert.ok(result.attention.payloadBytesEstimate > 0);
});

test("market snapshot meters three parallel public reads and preserves component costs", async () => {
  const calls = [];
  const result = await captureMarketSnapshot("KXTEST", {
    clock: fixedClock,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith("/orderbook")) {
        return response({
          orderbook_fp: {
            yes_dollars: [["0.50", "10"]],
            no_dollars: [["0.49", "12"]],
          },
        });
      }
      if (path.endsWith("/markets/trades")) {
        return response({ trades: [{ trade_id: "t1", ticker: "KXTEST" }] });
      }
      if (path.endsWith("/markets/KXTEST")) {
        return response({ market: { ticker: "KXTEST", rules_primary: "test" } });
      }
      return response({}, 404);
    },
  });

  assert.equal(result.type, "Accept");
  assert.equal(calls.length, 3);
  assert.equal(result.attention.requestCount, 3);
  assert.equal(result.object.attention, undefined, "transport metering must not destabilize source content identity");
  assert.deepEqual(Object.keys(result.attention.components).sort(), [
    "market",
    "orderbook",
    "trades",
  ]);
  assert.ok(result.attention.wallDurationMs >= 0);
  assert.ok(result.attention.summedRequestDurationMs >= 0);
  assert.ok(result.attention.payloadBytesEstimate > 0);
});

test("milestone + game-stats snapshot meters two sequential reads", async () => {
  const calls = [];
  const result = await captureMilestoneAttentionSnapshot("mile-1", {
    clock: fixedClock,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith("/game_stats")) {
        return response({ pbp: { periods: [{ events: [] }] } });
      }
      return response({
        live_data: {
          milestone_id: "mile-1",
          type: "sports",
          details: { status: "in_progress" },
        },
      });
    },
  });

  assert.equal(result.type, "Accept");
  assert.equal(calls.length, 2);
  assert.equal(result.attention.requestCount, 2);
  assert.deepEqual(Object.keys(result.attention.components).sort(), [
    "gameStats",
    "liveData",
  ]);
  assert.ok(result.attention.wallDurationMs >= 0);
  assert.ok(result.attention.summedRequestDurationMs >= 0);
  assert.ok(result.attention.payloadBytesEstimate > 0);
});

test("deliberately skipping game stats prices milestone attention as one read", async () => {
  let calls = 0;
  const result = await captureMilestoneAttentionSnapshot("mile-1", {
    includeGameStats: false,
    clock: fixedClock,
    fetchImpl: async () => {
      calls += 1;
      return response({
        live_data: {
          milestone_id: "mile-1",
          type: "sports",
          details: {},
        },
      });
    },
  });

  assert.equal(result.type, "Accept");
  assert.equal(calls, 1);
  assert.equal(result.attention.requestCount, 1);
  assert.deepEqual(Object.keys(result.attention.components), ["liveData"]);
  assert.equal(result.object.gameStatsStatus, "not-requested");
});

test("HTTP refusals still report attention spent obtaining the refusal", async () => {
  const result = await getMarket("KXTEST", {
    clock: fixedClock,
    fetchImpl: async () => response({ error: { message: "rate limited" } }, 429),
  });

  assert.equal(result.type, "Reject");
  assert.equal(result.code, "http-429");
  assert.equal(result.attention.requestCount, 1);
  assert.equal(result.attention.status, 429);
  assert.equal(result.attention.outcome, "http-reject");
  assert.ok(result.attention.durationMs >= 0);
});

test("composite refuses missing components yet still counts unsuccessful HTTP reads", async () => {
  const calls=[];
  const r=await captureMarketSnapshot("KXTEST", {clock:fixedClock,
    fetchImpl:async url=>{
      const path=new URL(url).pathname;
      calls.push(path);
      if(path.endsWith("/orderbook"))return response({error:{message:"quota"}},429);
      if(path.endsWith("/markets/trades"))return response({trades:[]});
      return response({market:{ticker:"KXTEST"}});
    }});
  assert.equal(r.type,"Reject");
  assert.equal(r.code,"incomplete-market-snapshot");
  assert.equal(calls.length,3);
  assert.equal(r.attention.requestCount,3);
  assert.equal(r.attention.components.orderbook.outcome,"http-reject");
  assert.equal(r.attention.components.orderbook.status,429);
  assert.equal(r.venueWrite,false);
});

test("a network refusal is metered, never mistaken for zero attempted reads", async () => {
  const r=await getMarket("KXTEST",{clock:fixedClock,fetchImpl:async()=>{throw new Error("offline");}});
  assert.equal(r.type,"Reject");
  assert.equal(r.code,"network-error");
  assert.equal(r.attention.requestCount,1);
  assert.equal(r.attention.outcome,"network-error");
  assert.equal(r.attention.status,null);
});

test("transport duration is not folded into reproducible Kalshi content identity", async () => {
  const fetchImpl=async url=>{
    const path=new URL(url).pathname;
    if(path.endsWith("/orderbook"))return response({orderbook_fp:{yes_dollars:[],no_dollars:[]}});
    if(path.endsWith("/markets/trades"))return response({trades:[]});
    return response({market:{ticker:"KXTEST"}});
  };
  const a=await captureMarketSnapshot("KXTEST",{clock:fixedClock,fetchImpl});
  const b=await captureMarketSnapshot("KXTEST",{clock:fixedClock,fetchImpl});
  assert.equal(a.type,"Accept");
  assert.equal(a.id,b.id);
  assert.deepEqual(a.object,b.object);
  assert.equal(a.attention.requestCount,3);
  assert.equal(b.attention.requestCount,3);
  assert.equal(a.object.attention,undefined);
});
