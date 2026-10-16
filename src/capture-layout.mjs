import { join } from "node:path";

export function resolveSportsCaptureConfig(env = process.env) {
  const root = env.KALSHI_SPORTS_TAPE_ROOT || "/var/lib/kalshi-sports-research/tapes";
  const maxMarkets = Number(env.KALSHI_SPORTS_MAX_MARKETS || "12");
  const maxMilestones = Number(env.KALSHI_SPORTS_MAX_MILESTONES || "6");

  if (typeof root !== "string" || root.trim() === "") throw new TypeError("sports-tape-root-required");
  if (!Number.isInteger(maxMarkets) || maxMarkets < 1 || maxMarkets > 100) {
    throw new RangeError("invalid-sports-market-bound");
  }
  if (!Number.isInteger(maxMilestones) || maxMilestones < 1 || maxMilestones > 50) {
    throw new RangeError("invalid-sports-milestone-bound");
  }

  return Object.freeze({ root, maxMarkets, maxMilestones });
}

export function dailySportsTapePath(root, observedAt) {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError("sports-tape-root-required");
  const time = new Date(observedAt);
  if (!Number.isFinite(time.getTime())) throw new TypeError("valid-observed-at-required");
  return join(root, time.toISOString().slice(0, 10) + ".jsonl");
}
