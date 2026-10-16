import { createHash } from "node:crypto";

export const KALSHI_PUBLIC_BASE = "https://external-api.kalshi.com/trade-api/v2";

const MARKET_STATUS = new Set(["unopened", "open", "active", "paused", "closed", "settled"]);
const TRADABLE_MARKET_STATUS = new Set(["open", "active"]);
const EVENT_STATUS = new Set(["unopened", "open", "closed", "settled"]);
const TICKER = /^[A-Za-z0-9._:-]{1,128}$/;
const MILESTONE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

function boundedInteger(value, min, max, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name}-out-of-range`);
  }
  return value;
}

function ticker(value, name = "ticker") {
  if (!nonEmpty(value) || !TICKER.test(value)) throw new TypeError(`valid-${name}-required`);
  return value;
}

function milestoneId(value) {
  if (!nonEmpty(value) || !MILESTONE_ID.test(value)) throw new TypeError("valid-milestone-id-required");
  return value;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function semanticId(value) {
  return `ni:///sha-256;${createHash("sha256").update(canonical(value)).digest("base64url")}`;
}

function latestRetrievedAt(results) {
  const times = results
    .map((result) => result?.retrievedAt)
    .filter((value) => Number.isFinite(Date.parse(value)));
  if (times.length === 0) throw new TypeError("accepted-component-retrieval-time-required");
  return new Date(Math.max(...times.map((value) => Date.parse(value)))).toISOString();
}

async function publicGet(path, params = new URLSearchParams(), {
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  clock = () => new Date(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch-implementation-required");
  if (typeof clock !== "function") throw new TypeError("clock-required");
  if (!path.startsWith("/") || path.includes("://")) throw new TypeError("relative-api-path-required");

  const url = new URL(KALSHI_PUBLIC_BASE + path);
  for (const [key, value] of params) url.searchParams.append(key, value);

  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return Object.freeze({
      type: "Reject",
      code: "network-error",
      detail: error instanceof Error ? error.message : String(error),
      venueWrite: false,
    });
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return Object.freeze({
      type: "Reject",
      code: `http-${response.status}`,
      detail: payload?.message ?? payload?.error?.message ?? response.statusText,
      venueWrite: false,
    });
  }

  return Object.freeze({
    type: "Accept",
    source: url.toString(),
    retrievedAt: clock().toISOString(),
    object: payload,
  });
}

export async function getMarkets({
  limit = 100,
  cursor = null,
  status = null,
  eventTicker = null,
  seriesTicker = null,
  tickers = null,
  mveFilter = "exclude",
  fetchImpl,
  clock,
} = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(boundedInteger(limit, 1, 1000, 100, "limit")));
  if (status !== null) {
    if (!MARKET_STATUS.has(status)) throw new TypeError("valid-market-status-required");
    params.set("status", status);
  }
  if (cursor) params.set("cursor", String(cursor));
  if (eventTicker !== null) params.set("event_ticker", ticker(eventTicker, "event-ticker"));
  if (seriesTicker !== null) params.set("series_ticker", ticker(seriesTicker, "series-ticker"));
  if (tickers !== null) {
    if (!Array.isArray(tickers) || tickers.length === 0 || tickers.length > 100) {
      throw new TypeError("bounded-market-tickers-required");
    }
    params.set("tickers", tickers.map((value) => ticker(value)).join(","));
  }
  if (!["only", "exclude"].includes(mveFilter)) throw new TypeError("valid-mve-filter-required");
  params.set("mve_filter", mveFilter);
  return publicGet("/markets", params, { fetchImpl, clock });
}

export async function getEvents({
  limit = 200,
  cursor = null,
  status = null,
  withNestedMarkets = false,
  withMilestones = false,
  minUpdatedTs = null,
  fetchImpl,
  clock,
} = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(boundedInteger(limit, 1, 200, 200, "limit")));
  if (status !== null) {
    if (!EVENT_STATUS.has(status)) throw new TypeError("valid-event-status-required");
    params.set("status", status);
  }
  if (cursor) params.set("cursor", String(cursor));
  params.set("with_nested_markets", withNestedMarkets ? "true" : "false");
  params.set("with_milestones", withMilestones ? "true" : "false");
  if (minUpdatedTs !== null) {
    params.set("min_updated_ts", String(boundedInteger(
      minUpdatedTs, 0, Number.MAX_SAFE_INTEGER, 0, "min-updated-ts",
    )));
  }
  return publicGet("/events", params, { fetchImpl, clock });
}

export async function getEvent(eventTicker, {
  withNestedMarkets = false,
  fetchImpl,
  clock,
} = {}) {
  const params = new URLSearchParams();
  params.set("with_nested_markets", withNestedMarkets ? "true" : "false");
  return publicGet(
    `/events/${encodeURIComponent(ticker(eventTicker, "event-ticker"))}`,
    params,
    { fetchImpl, clock },
  );
}

export const getMarket = (marketTicker, { fetchImpl, clock } = {}) =>
  publicGet(`/markets/${encodeURIComponent(ticker(marketTicker))}`, new URLSearchParams(), { fetchImpl, clock });

export const getOrderbook = (marketTicker, { fetchImpl, clock } = {}) =>
  publicGet(`/markets/${encodeURIComponent(ticker(marketTicker))}/orderbook`, new URLSearchParams(), { fetchImpl, clock });


export async function captureMarketOrderbookSentrySnapshot(marketTicker, {
  fetchImpl,
  clock = () => new Date(),
} = {}) {
  const t = ticker(marketTicker);
  const result = await getOrderbook(t, { fetchImpl, clock });
  if (result.type !== "Accept") return result;

  const observedAt = clock().toISOString();
  const body = Object.freeze({
    provider: "Kalshi",
    kind: "MarketOrderbookSentrySnapshot",
    attentionMode: "orderbook-sentry",
    transport: "rest-poll",
    ticker: t,
    observedAt,
    orderbook: result.object?.orderbook_fp ?? null,
    provenance: Object.freeze({
      orderbook: result.source,
    }),
  });

  return Object.freeze({
    type: "Accept",
    id: semanticId(body),
    object: body,
  });
}

export async function getTrades({
  marketTicker = null,
  limit = 100,
  cursor = null,
  minTs = null,
  maxTs = null,
  fetchImpl,
  clock,
} = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(boundedInteger(limit, 1, 1000, 100, "limit")));
  if (marketTicker !== null) params.set("ticker", ticker(marketTicker));
  if (cursor) params.set("cursor", String(cursor));
  if (minTs !== null) params.set("min_ts", String(boundedInteger(minTs, 0, Number.MAX_SAFE_INTEGER, 0, "min-ts")));
  if (maxTs !== null) params.set("max_ts", String(boundedInteger(maxTs, 0, Number.MAX_SAFE_INTEGER, 0, "max-ts")));
  return publicGet("/markets/trades", params, { fetchImpl, clock });
}

export async function getMilestones({
  limit = 500,
  cursor = null,
  minimumStartDate = null,
  category = null,
  competition = null,
  type = null,
  relatedEventTicker = null,
  minUpdatedTs = null,
  fetchImpl,
  clock,
} = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(boundedInteger(limit, 1, 500, 500, "milestone-limit")));
  if (cursor) params.set("cursor", String(cursor));
  if (minimumStartDate !== null) {
    if (!Number.isFinite(Date.parse(minimumStartDate))) {
      throw new TypeError("valid-milestone-minimum-start-date-required");
    }
    params.set("minimum_start_date", new Date(minimumStartDate).toISOString());
  }
  if (category !== null) params.set("category", String(category));
  if (competition !== null) params.set("competition", String(competition));
  if (type !== null) params.set("type", String(type));
  if (relatedEventTicker !== null) {
    params.set("related_event_ticker", ticker(relatedEventTicker, "related-event-ticker"));
  }
  if (minUpdatedTs !== null) {
    params.set("min_updated_ts", String(boundedInteger(
      minUpdatedTs, 0, Number.MAX_SAFE_INTEGER, 0, "milestone-min-updated-ts",
    )));
  }
  return publicGet("/milestones", params, { fetchImpl, clock });
}

export async function listSportsMilestones({
  minimumStartDate,
  maxPages = 4,
  fetchImpl,
  clock,
} = {}) {
  if (!Number.isFinite(Date.parse(minimumStartDate))) {
    throw new TypeError("valid-milestone-minimum-start-date-required");
  }
  const pageLimit = boundedInteger(maxPages, 1, 10, 4, "milestone-max-pages");
  const milestonesById = new Map();
  let cursor = null;
  let lastRetrievedAt = null;

  for (let page = 0; page < pageLimit; page += 1) {
    const result = await getMilestones({
      limit: 500,
      cursor,
      minimumStartDate,
      category: "Sports",
      fetchImpl,
      clock,
    });
    if (result.type !== "Accept") return result;
    lastRetrievedAt = result.retrievedAt;
    for (const milestone of Array.isArray(result.object?.milestones) ? result.object.milestones : []) {
      if (nonEmpty(milestone?.id)) milestonesById.set(milestone.id, milestone);
    }
    cursor = result.object?.cursor || null;
    if (!cursor) break;
  }

  const body = Object.freeze({
    provider: "Kalshi",
    kind: "SportsMilestonesSnapshot",
    retrievedAt: lastRetrievedAt,
    observedAt: lastRetrievedAt,
    minimumStartDate: new Date(minimumStartDate).toISOString(),
    milestones: Object.freeze([...milestonesById.values()]),
    truncated: Boolean(cursor),
  });
  return Object.freeze({ type: "Accept", id: semanticId(body), object: body });
}

export async function listOpenSportsEvents({
  maxPages = 5,
  milestoneMaxPages = 4,
  milestoneLookbackHours = 12,
  fetchImpl,
  clock = () => new Date(),
} = {}) {
  const pageLimit = boundedInteger(maxPages, 1, 10, 5, "max-pages");
  const lookbackHours = Number(milestoneLookbackHours);
  if (!Number.isFinite(lookbackHours) || lookbackHours < 0 || lookbackHours > 168) {
    throw new RangeError("milestone-lookback-hours-out-of-range");
  }

  const events = [];
  let cursor = null;
  let lastRetrievedAt = null;

  for (let page = 0; page < pageLimit; page += 1) {
    const result = await getEvents({
      status: "open",
      withNestedMarkets: true,
      withMilestones: false,
      cursor,
      fetchImpl,
      clock,
    });
    if (result.type !== "Accept") return result;
    lastRetrievedAt = result.retrievedAt;
    for (const event of Array.isArray(result.object?.events) ? result.object.events : []) {
      if (String(event?.category ?? "").toLowerCase() === "sports") events.push(event);
    }
    cursor = result.object?.cursor || null;
    if (!cursor) break;
  }

  const milestoneNow = clock();
  if (!(milestoneNow instanceof Date) || !Number.isFinite(milestoneNow.getTime())) {
    throw new TypeError("clock-must-return-valid-date");
  }
  const minimumStartDate = new Date(
    milestoneNow.getTime() - lookbackHours * 60 * 60 * 1000,
  ).toISOString();
  const milestonesResult = await listSportsMilestones({
    minimumStartDate,
    maxPages: milestoneMaxPages,
    fetchImpl,
    clock,
  });
  if (milestonesResult.type !== "Accept") return milestonesResult;

  const milestones = milestonesResult.object.milestones;

  const observedAt = milestonesResult.object.observedAt ?? lastRetrievedAt;
  const body = Object.freeze({
    provider: "Kalshi",
    kind: "OpenSportsEventsSnapshot",
    retrievedAt: observedAt,
    observedAt,
    events: Object.freeze(events),
    milestones: Object.freeze(milestones),
    eventPagesTruncated: Boolean(cursor),
    milestonePagesTruncated: milestonesResult.object.truncated,
    milestoneMinimumStartDate: minimumStartDate,
  });
  return Object.freeze({ type: "Accept", id: semanticId(body), object: body });
}

export async function captureMarketSnapshot(marketTicker, {
  tradeLimit = 100,
  fetchImpl,
  clock,
} = {}) {
  const t = ticker(marketTicker);
  const [market, orderbook, trades] = await Promise.all([
    getMarket(t, { fetchImpl, clock }),
    getOrderbook(t, { fetchImpl, clock }),
    getTrades({ marketTicker: t, limit: tradeLimit, fetchImpl, clock }),
  ]);
  const failures = [market, orderbook, trades].filter((result) => result.type !== "Accept");
  if (failures.length > 0) {
    return Object.freeze({
      type: "Reject",
      code: "incomplete-market-snapshot",
      failures: Object.freeze(failures),
      venueWrite: false,
    });
  }

  const observedAt = latestRetrievedAt([market, orderbook, trades]);
  const body = Object.freeze({
    provider: "Kalshi",
    kind: "PublicMarketSnapshot",
    transport: "rest-poll",
    ticker: t,
    retrievedAt: observedAt,
    observedAt,
    market: market.object?.market ?? null,
    orderbook: orderbook.object?.orderbook_fp ?? null,
    trades: Object.freeze(Array.isArray(trades.object?.trades) ? trades.object.trades : []),
    availability: Object.freeze({
      marketRetrievedAt: market.retrievedAt,
      orderbookRetrievedAt: orderbook.retrievedAt,
      tradesRetrievedAt: trades.retrievedAt,
      allAvailableAt: observedAt,
    }),
    provenance: Object.freeze({
      market: market.source,
      orderbook: orderbook.source,
      trades: trades.source,
    }),
  });
  return Object.freeze({ type: "Accept", id: semanticId(body), object: body });
}


export async function getSportsFilters({ fetchImpl, clock } = {}) {
  return publicGet("/search/filters_by_sport", new URLSearchParams(), { fetchImpl, clock });
}

export async function getMilestoneLiveData(id, {
  includePlayerStats = false,
  fetchImpl,
  clock,
} = {}) {
  const params = new URLSearchParams();
  if (includePlayerStats) params.set("include_player_stats", "true");
  return publicGet(
    `/live_data/milestone/${encodeURIComponent(milestoneId(id))}`,
    params,
    { fetchImpl, clock },
  );
}

export async function getGameStats(id, { fetchImpl, clock } = {}) {
  return publicGet(
    `/live_data/milestone/${encodeURIComponent(milestoneId(id))}/game_stats`,
    new URLSearchParams(),
    { fetchImpl, clock },
  );
}


export async function captureMilestoneEventSentrySnapshot(id, {
  fetchImpl,
  clock,
} = {}) {
  const mid = milestoneId(id);
  const stats = await getGameStats(mid, { fetchImpl, clock });
  if (stats.type !== "Accept") return stats;

  const observedAt = stats.retrievedAt ?? (clock ?? (() => new Date()))().toISOString();
  const pbp = stats.object?.pbp ?? null;
  const body = Object.freeze({
    provider: "Kalshi",
    kind: "MilestoneAttentionSnapshot",
    attentionMode: "event-sentry",
    transport: "rest-poll",
    milestoneId: mid,
    observedAt,
    liveData: null,
    gameStats: pbp,
    gameStatsStatus: pbp === null ? "empty" : "available",
    provenance: Object.freeze({
      liveData: null,
      gameStats: stats.source,
    }),
  });

  return Object.freeze({
    type: "Accept",
    id: semanticId(body),
    object: body,
  });
}

export async function captureMilestoneAttentionSnapshot(id, {
  includePlayerStats = true,
  includeGameStats = true,
  fetchImpl,
  clock,
} = {}) {
  const mid = milestoneId(id);
  const live = await getMilestoneLiveData(mid, {
    includePlayerStats,
    fetchImpl,
    clock,
  });
  if (live.type !== "Accept") return live;

  const gameStats = includeGameStats
    ? await getGameStats(mid, { fetchImpl, clock })
    : null;

  const acceptedComponents = [
    live,
    ...(gameStats?.type === "Accept" ? [gameStats] : []),
  ];
  const observedAt = latestRetrievedAt(acceptedComponents);
  const body = Object.freeze({
    provider: "Kalshi",
    kind: "MilestoneAttentionSnapshot",
    transport: "rest-poll",
    milestoneId: mid,
    observedAt,
    liveData: live.object?.live_data ?? null,
    gameStats: gameStats?.type === "Accept" ? gameStats.object?.pbp ?? null : null,
    gameStatsStatus: gameStats === null
      ? "not-requested"
      : gameStats.type === "Accept"
        ? "available"
        : "unavailable",
    availability: Object.freeze({
      liveDataRetrievedAt: live.retrievedAt,
      gameStatsRetrievedAt: gameStats?.type === "Accept" ? gameStats.retrievedAt : null,
      allAvailableAt: observedAt,
    }),
    provenance: Object.freeze({
      liveData: live.source,
      gameStats: gameStats?.type === "Accept" ? gameStats.source : null,
    }),
  });

  return Object.freeze({
    type: "Accept",
    id: semanticId(body),
    object: body,
  });
}


export function deriveActiveSportsWatchset(snapshot, {
  at = new Date().toISOString(),
  prestartMinutes = 30,
  postendMinutes = 30,
  maxMarkets = 50,
  maxMilestones = 20,
} = {}) {
  if (!snapshot || snapshot.kind !== "OpenSportsEventsSnapshot") {
    throw new TypeError("open-sports-events-snapshot-required");
  }
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new TypeError("valid-watchset-time-required");
  if (!Number.isFinite(prestartMinutes) || prestartMinutes < 0 ||
      !Number.isFinite(postendMinutes) || postendMinutes < 0 ||
      !Number.isInteger(maxMarkets) || maxMarkets < 1 || maxMarkets > 500 ||
      !Number.isInteger(maxMilestones) || maxMilestones < 1 || maxMilestones > 200) {
    throw new TypeError("valid-watchset-bounds-required");
  }

  const lower = atMs - postendMinutes * 60_000;
  const upper = atMs + prestartMinutes * 60_000;
  const activeMilestones = (Array.isArray(snapshot.milestones) ? snapshot.milestones : [])
    .filter((milestone) => {
      const start = Date.parse(milestone.start_date);
      const end = Date.parse(milestone.end_date);
      if (!Number.isFinite(start)) return false;
      return start <= upper && (!Number.isFinite(end) || end >= lower);
    })
    .sort((a, b) => Date.parse(a.start_date) - Date.parse(b.start_date))
    .slice(0, maxMilestones);

  const eventTickers = new Set();
  for (const milestone of activeMilestones) {
    for (const tickerValue of [
      ...(Array.isArray(milestone.related_event_tickers) ? milestone.related_event_tickers : []),
      ...(Array.isArray(milestone.primary_event_tickers) ? milestone.primary_event_tickers : []),
    ]) {
      eventTickers.add(tickerValue);
    }
  }

  const marketTickers = [];
  for (const event of Array.isArray(snapshot.events) ? snapshot.events : []) {
    if (!eventTickers.has(event.event_ticker)) continue;
    for (const market of Array.isArray(event.markets) ? event.markets : []) {
      if (nonEmpty(market?.ticker) && marketTickers.length < maxMarkets) marketTickers.push(market.ticker);
    }
  }

  return Object.freeze({
    at,
    milestoneIds: Object.freeze(activeMilestones.map((milestone) => milestone.id)),
    eventTickers: Object.freeze([...eventTickers]),
    marketTickers: Object.freeze([...new Set(marketTickers)]),
    truncatedMarkets: marketTickers.length >= maxMarkets,
    truncatedMilestones: activeMilestones.length >= maxMilestones,
  });
}


const WATCHSET_SELECTION_MODES = new Set([
  "temporal",
  "structured-reaction",
  "structured-executable-reaction",
  "structured-book-validated-reaction",
]);

function playByPlayCoverageLevel(milestone) {
  const coverage = milestone?.details?.coverage;
  if (!coverage || typeof coverage !== "object") return 0;
  if (coverage.extended_play_by_play === true) return 4;
  if (coverage.deeper_play_by_play === true) return 3;
  if (coverage.basic_play_by_play === true) return 2;
  if (coverage.play_by_play === true) return 1;
  return 0;
}

function milestoneAttentionDescriptor(milestone, atMs) {
  const startMs = Date.parse(milestone?.start_date);
  const endMs = Date.parse(milestone?.end_date);
  const status = String(milestone?.details?.status ?? "").toLowerCase();
  const liveStatus = /(?:^|_)(?:live|active|started|in_progress)(?:$|_)/u.test(status) ||
    status.includes("in progress");
  const prestartStatus = status === "scheduled" ||
    status === "not_started" ||
    status === "not started" ||
    status === "pre_game" ||
    status === "pregame";
  const coverageLevel = playByPlayCoverageLevel(milestone);
  const startedByClock = Number.isFinite(startMs) && startMs <= atMs;
  const reactionReadiness = (startedByClock ? 2 : 0) + (coverageLevel > 0 ? 1 : 0);
  return Object.freeze({
    milestoneId: milestone?.id ?? null,
    type: milestone?.type ?? null,
    startDate: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
    endDate: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
    startedByClock,
    endedByClock: Number.isFinite(endMs) && endMs < atMs,
    providerStatus: status || null,
    liveStatus,
    prestartStatus,
    playByPlayCoverageLevel: coverageLevel,
    reactionReadiness,
    distanceFromStartMs: Number.isFinite(startMs) ? Math.abs(startMs - atMs) : null,
  });
}

function marketDollar(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function finiteNonNegativeOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function describeMarketObservability(market) {
  if (!market || typeof market !== "object" || !nonEmpty(market.ticker)) {
    throw new TypeError("market-with-ticker-required");
  }

  const yesBid = marketDollar(market.yes_bid_dollars);
  const noBid = marketDollar(market.no_bid_dollars);
  const directYesAsk = marketDollar(market.yes_ask_dollars);
  const reciprocalYesAsk = noBid === null ? null : 1 - noBid;
  // Match downstream replay semantics: a visible NO bid is the executable
  // reciprocal YES ask. Use the summary's direct ask only as a fallback
  // when the complementary bid is absent.
  const yesAsk = reciprocalYesAsk ?? directYesAsk;
  const twoSided = yesBid !== null && noBid !== null;
  const spread = yesBid !== null && yesAsk !== null ? yesAsk - yesBid : null;

  return Object.freeze({
    ticker: market.ticker,
    twoSided,
    yesBid,
    yesAsk,
    noBid,
    spread,
    liquidityDollars: finiteNonNegativeOrNull(market.liquidity_dollars),
    volume24h: finiteNonNegativeOrNull(market.volume_24h_fp),
    yesBidSize: finiteNonNegativeOrNull(market.yes_bid_size_fp),
    yesAskSize: finiteNonNegativeOrNull(market.yes_ask_size_fp),
  });
}

function compareMarketObservability(left, right) {
  if (left.twoSided !== right.twoSided) return left.twoSided ? -1 : 1;

  const leftSpread = Number.isFinite(left.spread) && left.spread >= 0 ? left.spread : Infinity;
  const rightSpread = Number.isFinite(right.spread) && right.spread >= 0 ? right.spread : Infinity;
  if (leftSpread !== rightSpread) return leftSpread - rightSpread;

  const leftLiquidity = Number.isFinite(left.liquidityDollars) ? left.liquidityDollars : -Infinity;
  const rightLiquidity = Number.isFinite(right.liquidityDollars) ? right.liquidityDollars : -Infinity;
  if (leftLiquidity !== rightLiquidity) return rightLiquidity - leftLiquidity;

  const leftVolume = Number.isFinite(left.volume24h) ? left.volume24h : -Infinity;
  const rightVolume = Number.isFinite(right.volume24h) ? right.volume24h : -Infinity;
  if (leftVolume !== rightVolume) return rightVolume - leftVolume;

  return left.ticker.localeCompare(right.ticker);
}

function bestBidFromOrderbookLevels(levels) {
  if (!Array.isArray(levels)) return Object.freeze({ price: null, quantity: null });
  let bestPrice = null;
  let bestQuantity = null;
  for (const level of levels) {
    if (!Array.isArray(level) || level.length < 2) continue;
    const price = marketDollar(level[0]);
    const quantity = finiteNonNegativeOrNull(level[1]);
    if (price === null || quantity === null) continue;
    if (bestPrice === null || price > bestPrice) {
      bestPrice = price;
      bestQuantity = quantity;
    }
  }
  return Object.freeze({ price: bestPrice, quantity: bestQuantity });
}

export function describeOrderbookObservability(orderbook) {
  const yes = bestBidFromOrderbookLevels(orderbook?.yes_dollars);
  const no = bestBidFromOrderbookLevels(orderbook?.no_dollars);
  const yesAsk = no.price === null ? null : 1 - no.price;
  const spread = yes.price !== null && yesAsk !== null ? yesAsk - yes.price : null;
  const twoSided = yes.price !== null && no.price !== null &&
    spread !== null && spread >= 0;

  return Object.freeze({
    twoSided,
    yesBid: yes.price,
    noBid: no.price,
    yesAsk,
    spread: twoSided ? spread : null,
    yesBidQuantity: yes.quantity,
    noBidQuantity: no.quantity,
  });
}

function compareMilestoneAttention(left, right, selectionMode) {
  if (selectionMode === "structured-reaction" ||
      selectionMode === "structured-executable-reaction" ||
      selectionMode === "structured-book-validated-reaction") {
    if (left.reactionReadiness !== right.reactionReadiness) {
      return right.reactionReadiness - left.reactionReadiness;
    }
    if (left.playByPlayCoverageLevel !== right.playByPlayCoverageLevel) {
      return right.playByPlayCoverageLevel - left.playByPlayCoverageLevel;
    }
    if (left.startedByClock !== right.startedByClock) return left.startedByClock ? -1 : 1;
    if (left.liveStatus !== right.liveStatus) return left.liveStatus ? -1 : 1;
    if (left.prestartStatus !== right.prestartStatus) return left.prestartStatus ? 1 : -1;
  }

  const leftDistance = Number.isFinite(left.distanceFromStartMs) ? left.distanceFromStartMs : Infinity;
  const rightDistance = Number.isFinite(right.distanceFromStartMs) ? right.distanceFromStartMs : Infinity;
  if (leftDistance !== rightDistance) return leftDistance - rightDistance;
  return String(left.milestoneId ?? "").localeCompare(String(right.milestoneId ?? ""));
}

export async function resolveActiveSportsWatchset(snapshot, {
  at = new Date().toISOString(),
  prestartMinutes = 30,
  unknownEndMaxAgeMinutes = 360,
  maxMarkets = 50,
  maxMilestones = 20,
  maxMarketsPerMilestone = maxMarkets,
  selectionMode = "temporal",
  maxResearchSpreadDollars = 0.20,
  maxBookProbes = Math.min(maxMarkets * 2, 100),
  fetchImpl,
  clock,
} = {}) {
  if (!snapshot || snapshot.kind !== "OpenSportsEventsSnapshot") {
    throw new TypeError("open-sports-events-snapshot-required");
  }
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new TypeError("valid-watchset-time-required");
  if (!Number.isFinite(prestartMinutes) || prestartMinutes < 0 ||
      !Number.isFinite(unknownEndMaxAgeMinutes) || unknownEndMaxAgeMinutes < 1 ||
      !Number.isInteger(maxMarkets) || maxMarkets < 1 || maxMarkets > 500 ||
      !Number.isInteger(maxMilestones) || maxMilestones < 1 || maxMilestones > 200 ||
      !Number.isInteger(maxMarketsPerMilestone) ||
      maxMarketsPerMilestone < 1 ||
      maxMarketsPerMilestone > maxMarkets ||
      !WATCHSET_SELECTION_MODES.has(selectionMode) ||
      !Number.isFinite(maxResearchSpreadDollars) ||
      maxResearchSpreadDollars < 0 ||
      maxResearchSpreadDollars > 1 ||
      !Number.isInteger(maxBookProbes) ||
      maxBookProbes < 1 ||
      maxBookProbes > 500) {
    throw new TypeError("valid-watchset-bounds-and-selection-required");
  }

  const upper = atMs + prestartMinutes * 60_000;
  const unknownEndLower = atMs - unknownEndMaxAgeMinutes * 60_000;

  const eligible = (Array.isArray(snapshot.milestones) ? snapshot.milestones : [])
    .filter((milestone) => {
      const start = Date.parse(milestone.start_date);
      const end = Date.parse(milestone.end_date);
      if (!Number.isFinite(start) || start > upper) return false;
      return Number.isFinite(end) ? end >= atMs : start >= unknownEndLower;
    })
    .map((milestone) => Object.freeze({
      milestone,
      attention: milestoneAttentionDescriptor(milestone, atMs),
    }))
    .sort((a, b) => compareMilestoneAttention(a.attention, b.attention, selectionMode));

  const candidates = eligible.slice(0, maxMilestones);
  const marketTickers = [];
  const admittedMilestoneIds = [];
  const eventTickers = new Set();
  const discovery = [];
  const failures = [];
  const selection = [];
  let bookProbeCount = 0;

  for (let rank = 0; rank < candidates.length; rank += 1) {
    const { milestone, attention } = candidates[rank];
    const related = [...new Set([
      ...(Array.isArray(milestone.related_event_tickers) ? milestone.related_event_tickers : []),
      ...(Array.isArray(milestone.primary_event_tickers) ? milestone.primary_event_tickers : []),
    ].filter(nonEmpty))];

    let milestoneMarketCount = 0;
    let milestoneHasOpenMarket = false;

    for (const eventTicker of related) {
      const globalRemaining = maxMarkets - marketTickers.length;
      const milestoneRemaining = maxMarketsPerMilestone - milestoneMarketCount;
      if (globalRemaining <= 0 || milestoneRemaining <= 0) break;

      const candidateLimit = selectionMode === "structured-book-validated-reaction"
        ? Math.min(
          100,
          Math.max(globalRemaining, milestoneRemaining * 3),
          Math.max(1, maxBookProbes - bookProbeCount),
        )
        : Math.min(100, globalRemaining, milestoneRemaining);

      const result = await getMarkets({
        eventTicker,
        status: "open",
        limit: candidateLimit,
        mveFilter: "exclude",
        fetchImpl,
        clock,
      });
      if (result.type !== "Accept") {
        failures.push(Object.freeze({
          milestoneId: milestone.id,
          eventTicker,
          code: result.code,
        }));
        continue;
      }

      const markets = Array.isArray(result.object?.markets) ? result.object.markets : [];
      const openMarkets = markets
        .filter((market) => TRADABLE_MARKET_STATUS.has(market?.status) && nonEmpty(market?.ticker));
      const observabilityRanked = (selectionMode === "structured-reaction" ||
        selectionMode === "structured-executable-reaction" ||
        selectionMode === "structured-book-validated-reaction");
      const rankedMarkets = observabilityRanked
        ? openMarkets
          .map((market) => Object.freeze({
            market,
            observability: describeMarketObservability(market),
          }))
          .sort((a, b) => compareMarketObservability(a.observability, b.observability))
        : openMarkets.map((market) => Object.freeze({
          market,
          observability: describeMarketObservability(market),
        }));
      const openTickers = rankedMarkets.map((entry) => entry.market.ticker);
      const summaryGated = (selectionMode === "structured-executable-reaction" ||
        selectionMode === "structured-book-validated-reaction");
      const eligibleRankedMarkets = summaryGated
        ? rankedMarkets.filter((entry) =>
          entry.observability.twoSided &&
          Number.isFinite(entry.observability.spread) &&
          entry.observability.spread >= 0 &&
          entry.observability.spread <= maxResearchSpreadDollars)
        : rankedMarkets;
      const eligibleMarketTickers = eligibleRankedMarkets.map((entry) => entry.market.ticker);

      const bookProbes = [];
      let validatedRankedMarkets = eligibleRankedMarkets;
      if (selectionMode === "structured-book-validated-reaction") {
        validatedRankedMarkets = [];
        const needed = Math.min(globalRemaining, milestoneRemaining);

        for (const entry of eligibleRankedMarkets) {
          if (validatedRankedMarkets.length >= needed || bookProbeCount >= maxBookProbes) break;
          bookProbeCount += 1;

          const probe = await getOrderbook(entry.market.ticker, { fetchImpl, clock });
          if (probe.type !== "Accept") {
            failures.push(Object.freeze({
              milestoneId: milestone.id,
              eventTicker,
              marketTicker: entry.market.ticker,
              stage: "orderbook-probe",
              code: probe.code,
            }));
            bookProbes.push(Object.freeze({
              ticker: entry.market.ticker,
              accepted: false,
              code: probe.code,
              summaryObservability: entry.observability,
            }));
            continue;
          }

          const bookObservability = describeOrderbookObservability(probe.object?.orderbook_fp);
          const accepted = bookObservability.twoSided &&
            Number.isFinite(bookObservability.spread) &&
            bookObservability.spread <= maxResearchSpreadDollars;
          bookProbes.push(Object.freeze({
            ticker: entry.market.ticker,
            accepted,
            source: probe.source,
            summaryObservability: entry.observability,
            bookObservability,
          }));
          if (accepted) {
            validatedRankedMarkets.push(Object.freeze({
              ...entry,
              bookObservability,
            }));
          }
        }
      }

      const validatedMarketTickers = validatedRankedMarkets.map((entry) => entry.market.ticker);
      const selectedMarketTickers = [];
      const selectedMarketObservability = [];

      for (const entry of validatedRankedMarkets) {
        const marketTicker = entry.market.ticker;
        if (marketTickers.length >= maxMarkets ||
            milestoneMarketCount >= maxMarketsPerMilestone) break;
        if (marketTickers.includes(marketTicker)) continue;
        marketTickers.push(marketTicker);
        selectedMarketTickers.push(marketTicker);
        selectedMarketObservability.push(entry.bookObservability ?? entry.observability);
        milestoneMarketCount += 1;
      }

      if (selectedMarketTickers.length > 0) {
        milestoneHasOpenMarket = true;
        eventTickers.add(eventTicker);
      }

      discovery.push(Object.freeze({
        milestoneId: milestone.id,
        eventTicker,
        openMarketTickers: Object.freeze(openTickers),
        eligibleMarketTickers: Object.freeze(eligibleMarketTickers),
        validatedMarketTickers: Object.freeze(validatedMarketTickers),
        selectedMarketTickers: Object.freeze(selectedMarketTickers),
        bookProbes: Object.freeze(bookProbes),
        selectedMarketObservability: Object.freeze(selectedMarketObservability),
        openMarketObservability: Object.freeze(rankedMarkets.map((entry) => entry.observability)),
        attention,
        source: result.source,
      }));
    }

    const milestoneObservability = discovery
      .filter((entry) => entry.milestoneId === milestone.id)
      .flatMap((entry) => entry.selectedMarketObservability ?? []);
    const twoSidedMarketCount = milestoneObservability
      .filter((item) => item.twoSided).length;
    const finiteSpreads = milestoneObservability
      .map((item) => item.spread)
      .filter((value) => Number.isFinite(value) && value >= 0)
      .sort((a, b) => a - b);
    const medianSelectedSpread = finiteSpreads.length === 0
      ? null
      : finiteSpreads[Math.floor(finiteSpreads.length / 2)];

    selection.push(Object.freeze({
      ...attention,
      rank: rank + 1,
      relatedEventCount: related.length,
      admitted: milestoneHasOpenMarket,
      admittedMarketCount: milestoneMarketCount,
      twoSidedMarketCount,
      medianSelectedSpread,
    }));

    if (milestoneHasOpenMarket) admittedMilestoneIds.push(milestone.id);
    if (marketTickers.length >= maxMarkets) break;
  }

  return Object.freeze({
    at,
    selectionPolicy: Object.freeze({
      mode: selectionMode,
      maxMarkets,
      maxMilestones,
      maxMarketsPerMilestone,
      prestartMinutes,
      unknownEndMaxAgeMinutes,
      maxResearchSpreadDollars,
      maxBookProbes,
    }),
    milestoneIds: Object.freeze(admittedMilestoneIds),
    eventTickers: Object.freeze([...eventTickers]),
    marketTickers: Object.freeze(marketTickers),
    candidateMilestoneCount: candidates.length,
    eligibleMilestoneCount: eligible.length,
    selection: Object.freeze(selection),
    discovery: Object.freeze(discovery),
    failures: Object.freeze(failures),
    bookProbeCount,
    truncatedMarkets: marketTickers.length >= maxMarkets,
    truncatedMilestones: eligible.length > candidates.length,
  });
}

export const getSeries = (seriesTicker, { fetchImpl, clock } = {}) =>
  publicGet(
    `/series/${encodeURIComponent(ticker(seriesTicker, "series-ticker"))}`,
    new URLSearchParams(),
    { fetchImpl, clock },
  );

export async function getSeriesFeeChanges({
  seriesTicker,
  showHistorical = true,
  fetchImpl,
  clock,
} = {}) {
  const params = new URLSearchParams();
  if (seriesTicker !== null && seriesTicker !== undefined) {
    params.set("series_ticker", ticker(seriesTicker, "series-ticker"));
  }
  params.set("show_historical", showHistorical ? "true" : "false");
  return publicGet("/series/fee_changes", params, { fetchImpl, clock });
}

export async function getEventFeeChanges({
  eventTicker,
  limit = 100,
  cursor = null,
  fetchImpl,
  clock,
} = {}) {
  const params = new URLSearchParams();
  if (eventTicker !== null && eventTicker !== undefined) {
    params.set("event_ticker", ticker(eventTicker, "event-ticker"));
  }
  params.set("limit", String(boundedInteger(limit, 1, 200, 100, "limit")));
  if (cursor) params.set("cursor", String(cursor));
  return publicGet("/events/fee_changes", params, { fetchImpl, clock });
}

export async function captureEventFeeContext(event, {
  fetchImpl,
  clock,
  eventSource = "provided-event-record",
} = {}) {
  if (!event || !nonEmpty(event.event_ticker) || !nonEmpty(event.series_ticker)) {
    throw new TypeError("event-with-series-ticker-required");
  }

  const [series, seriesChanges, eventChanges] = await Promise.all([
    getSeries(event.series_ticker, { fetchImpl, clock }),
    getSeriesFeeChanges({
      seriesTicker: event.series_ticker,
      showHistorical: true,
      fetchImpl,
      clock,
    }),
    getEventFeeChanges({
      eventTicker: event.event_ticker,
      fetchImpl,
      clock,
    }),
  ]);

  const failures = [series, seriesChanges, eventChanges]
    .filter((result) => result.type !== "Accept");
  if (failures.length > 0) {
    return Object.freeze({
      type: "Reject",
      code: "incomplete-fee-context",
      failures: Object.freeze(failures),
      venueWrite: false,
    });
  }

  const observedAt = latestRetrievedAt([series, seriesChanges, eventChanges]);
  const seriesObject = series.object?.series ?? null;

  const body = Object.freeze({
    provider: "Kalshi",
    kind: "FeeContextSnapshot",
    transport: "rest-poll",
    observedAt,
    eventTicker: event.event_ticker,
    seriesTicker: event.series_ticker,
    current: Object.freeze({
      seriesFeeType: seriesObject?.fee_type ?? null,
      seriesFeeMultiplier: seriesObject?.fee_multiplier ?? null,
      eventFeeTypeOverride: event.fee_type_override ?? null,
      eventFeeMultiplierOverride: event.fee_multiplier_override ?? null,
    }),
    scheduledAndHistorical: Object.freeze({
      seriesFeeChanges: Object.freeze(
        Array.isArray(seriesChanges.object?.fee_changes)
          ? seriesChanges.object.fee_changes
          : [],
      ),
      eventFeeChanges: Object.freeze(
        Array.isArray(eventChanges.object?.fee_changes)
          ? eventChanges.object.fee_changes
          : [],
      ),
    }),
    availability: Object.freeze({
      seriesRetrievedAt: series.retrievedAt,
      seriesFeeChangesRetrievedAt: seriesChanges.retrievedAt,
      eventFeeChangesRetrievedAt: eventChanges.retrievedAt,
      allAvailableAt: observedAt,
    }),
    provenance: Object.freeze({
      series: series.source,
      seriesFeeChanges: seriesChanges.source,
      eventFeeChanges: eventChanges.source,
      event: eventSource,
    }),
  });

  return Object.freeze({
    type: "Accept",
    id: semanticId(body),
    object: body,
  });
}


export async function captureEventFeeContextByTicker(eventTicker, {
  fetchImpl,
  clock,
} = {}) {
  const t = ticker(eventTicker, "event-ticker");
  const eventResult = await getEvent(t, {
    withNestedMarkets: false,
    fetchImpl,
    clock,
  });
  if (eventResult.type !== "Accept") return eventResult;

  const event = eventResult.object?.event ?? null;
  if (!event || !nonEmpty(event.event_ticker) || !nonEmpty(event.series_ticker)) {
    return Object.freeze({
      type: "Reject",
      code: "event-fee-context-metadata-incomplete",
      eventTicker: t,
      source: eventResult.source,
      venueWrite: false,
    });
  }

  return captureEventFeeContext(event, {
    fetchImpl,
    clock,
    eventSource: eventResult.source,
  });
}


const CANDLESTICK_PERIODS = new Set([1, 60, 1440]);

function unixSeconds(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new TypeError(`valid-${name}-required`);
  }
  return value;
}

function candlestickQuery({
  startTs,
  endTs,
  periodInterval = 1,
  includeLatestBeforeStart = false,
} = {}) {
  const start = unixSeconds(startTs, "candlestick-start-ts");
  const end = unixSeconds(endTs, "candlestick-end-ts");
  if (end < start) throw new TypeError("candlestick-end-before-start");
  if (!CANDLESTICK_PERIODS.has(periodInterval)) {
    throw new TypeError("valid-candlestick-period-required");
  }

  const params = new URLSearchParams();
  params.set("start_ts", String(start));
  params.set("end_ts", String(end));
  params.set("period_interval", String(periodInterval));
  if (includeLatestBeforeStart) params.set("include_latest_before_start", "true");
  return params;
}

export function getHistoricalCutoff({ fetchImpl, clock } = {}) {
  return publicGet("/historical/cutoff", new URLSearchParams(), { fetchImpl, clock });
}

export function getMarketCandlesticks({
  seriesTicker,
  marketTicker,
  startTs,
  endTs,
  periodInterval = 1,
  includeLatestBeforeStart = false,
  fetchImpl,
  clock,
} = {}) {
  const series = ticker(seriesTicker, "series-ticker");
  const market = ticker(marketTicker, "market-ticker");
  const params = candlestickQuery({
    startTs,
    endTs,
    periodInterval,
    includeLatestBeforeStart,
  });
  return publicGet(
    `/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(market)}/candlesticks`,
    params,
    { fetchImpl, clock },
  );
}

export function getHistoricalMarketCandlesticks({
  marketTicker,
  startTs,
  endTs,
  periodInterval = 1,
  fetchImpl,
  clock,
} = {}) {
  const market = ticker(marketTicker, "market-ticker");
  const params = candlestickQuery({
    startTs,
    endTs,
    periodInterval,
    includeLatestBeforeStart: false,
  });
  return publicGet(
    `/historical/markets/${encodeURIComponent(market)}/candlesticks`,
    params,
    { fetchImpl, clock },
  );
}

export async function getMarketCandlesticksRouted({
  seriesTicker = null,
  marketTicker,
  marketSettledAt = null,
  cutoff = null,
  startTs,
  endTs,
  periodInterval = 1,
  includeLatestBeforeStart = false,
  fetchImpl,
  clock,
} = {}) {
  const market = ticker(marketTicker, "market-ticker");

  let cutoffObject = cutoff;
  if (cutoffObject === null && marketSettledAt !== null) {
    const result = await getHistoricalCutoff({ fetchImpl, clock });
    if (result.type !== "Accept") return result;
    cutoffObject = result.object;
  }

  const settledMs = marketSettledAt === null ? NaN : Date.parse(marketSettledAt);
  const cutoffMs = Date.parse(cutoffObject?.market_settled_ts ?? "");
  const useHistorical =
    Number.isFinite(settledMs) &&
    Number.isFinite(cutoffMs) &&
    settledMs < cutoffMs;

  if (useHistorical) {
    const result = await getHistoricalMarketCandlesticks({
      marketTicker: market,
      startTs,
      endTs,
      periodInterval,
      fetchImpl,
      clock,
    });
    if (result.type !== "Accept") return result;
    return Object.freeze({
      ...result,
      tier: "historical",
      cutoff: cutoffObject,
    });
  }

  if (!nonEmpty(seriesTicker)) {
    throw new TypeError("series-ticker-required-for-live-candlesticks");
  }
  const result = await getMarketCandlesticks({
    seriesTicker,
    marketTicker: market,
    startTs,
    endTs,
    periodInterval,
    includeLatestBeforeStart,
    fetchImpl,
    clock,
  });
  if (result.type !== "Accept") return result;
  return Object.freeze({
    ...result,
    tier: "live",
    cutoff: cutoffObject,
  });
}

function candleDollar(section, field) {
  if (!section || typeof section !== "object") return null;
  for (const key of [`${field}_dollars`, field]) {
    const value = section[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  }
  return null;
}

export function describeCandlestickProbability(candlestick) {
  if (!candlestick || typeof candlestick !== "object" ||
      !Number.isInteger(candlestick.end_period_ts)) {
    throw new TypeError("valid-candlestick-required");
  }

  const yesBid = candleDollar(candlestick.yes_bid, "close");
  const yesAsk = candleDollar(candlestick.yes_ask, "close");
  if (yesBid !== null && yesAsk !== null && yesAsk >= yesBid) {
    return Object.freeze({
      endPeriodTs: candlestick.end_period_ts,
      probabilityYes: (yesBid + yesAsk) / 2,
      basis: "bid-ask-midpoint",
      yesBid,
      yesAsk,
    });
  }

  const priceClose = candleDollar(candlestick.price, "close");
  if (priceClose !== null) {
    return Object.freeze({
      endPeriodTs: candlestick.end_period_ts,
      probabilityYes: priceClose,
      basis: "trade-price-close",
      yesBid,
      yesAsk,
    });
  }

  const previous = candleDollar(candlestick.price, "previous");
  if (previous !== null) {
    return Object.freeze({
      endPeriodTs: candlestick.end_period_ts,
      probabilityYes: previous,
      basis: "previous-trade-price",
      yesBid,
      yesAsk,
    });
  }

  return Object.freeze({
    endPeriodTs: candlestick.end_period_ts,
    probabilityYes: null,
    basis: "unavailable",
    yesBid,
    yesAsk,
  });
}

export function selectCandlestickProbabilityAtOrBefore(payload, asOfTs) {
  const cutoff = unixSeconds(asOfTs, "candlestick-as-of-ts");
  const candles = Array.isArray(payload?.candlesticks) ? payload.candlesticks : [];
  let best = null;

  for (const candle of candles) {
    if (!candle || !Number.isInteger(candle.end_period_ts) ||
        candle.end_period_ts > cutoff) continue;
    if (!best || candle.end_period_ts > best.end_period_ts) best = candle;
  }

  return best ? describeCandlestickProbability(best) : null;
}

export function formThreeWayMarketPrior({
  home,
  draw,
  away,
  asOfTs,
} = {}) {
  const selected = {
    home: selectCandlestickProbabilityAtOrBefore(home, asOfTs),
    draw: selectCandlestickProbabilityAtOrBefore(draw, asOfTs),
    away: selectCandlestickProbabilityAtOrBefore(away, asOfTs),
  };

  for (const outcome of ["home", "draw", "away"]) {
    if (!selected[outcome] || !Number.isFinite(selected[outcome].probabilityYes)) {
      throw new TypeError(`three-way-${outcome}-probability-unavailable`);
    }
  }

  const raw = {
    home: selected.home.probabilityYes,
    draw: selected.draw.probabilityYes,
    away: selected.away.probabilityYes,
  };
  const total = raw.home + raw.draw + raw.away;
  if (!(total > 0)) throw new TypeError("positive-three-way-probability-mass-required");

  return Object.freeze({
    type: "ThreeWayMarketPrior",
    asOfTs: unixSeconds(asOfTs, "three-way-prior-as-of-ts"),
    raw: Object.freeze(raw),
    normalized: Object.freeze({
      home: raw.home / total,
      draw: raw.draw / total,
      away: raw.away / total,
    }),
    overround: total - 1,
    observations: Object.freeze(selected),
  });
}


export async function captureThreeWayMarketPrior({
  home,
  draw,
  away,
  asOfTs,
  lookbackSeconds = 21_600,
  periodInterval = 1,
  fetchImpl,
  clock,
} = {}) {
  const cutoff = unixSeconds(asOfTs, "three-way-capture-as-of-ts");
  if (!Number.isInteger(lookbackSeconds) || lookbackSeconds < 60 || lookbackSeconds > 604_800) {
    throw new TypeError("valid-three-way-lookback-required");
  }

  const descriptors = { home, draw, away };
  for (const outcome of ["home", "draw", "away"]) {
    const descriptor = descriptors[outcome];
    if (!descriptor || !nonEmpty(descriptor.marketTicker)) {
      throw new TypeError(`three-way-${outcome}-market-required`);
    }
  }

  const startTs = Math.max(0, cutoff - lookbackSeconds);
  const entries = await Promise.all(
    ["home", "draw", "away"].map(async (outcome) => {
      const descriptor = descriptors[outcome];
      const result = await getMarketCandlesticksRouted({
        seriesTicker: descriptor.seriesTicker ?? null,
        marketTicker: descriptor.marketTicker,
        marketSettledAt: descriptor.marketSettledAt ?? null,
        cutoff: descriptor.cutoff ?? null,
        startTs,
        endTs: cutoff,
        periodInterval,
        includeLatestBeforeStart: true,
        fetchImpl,
        clock,
      });
      return [outcome, descriptor, result];
    }),
  );

  const failures = entries.filter(([, , result]) => result.type !== "Accept");
  if (failures.length > 0) {
    return Object.freeze({
      type: "Reject",
      code: "incomplete-three-way-candlestick-prior",
      failures: Object.freeze(failures.map(([outcome, descriptor, result]) => Object.freeze({
        outcome,
        marketTicker: descriptor.marketTicker,
        result,
      }))),
      venueWrite: false,
    });
  }

  const payloads = Object.fromEntries(
    entries.map(([outcome, , result]) => [outcome, result.object]),
  );
  const prior = formThreeWayMarketPrior({
    home: payloads.home,
    draw: payloads.draw,
    away: payloads.away,
    asOfTs: cutoff,
  });
  const observedAt = (clock ?? (() => new Date()))().toISOString();

  const body = Object.freeze({
    provider: "Kalshi",
    kind: "ThreeWayMarketPriorSnapshot",
    observedAt,
    asOfTs: cutoff,
    lookbackSeconds,
    periodInterval,
    markets: Object.freeze(Object.fromEntries(
      entries.map(([outcome, descriptor, result]) => [outcome, Object.freeze({
        marketTicker: descriptor.marketTicker,
        seriesTicker: descriptor.seriesTicker ?? null,
        marketSettledAt: descriptor.marketSettledAt ?? null,
        tier: result.tier,
        source: result.source,
      })]),
    )),
    prior,
  });

  return Object.freeze({
    type: "Accept",
    id: semanticId(body),
    object: body,
  });
}
