// TIMED DIAGNOSTICS TEST MODULE: screen capture and awareness lifecycle tests.
import { describe, expect, it } from "vitest";
import { ScreenVisionRequestError } from "../../shared/screenVisionError";
import {
  clearScreenMonitorFrameFailure,
  createScreenMonitorFrameFailureCounts,
  incrementScreenMonitorFrameFailure,
  screenMonitorMaxConsecutiveFrameFailures,
  screenVisionFailureCodeFromError
} from "./useScreenAwareness";

describe("screen awareness client error classification", () => {
  it("keeps structured main-process errors intact", () => {
    expect(
      screenVisionFailureCodeFromError(
        new ScreenVisionRequestError("provider-rate-limit"),
        "unknown"
      )
    ).toBe("provider-rate-limit");
  });

  it("classifies an IPC rejection as a frame-transfer failure", () => {
    expect(screenVisionFailureCodeFromError(new Error("IPC rejected payload"), "frame-transfer-failed"))
      .toBe("frame-transfer-failed");
  });

  it("classifies AbortError separately from encoding failures", () => {
    expect(screenVisionFailureCodeFromError(new DOMException("stopped", "AbortError"), "frame-encoding-failed"))
      .toBe("request-canceled");
  });

  it("keeps each automatic frame failure streak independent and clears only the recovered stage", () => {
    const counts = createScreenMonitorFrameFailureCounts();
    expect(incrementScreenMonitorFrameFailure(counts, "encoding")).toBe(1);
    expect(incrementScreenMonitorFrameFailure(counts, "encoding")).toBe(2);
    expect(incrementScreenMonitorFrameFailure(counts, "feature")).toBe(1);
    expect(incrementScreenMonitorFrameFailure(counts, "ipc")).toBe(1);
    expect(incrementScreenMonitorFrameFailure(counts, "transfer")).toBe(1);
    expect(incrementScreenMonitorFrameFailure(counts, "encoding")).toBe(screenMonitorMaxConsecutiveFrameFailures);

    clearScreenMonitorFrameFailure(counts, "encoding");
    expect(counts).toEqual({ encoding: 0, transfer: 1, ipc: 1, feature: 1 });
  });
});
