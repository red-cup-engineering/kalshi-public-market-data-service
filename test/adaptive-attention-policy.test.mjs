import assert from "node:assert/strict";
import test from "node:test";

import {
  formAdaptiveAttentionState,
  markAdaptiveMarketBaseline,
  normalizeAdaptiveAttentionState,
  observeAdaptiveEventSet,
  planAdaptiveAttention,
  selectAdaptiveTriggerEvents,
} from "../src/adaptive-attention-policy.mjs";

test("new tape seeds event baseline without triggering a burst", () => {
  const state = formAdaptiveAttentionState({ now: "2026-10-03T20:00:00Z" });
  const result = observeAdaptiveEventSet(state, {
    tapePath: "/tapes/2026-10-03.jsonl",
    eventIds: ["old-a", "old-b"],
    now: "2026-10-03T20:00:05Z",
  });

  assert.equal(result.transition, "tape-baseline");
  assert.equal(result.state.mode, "idle");
  assert.deepEqual(result.state.seenEventIds, ["old-a", "old-b"]);
});

test("new stable occurrence starts dense follow-through", () => {
  let state = formAdaptiveAttentionState({
    tapePath: "/tapes/2026-10-03.jsonl",
    observedEventIds: ["old-a"],
    now: "2026-10-03T20:00:00Z",
  });

  const result = observeAdaptiveEventSet(state, {
    tapePath: state.tapePath,
    eventIds: ["old-a", "new-shot"],
    now: "2026-10-03T20:00:10Z",
    followThroughMs: 125_000,
  });
  state = result.state;

  assert.equal(result.transition, "burst-started");
  assert.deepEqual(result.newEventIds, ["new-shot"]);
  assert.equal(state.mode, "burst");
  assert.equal(state.burstUntil, "2026-10-03T20:02:15.000Z");

  const plan = planAdaptiveAttention(state, {
    now: "2026-10-03T20:00:15Z",
  });
  assert.equal(plan.action, "full-sample");
  assert.equal(plan.marketBaselineDue, false);
});

test("new occurrence during burst extends follow-through but respects hard cap", () => {
  let state = formAdaptiveAttentionState({
    tapePath: "/tapes/2026-10-03.jsonl",
    observedEventIds: ["a"],
    now: "2026-10-03T20:00:00Z",
  });
  state = observeAdaptiveEventSet(state, {
    tapePath: state.tapePath,
    eventIds: ["a", "b"],
    now: "2026-10-03T20:00:10Z",
    followThroughMs: 125_000,
    maxBurstMs: 180_000,
  }).state;

  const extended = observeAdaptiveEventSet(state, {
    tapePath: state.tapePath,
    eventIds: ["a", "b", "c"],
    now: "2026-10-03T20:02:00Z",
    followThroughMs: 125_000,
    maxBurstMs: 180_000,
  });

  assert.equal(extended.transition, "burst-extended");
  assert.equal(extended.state.burstUntil, "2026-10-03T20:03:10.000Z");
});

test("burst returns to idle after follow-through expires", () => {
  let state = formAdaptiveAttentionState({
    tapePath: "/tapes/2026-10-03.jsonl",
    observedEventIds: [],
    now: "2026-10-03T20:00:00Z",
  });
  state = observeAdaptiveEventSet(state, {
    tapePath: state.tapePath,
    eventIds: ["goal"],
    now: "2026-10-03T20:00:05Z",
    followThroughMs: 10_000,
    maxBurstMs: 20_000,
  }).state;

  const done = observeAdaptiveEventSet(state, {
    tapePath: state.tapePath,
    eventIds: ["goal"],
    now: "2026-10-03T20:00:16Z",
    followThroughMs: 10_000,
    maxBurstMs: 20_000,
  });

  assert.equal(done.transition, "burst-completed");
  assert.equal(done.state.mode, "idle");
});

test("idle plan buys cheap sentry and only periodic market baseline", () => {
  let state = formAdaptiveAttentionState({
    tapePath: "/tapes/2026-10-03.jsonl",
    now: "2026-10-03T20:00:00Z",
  });

  let plan = planAdaptiveAttention(state, {
    now: "2026-10-03T20:00:00Z",
    marketBaselineIntervalMs: 15_000,
  });
  assert.equal(plan.action, "event-sentry");
  assert.equal(plan.marketBaselineDue, true);

  state = markAdaptiveMarketBaseline(state, {
    at: "2026-10-03T20:00:00Z",
  });
  plan = planAdaptiveAttention(state, {
    now: "2026-10-03T20:00:10Z",
    marketBaselineIntervalMs: 15_000,
  });
  assert.equal(plan.marketBaselineDue, false);

  plan = planAdaptiveAttention(state, {
    now: "2026-10-03T20:00:16Z",
    marketBaselineIntervalMs: 15_000,
  });
  assert.equal(plan.marketBaselineDue, true);
});

test("persisted policy state normalizes without changing seen-event identity", () => {
  const state = normalizeAdaptiveAttentionState({
    type: "KalshiAdaptiveAttentionState",
    schemaVersion: 1,
    tapePath: "/tapes/2026-10-03.jsonl",
    mode: "idle",
    seenEventIds: ["b", "a", "b"],
    burstStartedAt: null,
    burstUntil: null,
    lastTriggerAt: null,
    lastMarketBaselineAt: null,
    updatedAt: "2026-10-03T20:00:00Z",
  });
  assert.deepEqual(state.seenEventIds, ["b", "a"]);
});


test("active burst survives UTC tape rollover", () => {
  let state = formAdaptiveAttentionState({
    tapePath: "/tapes/2026-10-03.jsonl",
    observedEventIds: ["old-event"],
    now: "2026-10-03T23:59:50Z",
  });
  state = observeAdaptiveEventSet(state, {
    tapePath: state.tapePath,
    eventIds: ["old-event", "trigger"],
    now: "2026-10-03T23:59:55Z",
    followThroughMs: 125_000,
  }).state;

  const rolled = observeAdaptiveEventSet(state, {
    tapePath: "/tapes/2026-10-04.jsonl",
    eventIds: [],
    now: "2026-10-04T00:00:02Z",
    followThroughMs: 125_000,
  });

  assert.equal(rolled.transition, "steady");
  assert.equal(rolled.state.mode, "burst");
  assert.equal(rolled.state.tapePath, "/tapes/2026-10-04.jsonl");
  assert.equal(rolled.state.burstUntil, "2026-10-04T00:02:00.000Z");
});

test("incremental detector event across UTC rollover can extend an active burst", () => {
  let state = formAdaptiveAttentionState({
    tapePath: "/tapes/2026-10-03.jsonl",
    observedEventIds: ["old-event"],
    now: "2026-10-03T23:59:50Z",
  });
  state = observeAdaptiveEventSet(state, {
    tapePath: state.tapePath,
    eventIds: ["old-event", "trigger"],
    now: "2026-10-03T23:59:55Z",
    followThroughMs: 30_000,
    maxBurstMs: 120_000,
  }).state;

  const rolled = observeAdaptiveEventSet(state, {
    tapePath: "/tapes/2026-10-04.jsonl",
    eventIds: ["midnight-goal"],
    now: "2026-10-04T00:00:10Z",
    followThroughMs: 30_000,
    maxBurstMs: 120_000,
  });

  assert.equal(rolled.transition, "burst-extended");
  assert.deepEqual(rolled.newEventIds, ["midnight-goal"]);
  assert.equal(rolled.state.tapePath, "/tapes/2026-10-04.jsonl");
  assert.equal(rolled.state.burstUntil, "2026-10-04T00:00:40.000Z");
});

test("idle UTC rollover does not falsely trigger without incremental detector events", () => {
  const state = formAdaptiveAttentionState({
    tapePath: "/tapes/2026-10-03.jsonl",
    observedEventIds: ["known"],
    now: "2026-10-03T23:59:55Z",
  });

  const rolled = observeAdaptiveEventSet(state, {
    tapePath: "/tapes/2026-10-04.jsonl",
    eventIds: [],
    now: "2026-10-04T00:00:02Z",
  });

  assert.equal(rolled.transition, "steady");
  assert.equal(rolled.state.mode, "idle");
  assert.equal(rolled.state.tapePath, "/tapes/2026-10-04.jsonl");
});


test("adaptive trigger admission is limited to current watchset and recent observation gaps", () => {
  const selection = selectAdaptiveTriggerEvents([
    {
      eventId: "fresh-current",
      milestoneId: "m-current",
      detectionIntervalMs: 5_000,
    },
    {
      eventId: "stale-current",
      milestoneId: "m-current",
      detectionIntervalMs: 90_000,
    },
    {
      eventId: "fresh-old-watchset",
      milestoneId: "m-old",
      detectionIntervalMs: 5_000,
    },
    {
      eventId: "unknown-gap",
      milestoneId: "m-current",
      detectionIntervalMs: null,
    },
  ], {
    milestoneIds: ["m-current"],
    maxDetectionIntervalMs: 30_000,
  });

  assert.equal(selection.currentEventCount, 3);
  assert.deepEqual(
    selection.eligible.map((event) => event.eventId),
    ["fresh-current"],
  );
  assert.deepEqual(
    selection.ignoredLongGap.map((event) => event.eventId),
    ["stale-current", "unknown-gap"],
  );
});

test('negative or non-finite detection intervals cannot trigger sampling', () => {
  for (const detectionIntervalMs of [-1, -5000, -Infinity, Infinity, NaN, null, '5']) {
    const event = { eventId: 'event:test', milestoneId: 'milestone:test', detectionIntervalMs };
    const result = selectAdaptiveTriggerEvents([event], { milestoneIds: ['milestone:test'] });
    assert.equal(result.currentEventCount, 1);
    assert.deepEqual(result.eligible, []);
    assert.deepEqual(result.ignoredLongGap, [event]);
  }
  for (const detectionIntervalMs of [0, 1, 30_000]) {
    assert.equal(selectAdaptiveTriggerEvents([{ eventId: 'event:test', milestoneId: 'milestone:test', detectionIntervalMs }], { milestoneIds: ['milestone:test'] }).eligible.length, 1);
  }
});

test('invalid current time never returns a plan or corrupts persistent state', () => {
  const state = formAdaptiveAttentionState({ tapePath: 'tape', now: '2026-10-11T00:00:00.000Z' });
  for (const now of ['invalid', '', null, 0, false, {}, [], Symbol('time')]) {
    assert.throws(() => planAdaptiveAttention(state, { now }), /valid-adaptive-plan-time-required/);
    for (const eventIds of [[], ['new:event']]) {
      assert.throws(() => observeAdaptiveEventSet(state, { tapePath: 'tape', now, eventIds }), /valid-adaptive-observation-time-required/);
    }
  }
  assert.equal(state.updatedAt, '2026-10-11T00:00:00.000Z');
  assert.deepEqual(state.seenEventIds, []);
});

test('sparse and inherited event identities never become persisted IDs', () => {
  const hole = new Array(1), trailing = ['event:1']; trailing.length = 2;
  const inherited = Object.setPrototypeOf(new Array(1), Object.assign(Object.create(Array.prototype), { 0: 'event:1' }));
  const state = formAdaptiveAttentionState({ tapePath: 'tape', now: '2026-10-11T00:00:00.000Z' });
  for (const ids of [hole, trailing, inherited]) {
    assert.throws(() => formAdaptiveAttentionState({ observedEventIds: ids }), /valid-event-id-array-required/);
    assert.throws(() => observeAdaptiveEventSet(state, { tapePath: 'tape', eventIds: ids }), /valid-event-id-array-required/);
    assert.throws(() => normalizeAdaptiveAttentionState({ ...state, seenEventIds: ids }), /valid-event-id-array-required/);
    assert.throws(() => selectAdaptiveTriggerEvents([], { milestoneIds: ids }), /valid-adaptive-trigger-selection-required/);
  }
});
