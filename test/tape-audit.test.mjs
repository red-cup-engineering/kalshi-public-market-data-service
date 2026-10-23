import assert from "node:assert/strict";
import test from "node:test";

import { auditResearchTape } from "../src/tape-audit.mjs";
import { formTapeRecord } from "../src/research-tape.mjs";

const record = (recordType, capturedAt, payload) =>
  formTapeRecord({ recordType, capturedAt, payload });

test("tape audit measures per-stream cadence and coverage", () => {
  const records = [
    record("market", "2026-10-03T20:00:00Z", { ticker: "A" }),
    record("market", "2026-10-03T20:01:00Z", { ticker: "A" }),
    record("market", "2026-10-03T20:02:00Z", { ticker: "A" }),
    record("milestone-attention", "2026-10-03T20:00:00Z", { milestoneId: "M1" }),
    record("milestone-attention", "2026-10-03T20:03:00Z", { milestoneId: "M1" }),
  ];

  const audit = auditResearchTape(records);
  assert.equal(audit.recordCount, 5);
  assert.equal(audit.byType.market, 3);
  assert.equal(audit.streamCount, 2);
  assert.equal(audit.streams.find((item) => item.stream === "market:A").medianIntervalMs, 60_000);
  assert.equal(audit.longGapCount, 1);
  assert.equal(audit.credentialSafe, true);
});

test("duplicate content ids remain visible rather than normalized away", () => {
  const one = record("market", "2026-10-03T20:00:00Z", { ticker: "A" });
  const audit = auditResearchTape([one, one]);
  assert.deepEqual(audit.duplicateIds, [one.id]);
  assert.equal(audit.uniqueRecordCount, 1);
});

test("single-sample streams do not fabricate cadence statistics", () => {
  const audit = auditResearchTape([
    record("market", "2026-10-03T20:00:00Z", { ticker: "A" }),
  ]);
  assert.equal(audit.streams[0].medianIntervalMs, null);
  assert.equal(audit.streams[0].maxIntervalMs, null);
});


test("orderbook sentry streams receive independent cadence audits", () => {
  const audit = auditResearchTape([
    record("market-orderbook-sentry", "2026-10-03T20:00:00.000Z", {
      ticker: "KX-A",
    }),
    record("market-orderbook-sentry", "2026-10-03T20:00:01.000Z", {
      ticker: "KX-A",
    }),
    record("market-orderbook-sentry", "2026-10-03T20:00:02.000Z", {
      ticker: "KX-A",
    }),
    record("market", "2026-10-03T20:00:00.000Z", {
      ticker: "KX-A",
    }),
  ], {
    expectedIntervalMs: 1_000,
    gapFactor: 2.5,
  });

  const sentry = audit.streams.find((item) =>
    item.stream === "orderbook-sentry:KX-A");
  const full = audit.streams.find((item) => item.stream === "market:KX-A");
  assert.equal(sentry.samples, 3);
  assert.equal(sentry.medianIntervalMs, 1_000);
  assert.equal(sentry.longGapCount, 0);
  assert.equal(full.samples, 1);
  assert.equal(full.medianIntervalMs, null);
});

test("audit counts observed HTTP work and never calls missing metering free", () => {
  const base={transport:"rest",requestCount:1,durationMs:2,payloadBytesEstimate:9,status:200,outcome:"accept"};
  const metered=formTapeRecord({recordType:"market",capturedAt:"2026-10-03T20:01:00Z",
    payload:{ticker:"A"},
    attention:{requestCount:3,wallDurationMs:3,summedRequestDurationMs:6,
      payloadBytesEstimate:27,components:{market:base,orderbook:base,trades:base}}});
  const old=record("market","2026-10-03T20:02:00Z",{ticker:"A"});
  const a=auditResearchTape([metered,old]);
  assert.equal(a.meteredRecordCount,1);
  assert.equal(a.unmeteredRecordCount,1);
  assert.equal(a.meteredRecordedRequests,3);
  assert.equal(a.meteredResponseBytesEstimate,27);
  assert.equal(a.providerCashCost,null);
  assert.throws(()=>auditResearchTape([{...old,attention:{requestCount:0,payloadBytesEstimate:9}}]),
    /invalid-recorded-provider-attention/);
});
