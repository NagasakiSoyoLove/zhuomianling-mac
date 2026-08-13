// TIMED DIAGNOSTICS TEST MODULE: bounded pet-window monitor diagnostic metadata.
import type { ScreenMonitorEvent } from "./screen";

/**
 * Development-only metadata for explaining why a screen-monitor frame did or
 * did not result in a reply. It intentionally contains no screenshot,
 * prompt, model output, source name, or scene content.
 */
export type ScreenMonitorDiagnosticStage =
  | "capture"
  | "detector"
  | "gate"
  | "model"
  | "delivery";

export type ScreenMonitorDiagnosticReason =
  | "started"
  | "capture-failed"
  | "capture-error"
  | "capture-ended"
  | "frame-encoding-failed"
  | "frame-transfer-failed"
  | "feature-missing"
  | "baseline"
  | "noise"
  | "candidate"
  | "analysis-pending"
  | "reply-pending"
  | "analysis-cooldown"
  | "same-scene-cooldown"
  | "reply-budget"
  | "model-silent"
  | "duplicate-reply"
  | "provider-timeout"
  | "provider-error"
  | "model-replied"
  | "reply-delivered";

export interface ScreenMonitorDiagnostic {
  stage: ScreenMonitorDiagnosticStage;
  reason: ScreenMonitorDiagnosticReason;
  event?: ScreenMonitorEvent;
  changeRatio?: number;
  stableForMs?: number;
  /** Normalized reply similarity, only present for the duplicate-reply gate. */
  replySimilarity?: number;
}
