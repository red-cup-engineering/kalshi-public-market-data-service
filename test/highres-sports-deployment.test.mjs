import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const machineRoot = fileURLToPath(new URL(
  "../../../../persistent-machines-services-section/services/bare-cedar-fog-services-section/",
  import.meta.url,
));
const read = (relative) => readFileSync(machineRoot + relative, "utf8");

test("high-resolution watchset discovery remains bounded and hardened", () => {
  const unit = read("data/records/systemd/kalshi-sports-research-watchset.service");
  const timer = read("data/records/systemd/kalshi-sports-research-watchset.timer");
  assert.match(unit, /^User=emsenn$/m);
  assert.match(unit, /^Group=emsenn$/m);
  assert.match(unit, /refresh-active-sports-watchset\.mjs/);
  assert.match(unit, /KALSHI_SPORTS_MAX_MARKETS=12/);
  assert.match(unit, /KALSHI_SPORTS_MAX_MILESTONES=6/);
  assert.match(unit, /--sampling-interval-ms=15000/);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(timer, /^OnUnitActiveSec=60s$/m);
});

test("high-resolution sampling is fifteen seconds and credential-free", () => {
  const unit = read("data/records/systemd/kalshi-sports-research-sample.service");
  const timer = read("data/records/systemd/kalshi-sports-research-sample.timer");
  assert.match(unit, /capture-watchset-sample\.mjs/);
  assert.match(unit, /KALSHI_SPORTS_SAMPLE_CONCURRENCY=2/);
  assert.match(unit, /watchset\/current\.json/);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.doesNotMatch(unit, /KALSHI_API_KEY|PRIVATE_KEY|ACCESS_SIGNATURE/);
  assert.match(timer, /^OnUnitActiveSec=15s$/m);
  assert.match(timer, /^AccuracySec=2s$/m);
});

test("analysis audits the fifteen-second tape before research statistics", () => {
  const unit = read("data/records/systemd/kalshi-sports-research-analysis.service");
  const runner = read("scripts/run-kalshi-sports-tape-analysis.mjs");
  assert.match(unit, /KALSHI_SPORTS_TAPE_ROOT=\/var\/lib\/kalshi-sports-research\/tapes/);
  assert.match(runner, /audit-tape\.mjs/);
  assert.match(runner, /--expected-ms=15000/);
  assert.match(runner, /analyze-sports-tape\.mjs/);
  assert.match(runner, /KalshiSportsResearchAnalysisReceipt/);
});

test("cutover validates replacement before disabling the one-minute fallback", () => {
  const path = machineRoot + "scripts/install-kalshi-sports-highres-systemd.sh";
  const syntax = spawnSync("bash", ["-n", path], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const script = read("scripts/install-kalshi-sports-highres-systemd.sh");
  const validateAt = script.indexOf("systemctl start kalshi-sports-research-sample.service");
  const enableAt = script.indexOf("systemctl enable --now kalshi-sports-research-sample.timer");
  const disableOldAt = script.indexOf("systemctl disable --now kalshi-sports-research-tape.timer");
  assert.ok(validateAt >= 0);
  assert.ok(enableAt > validateAt);
  assert.ok(disableOldAt > enableAt);
  assert.match(script, /active-target sample did not append to research tape/);
  assert.match(script, /rollback: systemctl enable --now kalshi-sports-research-tape.timer/);
});
