// TIMED DIAGNOSTICS TEST MODULE: legacy pet-window monitor status tests.
import { describe, expect, it } from "vitest";
import { clampScreenMonitorStatusPosition, shouldShowScreenMonitorStatus } from "./ScreenMonitorStatusChip";

describe("shouldShowScreenMonitorStatus", () => {
  it("waits for a completed start and a closed source panel", () => {
    expect(shouldShowScreenMonitorStatus("starting", false, true)).toBe(false);
    expect(shouldShowScreenMonitorStatus("watching", true, true)).toBe(false);
    expect(shouldShowScreenMonitorStatus("watching", false, true)).toBe(true);
    expect(shouldShowScreenMonitorStatus("analyzing", false, true)).toBe(true);
    expect(shouldShowScreenMonitorStatus("retrying", false, true)).toBe(true);
  });

  it("hides one-shot chat recognition unless manual observation is active", () => {
    expect(shouldShowScreenMonitorStatus("analyzing", false, false)).toBe(false);
  });
});

describe("clampScreenMonitorStatusPosition", () => {
  it("keeps the status chip inside the viewport edge padding", () => {
    expect(clampScreenMonitorStatusPosition({ right: -20, bottom: 999 }, 120, 32, 380, 480)).toEqual({
      right: 8,
      bottom: 440
    });
  });

  it("allows the chip to move to the opposite corner", () => {
    expect(clampScreenMonitorStatusPosition({ right: 8, bottom: 8 }, 120, 32, 380, 480)).toEqual({
      right: 8,
      bottom: 8
    });
  });
});
