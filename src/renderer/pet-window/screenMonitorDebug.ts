// TIMED DIAGNOSTICS TEST MODULE: pet-window fallback monitor debug snapshot.
import type { ScreenMonitorDiagnostic } from "../../shared/types/screenMonitorDebug";

/** Enabled only for a Vite development server started with the explicit debug flag. */
export const screenMonitorDebugEnabled =
  import.meta.env.DEV && import.meta.env.VITE_SCREEN_MONITOR_DEBUG === "1";

export interface ScreenMonitorDebugSnapshot {
  samples: number;
  candidates: number;
  analyses: number;
  replies: number;
  latest?: ScreenMonitorDiagnostic;
}

export function createScreenMonitorDebugSnapshot(
  latest?: ScreenMonitorDiagnostic
): ScreenMonitorDebugSnapshot {
  return {
    samples: 0,
    candidates: 0,
    analyses: 0,
    replies: 0,
    ...(latest ? { latest } : {})
  };
}

export function isScreenMonitorAnalysisDiagnostic(
  diagnostic: ScreenMonitorDiagnostic
): boolean {
  return diagnostic.reason === "model-silent"
    || diagnostic.reason === "duplicate-reply"
    || diagnostic.reason === "provider-timeout"
    || diagnostic.reason === "provider-error"
    || diagnostic.reason === "model-replied";
}

export function isScreenMonitorCandidateDiagnostic(
  diagnostic: ScreenMonitorDiagnostic
): boolean {
  return diagnostic.event !== undefined && diagnostic.stage !== "capture";
}
