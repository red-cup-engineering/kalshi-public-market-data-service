#!/usr/bin/env node
import { listOpenSportsEvents } from "../src/public-market-data.mjs";

const maxPagesArg = process.argv.find((arg) => arg.startsWith("--max-pages="));
const maxPages = maxPagesArg ? Number(maxPagesArg.split("=", 2)[1]) : 5;

const result = await listOpenSportsEvents({ maxPages });
process.stdout.write(JSON.stringify(result) + "\n");
if (result.type !== "Accept") process.exitCode = 1;
