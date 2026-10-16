const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
const parseTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;

const denseStrings = (values) => {
  if (!Array.isArray(values)) return false;
  for (let index = 0; index < values.length; index += 1) {
    if (!Object.hasOwn(values, index) || !nonEmpty(values[index])) return false;
  }
  return true;
};

function freezeState(state) {
  return Object.freeze({
    ...state,
    seenEventIds: Object.freeze([...state.seenEventIds]),
  });
}

function uniqueIds(values) {
  if (!denseStrings(values)) {
    throw new TypeError("valid-event-id-array-required");
  }
  return [...new Set(values)];
}

function validPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(name);
  return value;
}

export function formAdaptiveAttentionState({
  tapePath = null,
  observedEventIds = [],
  now = new Date().toISOString(),
} = {}) {
  if (tapePath !== null && !nonEmpty(tapePath)) throw new TypeError("valid-tape-path-required");
  if (!Number.isFinite(parseTime(now))) throw new TypeError("valid-adaptive-state-time-required");

  return freezeState({
    type: "KalshiAdaptiveAttentionState",
    schemaVersion: 1,
    tapePath,
    mode: "idle",
    seenEventIds: uniqueIds(observedEventIds),
    burstStartedAt: null,
    burstUntil: null,
    lastTriggerAt: null,
    lastMarketBaselineAt: null,
    updatedAt: now,
  });
}

export function normalizeAdaptiveAttentionState(value, {
  now = new Date().toISOString(),
} = {}) {
  if (!value || typeof value !== "object") {
    return formAdaptiveAttentionState({ now });
  }
  if (value.type !== "KalshiAdaptiveAttentionState" || value.schemaVersion !== 1) {
    throw new TypeError("unsupported-adaptive-attention-state");
  }
  if (!["idle", "burst"].includes(value.mode)) throw new TypeError("valid-adaptive-mode-required");
  if (!Number.isFinite(parseTime(value.updatedAt))) throw new TypeError("valid-adaptive-updated-at-required");
  if (value.tapePath !== null && !nonEmpty(value.tapePath)) throw new TypeError("valid-tape-path-required");
  const seenEventIds = uniqueIds(value.seenEventIds ?? []);

  if (value.mode === "burst") {
    if (!Number.isFinite(parseTime(value.burstStartedAt)) ||
        !Number.isFinite(parseTime(value.burstUntil))) {
      throw new TypeError("valid-burst-times-required");
    }
  }

  return freezeState({
    type: value.type,
    schemaVersion: 1,
    tapePath: value.tapePath ?? null,
    mode: value.mode,
    seenEventIds,
    burstStartedAt: value.burstStartedAt ?? null,
    burstUntil: value.burstUntil ?? null,
    lastTriggerAt: value.lastTriggerAt ?? null,
    lastMarketBaselineAt: value.lastMarketBaselineAt ?? null,
    updatedAt: value.updatedAt,
  });
}

export function planAdaptiveAttention(state, {
  now = new Date().toISOString(),
  marketBaselineIntervalMs = 15_000,
} = {}) {
  const normalized = normalizeAdaptiveAttentionState(state, { now });
  const nowMs = parseTime(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("valid-adaptive-plan-time-required");
  validPositiveInteger(marketBaselineIntervalMs, "positive-market-baseline-interval-required");

  const burstUntilMs = parseTime(normalized.burstUntil);
  const burstActive = normalized.mode === "burst" &&
    Number.isFinite(burstUntilMs) &&
    nowMs < burstUntilMs;

  const lastMarketMs = parseTime(normalized.lastMarketBaselineAt);
  const marketBaselineDue = !Number.isFinite(lastMarketMs) ||
    nowMs - lastMarketMs >= marketBaselineIntervalMs;

  return Object.freeze({
    now,
    action: burstActive ? "full-sample" : "event-sentry",
    marketBaselineDue: !burstActive && marketBaselineDue,
    burstActive,
    burstRemainingMs: burstActive ? burstUntilMs - nowMs : 0,
  });
}

export function observeAdaptiveEventSet(state, {
  tapePath,
  eventIds = [],
  now = new Date().toISOString(),
  followThroughMs = 125_000,
  maxBurstMs = 600_000,
} = {}) {
  const normalized = normalizeAdaptiveAttentionState(state, { now });
  if (!nonEmpty(tapePath)) throw new TypeError("valid-tape-path-required");
  const ids = uniqueIds(eventIds);
  const nowMs = parseTime(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("valid-adaptive-observation-time-required");
  validPositiveInteger(followThroughMs, "positive-follow-through-required");
  validPositiveInteger(maxBurstMs, "positive-max-burst-required");
  if (maxBurstMs < followThroughMs) throw new RangeError("max-burst-must-cover-follow-through");

  // Only the very first observed tape is a blind baseline. Later UTC-day
  // tape rollover preserves policy state: the incremental detector carries
  // stable occurrence identity across files and can therefore surface a
  // genuine boundary event without replaying old cumulative history.
  if (normalized.tapePath === null) {
    return Object.freeze({
      transition: "tape-baseline",
      newEventIds: Object.freeze([]),
      state: freezeState({
        ...normalized,
        tapePath,
        mode: "idle",
        seenEventIds: ids,
        burstStartedAt: null,
        burstUntil: null,
        lastTriggerAt: null,
        updatedAt: now,
      }),
    });
  }

  const seen = new Set(normalized.seenEventIds);
  const newEventIds = ids.filter((id) => !seen.has(id));
  for (const id of ids) seen.add(id);

  const existingUntilMs = parseTime(normalized.burstUntil);
  const existingStartMs = parseTime(normalized.burstStartedAt);
  const burstWasActive = normalized.mode === "burst" &&
    Number.isFinite(existingUntilMs) &&
    nowMs < existingUntilMs;

  if (newEventIds.length > 0) {
    const burstStartedAt = burstWasActive
      ? normalized.burstStartedAt
      : now;
    const burstStartMs = burstWasActive && Number.isFinite(existingStartMs)
      ? existingStartMs
      : nowMs;
    const capMs = burstStartMs + maxBurstMs;
    const requestedUntilMs = nowMs + followThroughMs;
    const burstUntilMs = Math.min(
      capMs,
      burstWasActive && Number.isFinite(existingUntilMs)
        ? Math.max(existingUntilMs, requestedUntilMs)
        : requestedUntilMs,
    );

    return Object.freeze({
      transition: burstWasActive ? "burst-extended" : "burst-started",
      newEventIds: Object.freeze(newEventIds),
      state: freezeState({
        ...normalized,
        tapePath,
        mode: "burst",
        seenEventIds: [...seen],
        burstStartedAt,
        burstUntil: new Date(burstUntilMs).toISOString(),
        lastTriggerAt: now,
        updatedAt: now,
      }),
    });
  }

  if (normalized.mode === "burst" &&
      Number.isFinite(existingUntilMs) &&
      nowMs >= existingUntilMs) {
    return Object.freeze({
      transition: "burst-completed",
      newEventIds: Object.freeze([]),
      state: freezeState({
        ...normalized,
        tapePath,
        mode: "idle",
        seenEventIds: [...seen],
        burstStartedAt: null,
        burstUntil: null,
        updatedAt: now,
      }),
    });
  }

  return Object.freeze({
    transition: "steady",
    newEventIds: Object.freeze([]),
    state: freezeState({
      ...normalized,
      tapePath,
      seenEventIds: [...seen],
      updatedAt: now,
    }),
  });
}

export function markAdaptiveMarketBaseline(state, {
  at = new Date().toISOString(),
} = {}) {
  const normalized = normalizeAdaptiveAttentionState(state, { now: at });
  if (!Number.isFinite(parseTime(at))) throw new TypeError("valid-market-baseline-time-required");
  return freezeState({
    ...normalized,
    lastMarketBaselineAt: at,
    updatedAt: at,
  });
}


export function selectAdaptiveTriggerEvents(events = [], {
  milestoneIds = [],
  maxDetectionIntervalMs = 30_000,
} = {}) {
  if (!Array.isArray(events) ||
      !denseStrings(milestoneIds) ||
      !Number.isInteger(maxDetectionIntervalMs) ||
      maxDetectionIntervalMs <= 0) {
    throw new TypeError("valid-adaptive-trigger-selection-required");
  }

  const currentMilestones = new Set(milestoneIds);
  const current = events.filter((event) =>
    event &&
    nonEmpty(event.eventId) &&
    nonEmpty(event.milestoneId) &&
    currentMilestones.has(event.milestoneId));

  const eligible = current.filter((event) =>
    Number.isFinite(event.detectionIntervalMs) &&
    event.detectionIntervalMs >= 0 &&
    event.detectionIntervalMs <= maxDetectionIntervalMs);
  const ignoredLongGap = current.filter((event) =>
    !Number.isFinite(event.detectionIntervalMs) ||
    event.detectionIntervalMs < 0 ||
    event.detectionIntervalMs > maxDetectionIntervalMs);

  return Object.freeze({
    currentEventCount: current.length,
    eligible: Object.freeze(eligible),
    ignoredLongGap: Object.freeze(ignoredLongGap),
  });
}
