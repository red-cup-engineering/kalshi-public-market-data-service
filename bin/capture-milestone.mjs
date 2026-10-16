#!/usr/bin/env node
import { captureMilestoneAttentionSnapshot } from "../src/public-market-data.mjs";

const milestoneId = process.argv[2];
if (!milestoneId || milestoneId.startsWith("-")) {
  process.stderr.write("usage: capture-milestone <milestone-id>\n");
  process.exit(2);
}

const result = await captureMilestoneAttentionSnapshot(milestoneId);
process.stdout.write(JSON.stringify(result) + "\n");
if (result.type !== "Accept") process.exitCode = 1;
