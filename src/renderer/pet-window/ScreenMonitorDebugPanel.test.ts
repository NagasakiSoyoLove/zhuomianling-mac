// TIMED DIAGNOSTICS TEST MODULE: legacy pet-window monitor diagnostic labels.
import { describe, expect, it } from "vitest";
import { describeScreenMonitorDiagnostic } from "./ScreenMonitorDebugPanel";

describe("ScreenMonitorDebugPanel diagnostic labels", () => {
  it("describes the gate reason without including screen content", () => {
    expect(describeScreenMonitorDiagnostic({
      stage: "gate",
      reason: "same-scene-cooldown",
      event: "page-change",
      changeRatio: 0.42,
      stableForMs: 1_200
    })).toBe("门控：同一场景冷却中");
  });

  it("has a safe empty state", () => {
    expect(describeScreenMonitorDiagnostic(undefined)).toBe("等待首帧诊断");
  });

  it("does not call a high but still-settling change insufficient", () => {
    expect(describeScreenMonitorDiagnostic({
      stage: "detector",
      reason: "noise",
      changeRatio: 0.73
    })).toBe("本地检测：变化仍在持续确认，继续本地观察");
  });
});
