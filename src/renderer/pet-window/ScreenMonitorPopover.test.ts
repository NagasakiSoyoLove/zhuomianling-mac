// TIMED DIAGNOSTICS TEST MODULE: screen monitor popover tests.
import { describe, expect, it } from "vitest";
import { calculateScreenMonitorPopoverPosition } from "./ScreenMonitorPopover";

const baseMetrics = {
  viewportWidth: 380,
  viewportHeight: 480,
  popoverWidth: 286,
  popoverHeight: 330
};

describe("screen monitor popover positioning", () => {
  it("keeps the popover beside the anchor when the lower-right space is available", () => {
    expect(calculateScreenMonitorPopoverPosition({
      ...baseMetrics,
      anchorX: 40,
      anchorY: 40
    })).toEqual({ left: 58, top: 58 });
  });

  it("flips to the left when the right edge does not have enough room", () => {
    expect(calculateScreenMonitorPopoverPosition({
      ...baseMetrics,
      anchorX: 340,
      anchorY: 40
    })).toEqual({ left: 36, top: 58 });
  });

  it("flips above the anchor when the bottom edge does not have enough room", () => {
    expect(calculateScreenMonitorPopoverPosition({
      ...baseMetrics,
      anchorX: 40,
      anchorY: 440
    })).toEqual({ left: 58, top: 92 });
  });

  it("clamps to the viewport when neither side can fit the measured size", () => {
    expect(calculateScreenMonitorPopoverPosition({
      viewportWidth: 240,
      viewportHeight: 240,
      anchorX: 120,
      anchorY: 120,
      popoverWidth: 286,
      popoverHeight: 330
    })).toEqual({ left: 8, top: 8 });
  });
});
