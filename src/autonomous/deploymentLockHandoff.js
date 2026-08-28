import fs from "node:fs";
import { ORCHESTRATOR_LOCK_FILE } from "../runtime/runtimePaths.js";

const DEFAULT_HANDOFF_GRACE_MINUTES = 10;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function recoverRailwayDeploymentLock(options = {}) {
  const filePath = options.filePath ?? ORCHESTRATOR_LOCK_FILE;
  const now = options.now ?? new Date();
  const currentDeploymentId =
    options.currentDeploymentId ?? process.env.RAILWAY_DEPLOYMENT_ID ?? null;
  const handoffGraceMinutes =
    options.handoffGraceMinutes ?? DEFAULT_HANDOFF_GRACE_MINUTES;

  const existing = readJson(filePath);
  if (!existing) {
    return { recovered: false, reason: "no_lock" };
  }
  if (!currentDeploymentId || !existing.railwayDeploymentId) {
    return { recovered: false, reason: "deployment_id_unavailable", existing };
  }
  if (existing.railwayDeploymentId === currentDeploymentId) {
    return { recovered: false, reason: "same_deployment", existing };
  }

  const heartbeatMs = Date.parse(existing.heartbeatAt ?? existing.acquiredAt ?? "");
  const ageMs = Number.isFinite(heartbeatMs)
    ? Math.max(0, now.getTime() - heartbeatMs)
    : Infinity;
  const graceMs = handoffGraceMinutes * 60 * 1000;

  if (ageMs < graceMs) {
    return {
      recovered: false,
      reason: "previous_deployment_heartbeat_still_fresh",
      ageMs,
      existing,
    };
  }

  fs.rmSync(filePath, { force: true });
  return {
    recovered: true,
    reason: "previous_railway_deployment_stale",
    ageMs,
    previousDeploymentId: existing.railwayDeploymentId,
    currentDeploymentId,
  };
}
