/** TIMED DIAGNOSTICS TEST MODULE: development-only timing data. */
export const TIMED_DIAGNOSTICS_TEST_MODULE = "timed-diagnostics-test-module" as const;

/**
 * Development-only timing data shown by the explicit timed-development
 * launcher. It deliberately contains no prompt, reply, screenshot, path, or
 * provider configuration.
 */
export type TimedDiagnosticGroup = "startup" | "chat" | "vision" | "monitor";

export interface TimedDiagnosticEvent {
  module: typeof TIMED_DIAGNOSTICS_TEST_MODULE;
  eventId: string;
  group: TimedDiagnosticGroup;
  requestId: string;
  sequence: number;
  phase: string;
  stage: string;
  label: string;
  stepMs: number;
  totalMs: number;
  ok: boolean;
}

export interface TimedDiagnosticSnapshot {
  module: typeof TIMED_DIAGNOSTICS_TEST_MODULE;
  enabled: boolean;
  events: TimedDiagnosticEvent[];
}
