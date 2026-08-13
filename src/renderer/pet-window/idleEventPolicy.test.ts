import { describe, expect, it } from "vitest";
import { canTriggerLongIdleEvent } from "./idleEventPolicy";

describe("long idle event policy", () => {
  it.each([
    [false, false, true],
    [true, false, false],
    [false, true, false],
    [true, true, false]
  ])(
    "chatOpen=%s and screenMonitoringActive=%s allow=%s",
    (chatOpen, screenMonitoringActive, expected) => {
      expect(canTriggerLongIdleEvent(chatOpen, screenMonitoringActive)).toBe(expected);
    }
  );
});
