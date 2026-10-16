#!/usr/bin/env node
import { readTapeRecords } from "../src/research-tape.mjs";
import { auditResearchTape } from "../src/tape-audit.mjs";

const file = process.argv[2];
if (!file || file.startsWith("-")) {
  process.stderr.write("usage: audit-tape FILE [--expected-ms=N] [--gap-factor=N]\n");
  process.exit(2);
}
const expectedArg = process.argv.find((arg) => arg.startsWith("--expected-ms="));
const gapArg = process.argv.find((arg) => arg.startsWith("--gap-factor="));
const expectedIntervalMs = expectedArg ? Number(expectedArg.slice(14)) : 60_000;
const gapFactor = gapArg ? Number(gapArg.slice(13)) : 2.5;

const records = await readTapeRecords(file);
const audit = auditResearchTape(records, { expectedIntervalMs, gapFactor });
process.stdout.write(JSON.stringify(audit, null, 2) + "\n");

if (audit.duplicateIds.length > 0 || !audit.credentialSafe) process.exitCode = 1;
