import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_BRAIN_DIR = path.resolve(process.env.BRAIN_DATA_DIR || "data/brain");
const DEFAULT_EXPERIMENTS_FILE = path.join(DEFAULT_BRAIN_DIR, "experiments.ndjson");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function experimentFingerprint(input) {
  const identity = {
    strategyId: input.strategyId ?? null,
    experimentType: input.experimentType ?? "research",
    source: input.source ?? null,
    parameters: input.parameters ?? null,
    metrics: input.metrics ?? null,
    legacyLastUpdated: input.legacyLastUpdated ?? null,
  };

  return crypto.createHash("sha256").update(stableStringify(identity)).digest("hex");
}

export function normalizeExperiment(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("Experiment must be an object");
  }
  if (!input.strategyId) {
    throw new Error("Experiment requires strategyId");
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const fingerprint = input.fingerprint ?? experimentFingerprint(input);

  return {
    id: input.id ?? crypto.randomUUID(),
    fingerprint,
    createdAt,
    strategyId: input.strategyId,
    strategyName: input.strategyName ?? input.strategyId,
    experimentType: input.experimentType ?? "research",
    stage: input.stage ?? "research",
    status: input.status ?? "observed",
    source: input.source ?? "brain",
    market: input.market ?? null,
    timeframe: input.timeframe ?? null,
    parameters: input.parameters ?? {},
    metrics: input.metrics ?? {},
    regime: input.regime ?? null,
    decision: input.decision ?? null,
    notes: Array.isArray(input.notes) ? input.notes : [],
    tags: Array.isArray(input.tags) ? input.tags : [],
    legacyLastUpdated: input.legacyLastUpdated ?? null,
  };
}

export function loadExperiments(filePath = DEFAULT_EXPERIMENTS_FILE) {
  if (!fs.existsSync(filePath)) return [];

  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid experiment JSON at line ${index + 1}: ${error.message}`);
      }
    });
}

export function appendExperiment(input, options = {}) {
  const filePath = options.filePath ?? DEFAULT_EXPERIMENTS_FILE;
  const deduplicate = options.deduplicate ?? true;
  const experiment = normalizeExperiment(input);

  ensureDir(path.dirname(filePath));

  if (deduplicate) {
    const existing = loadExperiments(filePath);
    const duplicate = existing.find((item) => item.fingerprint === experiment.fingerprint);
    if (duplicate) {
      return { created: false, experiment: duplicate };
    }
  }

  fs.appendFileSync(filePath, `${JSON.stringify(experiment)}\n`, "utf8");
  return { created: true, experiment };
}

export function summarizeExperiments(experiments) {
  const summary = {
    total: experiments.length,
    byStage: {},
    byStatus: {},
    byStrategy: {},
  };

  for (const item of experiments) {
    summary.byStage[item.stage ?? "unknown"] = (summary.byStage[item.stage ?? "unknown"] ?? 0) + 1;
    summary.byStatus[item.status ?? "unknown"] = (summary.byStatus[item.status ?? "unknown"] ?? 0) + 1;
    summary.byStrategy[item.strategyId ?? "unknown"] = (summary.byStrategy[item.strategyId ?? "unknown"] ?? 0) + 1;
  }

  return summary;
}

export const BRAIN_DIR = DEFAULT_BRAIN_DIR;
export const EXPERIMENTS_FILE = DEFAULT_EXPERIMENTS_FILE;
