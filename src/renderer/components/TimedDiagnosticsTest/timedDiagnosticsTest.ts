// TIMED DIAGNOSTICS TEST MODULE: renderer-side gate and bounded run shaping.
import {
  TIMED_DIAGNOSTICS_TEST_MODULE,
  type TimedDiagnosticEvent,
  type TimedDiagnosticGroup
} from "../../../shared/types/timedDiagnostics";
import { SCREEN_MONITOR_TIMEOUT_MS } from "../../../shared/types/screen";
export const TIMED_DIAGNOSTICS_TEST_ENABLED =
  import.meta.env.DEV && import.meta.env.VITE_SCREEN_MONITOR_DEBUG === "1";
export const TIMED_DIAGNOSTICS_TEST_MAX_REQUESTS = 10;
// TIMED DIAGNOSTICS TEST MODULE: keep the dashboard threshold identical to the
// automatic-monitor runtime timeout.
export const SCREEN_MONITOR_TEST_TIMEOUT_MS = SCREEN_MONITOR_TIMEOUT_MS;

export interface TimedDiagnosticRun {
  requestId: string;
  sequence: number;
  group: TimedDiagnosticGroup;
  events: TimedDiagnosticEvent[];
  totalMs: number;
  firstOutputMs?: number;
  actionMs?: number;
  decisionMs?: number;
  modelMs?: number;
  detectorMs?: number;
  transferMs?: number;
  analysisMs?: number;
  requestSerializationMs?: number;
  requestToHeadersMs?: number;
  headersToFirstChunkMs?: number;
  firstChunkToOutputMs?: number;
  outputTailMs?: number;
  timeout: boolean;
  status: "running" | "completed" | "failed" | "timeout";
  bottleneck?: TimedDiagnosticEvent;
}

function eventTotal(events: TimedDiagnosticEvent[], stage: string): number | undefined {
  const event = events.find((item) => item.stage === stage);
  return event?.totalMs;
}

function durationBetween(
  events: TimedDiagnosticEvent[],
  startStage: string,
  endStage: string
): number | undefined {
  const start = eventTotal(events, startStage);
  const end = eventTotal(events, endStage);
  if (start === undefined || end === undefined) return undefined;
  return Math.max(0, end - start);
}

function terminalEvent(event: TimedDiagnosticEvent | undefined): boolean {
  return Boolean(event && (
    event.stage === "reply-completed" ||
    event.stage === "reply-result-ready" ||
    event.stage === "model-output-completed" ||
    event.stage === "monitor-result-ready" ||
    event.stage === "monitor-gate" ||
    event.stage === "monitor-timeout" ||
    event.stage === "request-failed"
  ));
}

function compareEvents(left: TimedDiagnosticEvent, right: TimedDiagnosticEvent): number {
  const leftOrder = Number(left.eventId.match(/(\d+)(?:\D*)$/u)?.[1] ?? 0);
  const rightOrder = Number(right.eventId.match(/(\d+)(?:\D*)$/u)?.[1] ?? 0);
  return leftOrder - rightOrder;
}

/**
 * TIMED DIAGNOSTICS TEST MODULE: a monitor sample is a measured AI round only
 * after the model request has actually been started. Baseline/noise/candidate
 * samples that never reach the provider stay out of the request count.
 */
function reachedAiRequest(events: readonly TimedDiagnosticEvent[]): boolean {
  return events.some((event) => event.stage === "model-request-started" && event.ok);
}

export function dedupeTimedDiagnosticEvents(
  events: readonly TimedDiagnosticEvent[]
): TimedDiagnosticEvent[] {
  const byId = new Map<string, TimedDiagnosticEvent>();
  for (const event of events) {
    if (event.module !== TIMED_DIAGNOSTICS_TEST_MODULE) continue;
    byId.set(event.eventId, event);
  }
  return [...byId.values()];
}

export function groupTimedDiagnosticRuns(
  events: readonly TimedDiagnosticEvent[],
  group: TimedDiagnosticGroup,
  limit = TIMED_DIAGNOSTICS_TEST_MAX_REQUESTS
): TimedDiagnosticRun[] {
  const runs = new Map<string, TimedDiagnosticEvent[]>();
  for (const event of events) {
    if (event.group !== group) continue;
    const current = runs.get(event.requestId) ?? [];
    current.push(event);
    runs.set(event.requestId, current);
  }

  return [...runs.values()]
    .filter((runEvents) => group !== "monitor" || reachedAiRequest(runEvents))
    .map((runEvents) => {
      const sortedEvents = runEvents.slice().sort(compareEvents);
      const last = sortedEvents.at(-1);
      const timeout = sortedEvents.some((event) => event.stage === "monitor-timeout") ||
        (group === "monitor" && (last?.totalMs ?? 0) >= SCREEN_MONITOR_TEST_TIMEOUT_MS);
      const failed = sortedEvents.some((event) => !event.ok && event.stage === "request-failed") ||
        (!timeout && sortedEvents.some((event) => terminalEvent(event) && !event.ok));
      // A renderer delivery event can arrive after the main-process terminal
      // event. The run is complete once any terminal stage has been observed;
      // looking only at the final event incorrectly leaves it as running.
      const completed = sortedEvents.some((event) => terminalEvent(event));
      const modelEnd = eventTotal(sortedEvents, "model-output-completed") ?? eventTotal(sortedEvents, "reply-result-ready");
      const detectorEnd = eventTotal(sortedEvents, "detector-candidate")
        ?? eventTotal(sortedEvents, "detector-noise")
        ?? eventTotal(sortedEvents, "detector-baseline");
      const bottleneck = sortedEvents
        .slice()
        .sort((left, right) => right.stepMs - left.stepMs)[0];

      const firstOutputMs = durationBetween(sortedEvents, "model-request-started", "model-first-output");
      const actionMs = eventTotal(sortedEvents, "model-action-ready");
      const decisionMs = eventTotal(sortedEvents, "model-decision-ready");
      const modelMs = durationBetween(sortedEvents, "model-request-started", "model-output-completed")
        ?? (modelEnd !== undefined ? durationBetween(sortedEvents, "model-request-started", "reply-result-ready") : undefined);
      const requestSerializationMs = durationBetween(sortedEvents, "request-body-ready", "model-request-body-serialized");
      const requestToHeadersMs = durationBetween(sortedEvents, "model-request-started", "model-response-headers");
      const headersToFirstChunkMs = durationBetween(sortedEvents, "model-response-headers", "model-first-network-chunk");
      const firstChunkToOutputMs = durationBetween(sortedEvents, "model-first-network-chunk", "model-first-output");
      const outputTailMs = durationBetween(sortedEvents, "model-first-output", "model-output-completed");
      const detectorStarted = eventTotal(sortedEvents, "detector-started");
      const detectorMs = detectorStarted !== undefined && detectorEnd !== undefined
        ? Math.max(0, detectorEnd - detectorStarted)
        : undefined;
      const transferMs = durationBetween(sortedEvents, "frame-encoded", "frame-received")
        ?? durationBetween(sortedEvents, "frame-encoding-started", "frame-sent");
      const analysisMs = durationBetween(sortedEvents, "monitor-analysis-started", "monitor-result-ready")
        ?? durationBetween(sortedEvents, "monitor-analysis-started", "monitor-timeout");

      return {
        requestId: last?.requestId ?? "",
        sequence: last?.sequence ?? 0,
        group,
        events: sortedEvents,
        totalMs: Math.max(0, last?.totalMs ?? 0),
        ...(firstOutputMs !== undefined ? { firstOutputMs } : {}),
        ...(actionMs !== undefined ? { actionMs } : {}),
        ...(decisionMs !== undefined ? { decisionMs } : {}),
        ...(modelMs !== undefined ? { modelMs } : {}),
        ...(detectorMs !== undefined ? { detectorMs } : {}),
        ...(transferMs !== undefined ? { transferMs } : {}),
        ...(analysisMs !== undefined ? { analysisMs } : {}),
        ...(requestSerializationMs !== undefined ? { requestSerializationMs } : {}),
        ...(requestToHeadersMs !== undefined ? { requestToHeadersMs } : {}),
        ...(headersToFirstChunkMs !== undefined ? { headersToFirstChunkMs } : {}),
        ...(firstChunkToOutputMs !== undefined ? { firstChunkToOutputMs } : {}),
        ...(outputTailMs !== undefined ? { outputTailMs } : {}),
        timeout,
        status: timeout ? "timeout" : failed ? "failed" : completed ? "completed" : "running",
        ...(bottleneck ? { bottleneck } : {})
      } satisfies TimedDiagnosticRun;
    })
    .sort((left, right) => right.sequence - left.sequence)
    .slice(0, Math.max(1, limit));
}

export function averageTimedDiagnosticRunMs(runs: readonly TimedDiagnosticRun[]): number | undefined {
  const completed = runs.filter((run) => run.status !== "running");
  if (!completed.length) return undefined;
  return completed.reduce((sum, run) => sum + run.totalMs, 0) / completed.length;
}
