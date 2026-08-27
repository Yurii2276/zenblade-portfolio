import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendExperiment, loadExperiments, summarizeExperiments } from "./experimentStore.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-v1-"));
const filePath = path.join(tempDir, "experiments.ndjson");

try {
  const input = {
    strategyId: "TEST_STRATEGY",
    experimentType: "backtest",
    stage: "research",
    status: "candidate",
    source: "test",
    parameters: { fast: 20, slow: 50 },
    metrics: { pnlPct: 3.2, trades: 42 },
  };

  const first = appendExperiment(input, { filePath });
  const second = appendExperiment(input, { filePath });

  assert.equal(first.created, true);
  assert.equal(second.created, false);

  const experiments = loadExperiments(filePath);
  assert.equal(experiments.length, 1);
  assert.equal(experiments[0].strategyId, "TEST_STRATEGY");

  const summary = summarizeExperiments(experiments);
  assert.equal(summary.total, 1);
  assert.equal(summary.byStage.research, 1);
  assert.equal(summary.byStatus.candidate, 1);

  console.log("Brain experiment store test passed.");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
