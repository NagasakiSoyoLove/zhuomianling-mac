// TIMED DIAGNOSTICS TEST MODULE: shaping and retention tests.
import { describe, expect, it } from "vitest";
import {
  dedupeTimedDiagnosticEvents,
  groupTimedDiagnosticRuns,
  SCREEN_MONITOR_TEST_TIMEOUT_MS,
  TIMED_DIAGNOSTICS_TEST_MAX_REQUESTS
} from "./timedDiagnosticsTest";
import { TIMED_DIAGNOSTICS_TEST_MODULE, type TimedDiagnosticEvent } from "../../../shared/types/timedDiagnostics";

function event(
  eventId: string,
  requestId: string,
  sequence: number,
  stage: string,
  totalMs: number,
  stepMs = totalMs,
  ok = true
): TimedDiagnosticEvent {
  return {
    module: TIMED_DIAGNOSTICS_TEST_MODULE,
    eventId,
    group: "monitor",
    requestId,
    sequence,
    phase: "main",
    stage,
    label: stage,
    stepMs,
    totalMs,
    ok
  };
}

describe("TIMED DIAGNOSTICS TEST MODULE", () => {
  it("keeps the latest ten monitor requests and marks an explicit timeout", () => {
    const events = Array.from({ length: TIMED_DIAGNOSTICS_TEST_MAX_REQUESTS + 2 }, (_, index) => {
      const sequence = index + 1;
      const requestId = "screen-monitor-" + sequence;
      const totalMs = sequence === 12 ? SCREEN_MONITOR_TEST_TIMEOUT_MS : sequence * 100;
      return [
        event("screen:" + sequence + ":model", requestId, sequence, "model-request-started", 5, 5),
        event(
          "screen:" + sequence + ":done",
          requestId,
          sequence,
          sequence === 12 ? "monitor-timeout" : "monitor-result-ready",
          totalMs,
          Math.max(0, totalMs - 5)
        )
      ];
    }).flat();

    const runs = groupTimedDiagnosticRuns(events, "monitor");

    expect(runs).toHaveLength(TIMED_DIAGNOSTICS_TEST_MAX_REQUESTS);
    expect(runs[0]?.requestId).toBe("screen-monitor-12");
    expect(runs[0]?.status).toBe("timeout");
  });

  it("derives model, local detector, transfer and total durations", () => {
    const runs = groupTimedDiagnosticRuns([
      event("1", "one", 1, "request-started", 0),
      event("2", "one", 1, "frame-encoding-started", 10, 10),
      event("3", "one", 1, "frame-sent", 40, 30),
      event("4", "one", 1, "detector-started", 45, 5),
      event("5", "one", 1, "detector-candidate", 60, 15),
      event("6", "one", 1, "monitor-analysis-started", 65, 5),
      event("7", "one", 1, "request-body-ready", 66, 1),
      event("8", "one", 1, "model-request-body-serialized", 68, 2),
      event("9", "one", 1, "model-request-started", 70, 2),
      event("10", "one", 1, "model-response-headers", 170, 100),
      event("11", "one", 1, "model-first-network-chunk", 220, 50),
      event("12", "one", 1, "model-first-output", 270, 50),
      event("13", "one", 1, "model-action-ready", 300, 30),
      event("14", "one", 1, "model-decision-ready", 350, 50),
      event("15", "one", 1, "monitor-result-ready", 470, 120),
      event("16", "one", 1, "model-output-completed", 470, 0)
    ], "monitor");

    expect(runs[0]).toMatchObject({
      totalMs: 470,
      transferMs: 30,
      detectorMs: 15,
      analysisMs: 405,
      actionMs: 300,
      decisionMs: 350,
      requestSerializationMs: 2,
      requestToHeadersMs: 100,
      headersToFirstChunkMs: 50,
      firstChunkToOutputMs: 50,
      outputTailMs: 200,
      modelMs: 400,
      firstOutputMs: 200,
      status: "completed"
    });
  });

  it("measures IPC transfer before AI work and completes after later renderer events", () => {
    const runs = groupTimedDiagnosticRuns([
      event("1", "monitor", 1, "frame-encoded", 100, 100),
      event("2", "monitor", 1, "frame-sent", 101, 1),
      event("3", "monitor", 1, "frame-received", 130, 29),
      event("4", "monitor", 1, "model-request-started", 140, 10),
      event("5", "monitor", 1, "monitor-result-ready", 200, 60),
      event("6", "monitor", 1, "reply-chunk-received", 210, 10)
    ], "monitor");

    expect(runs[0]).toMatchObject({
      transferMs: 30,
      totalMs: 210,
      status: "completed"
    });
  });

  it("deduplicates snapshot plus live events and rejects other modules", () => {
    const one = event("one", "one", 1, "model-request-started", 10);
    const done = event("done", "one", 1, "monitor-result-ready", 20, 10);
    const other = { ...one, eventId: "other", module: "not-this-test-module" } as unknown as TimedDiagnosticEvent;

    expect(dedupeTimedDiagnosticEvents([one, one, done, other])).toEqual([one, done]);
  });

  it("excludes local-only monitor samples that never reach the AI request", () => {
    const localOnly = [
      event("local-start", "local-only", 1, "request-started", 0),
      event("local-noise", "local-only", 1, "detector-noise", 80, 80)
    ];
    const sentToAi = [
      event("ai-start", "sent-to-ai", 2, "request-started", 0),
      event("ai-model", "sent-to-ai", 2, "model-request-started", 90, 90),
      event("ai-done", "sent-to-ai", 2, "monitor-result-ready", 180, 90)
    ];

    const runs = groupTimedDiagnosticRuns([...localOnly, ...sentToAi], "monitor");

    expect(runs.map((run) => run.requestId)).toEqual(["sent-to-ai"]);
  });
});
