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
