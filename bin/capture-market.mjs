#!/usr/bin/env node
import { captureMarketSnapshot } from "../src/public-market-data.mjs";

const ticker = process.argv[2];
if (!ticker || ticker.startsWith("-")) {
  process.stderr.write("usage: capture-market <ticker> [--trade-limit=N]\n");
  process.exit(2);
}

const tradeLimitArg = process.argv.find((arg) => arg.startsWith("--trade-limit="));
const tradeLimit = tradeLimitArg ? Number(tradeLimitArg.split("=", 2)[1]) : 100;

const result = await captureMarketSnapshot(ticker, { tradeLimit });
process.stdout.write(JSON.stringify(result) + "\n");
if (result.type !== "Accept") process.exitCode = 1;
