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
