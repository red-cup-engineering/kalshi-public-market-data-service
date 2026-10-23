import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendTapeRecord,
  formTapeRecord,
  readTapeRecords,
  selectTapeAsOf,
} from "../src/research-tape.mjs";

test("append-only tape round-trips content-addressed public records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kalshi-tape-"));
  try {
    const file = join(dir, "2026-10-03.jsonl");
    const first = formTapeRecord({
      recordType: "market",
      capturedAt: "2026-10-03T19:00:00Z",
      payload: { ticker: "KXTEST", observedAt: "2026-10-03T19:00:00Z", yesBid: 0.60 },
    });
    const second = formTapeRecord({
      recordType: "market",
      capturedAt: "2026-10-03T19:00:05Z",
      payload: { ticker: "KXTEST", observedAt: "2026-10-03T19:00:05Z", yesBid: 0.61 },
    });

    await appendTapeRecord(file, first);
    await appendTapeRecord(file, second);
    const records = await readTapeRecords(file);

    assert.equal(records.length, 2);
    assert.equal(records[0].id, first.id);
    assert.equal(records[1].payload.yesBid, 0.61);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tape refuses credential-like fields even inside nested payloads", () => {
  assert.throws(() => formTapeRecord({
    recordType: "bad",
    payload: { nested: { apiKey: "never-store-me" } },
  }), /credential-material-forbidden/);
});

test("as-of selection never returns a future snapshot", () => {
  const records = [
    formTapeRecord({
      recordType: "market",
      capturedAt: "2026-10-03T19:00:00Z",
      payload: { ticker: "KXTEST", price: 0.60 },
    }),
    formTapeRecord({
      recordType: "market",
      capturedAt: "2026-10-03T19:00:10Z",
      payload: { ticker: "KXTEST", price: 0.70 },
    }),
  ];

  const selected = selectTapeAsOf(records, "2026-10-03T19:00:05Z", {
    recordType: "market",
    key: "ticker",
    value: "KXTEST",
  });

  assert.equal(selected.payload.price, 0.60);
});

test("content-id tampering is detected on replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kalshi-tape-"));
  try {
    const file = join(dir, "tamper.jsonl");
    const record = formTapeRecord({
      recordType: "market",
      payload: { ticker: "KXTEST", price: 0.60 },
    });
    await appendTapeRecord(file, record);

    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, JSON.stringify({ ...record, payload: { ticker: "KXTEST", price: 0.99 } }) + "\n");
    await assert.rejects(() => readTapeRecords(file), /tape-content-id-mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recorded HTTP attention is a source-qualified field, including in content identity", async () => {
  const attention = {requestCount:2,wallDurationMs:9,summedRequestDurationMs:12,
    payloadBytesEstimate:37,components:{
      liveData:{transport:"rest",requestCount:1,durationMs:5,payloadBytesEstimate:17,status:200,outcome:"accept"},
      gameStats:{transport:"rest",requestCount:1,durationMs:7,payloadBytesEstimate:20,status:429,outcome:"http-reject"},
    }};
  const common={recordType:"milestone-attention",capturedAt:"2026-10-03T20:00:00Z",
    payload:{milestoneId:"M1",gameStatsStatus:"unavailable"}};
  const metered=formTapeRecord({...common,attention});
  const unmetered=formTapeRecord(common);
  assert.equal(metered.attention.requestCount,2);
  assert.notEqual(metered.id,unmetered.id);
  const dir=await mkdtemp(join(tmpdir(),"kalshi-meter-"));
  try {
    const file=join(dir,"metered.jsonl");
    await appendTapeRecord(file,metered);
    const [record]=await readTapeRecords(file);
    assert.deepEqual(record.attention,attention);
    assert.equal(record.id,metered.id);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("malformed or exaggerated attention refuses rather than earning false cost credit", () => {
  const base={recordType:"market",payload:{ticker:"KXTEST"}};
  const attention={requestCount:1,wallDurationMs:1,summedRequestDurationMs:1,
    payloadBytesEstimate:9,components:{market:{
      transport:"rest",requestCount:1,durationMs:1,payloadBytesEstimate:9,status:200,outcome:"accept",
    }}};
  for (const bad of [
    {...attention,requestCount:0},
    {...attention,requestCount:2},
    {...attention,payloadBytesEstimate:10},
    {...attention,wallDurationMs:-1},
    {...attention,components:{market:{...attention.components.market,durationMs:NaN}}},
  ]) assert.throws(()=>formTapeRecord({...base,attention:bad}),/transport-attention/);
  assert.throws(()=>formTapeRecord({...base,attention:{...attention,apiKey:"secret"}}),/credential-material-forbidden/);
});
