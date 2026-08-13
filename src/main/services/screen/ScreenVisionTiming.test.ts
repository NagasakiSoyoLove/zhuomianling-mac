// TIMED DIAGNOSTICS TEST MODULE: chat, vision, and automatic monitor timing tests.
import { describe, expect, it, vi } from "vitest";
import { ScreenVisionTiming } from "./ScreenVisionTiming";
import { TIMED_DIAGNOSTICS_TEST_MODULE } from "../../../shared/types/timedDiagnostics";

describe("ScreenVisionTiming", () => {
  it("prints fixed Chinese stages with step and cumulative durations", () => {
    let now = 100;
    const lines: string[] = [];
    const timing = new ScreenVisionTiming(true, () => now, (line) => lines.push(line));

    timing.mark("screen-request-0001", "renderer", "request-started");
    now = 145;
    timing.mark("screen-request-0001", "renderer", "frame-encoded");
    now = 210;
    timing.mark("screen-request-0001", "vision-model", "model-first-output");
    timing.mark("screen-request-0001", "vision-model", "model-first-output");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("累计      0.0 ms");
    expect(lines[1]).toContain("累计     45.0 ms");
    expect(lines[1]).toContain("本步     45.0 ms");
    expect(lines[2]).toContain("累计    110.0 ms");
    expect(lines[2]).toContain("视觉模型 · 视觉模型首个文本输出");
    expect(lines.join("\n")).not.toContain("screen-request-0001");
  });

  it("does not write anything when the explicit timing mode is disabled", () => {
    const lines: string[] = [];
    const timing = new ScreenVisionTiming(false, () => 100, (line) => lines.push(line));

    timing.mark("screen-request-0001", "renderer", "request-started");

    expect(lines).toEqual([]);
  });

  it("uses a separate Chinese label for ordinary chat timing", () => {
    const lines: string[] = [];
    const timing = new ScreenVisionTiming(true, () => 100, (line) => lines.push(line));

    timing.mark("chat-request-0001", "renderer", "request-started", true, "chat");

    expect(lines[0]).toContain("[聊天计时 #1]");
    expect(lines[0]).toContain("开始普通聊天");
  });

  it("publishes automatic screen-monitor events with total and step durations", () => {
    let now = 100;
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const timing = new ScreenVisionTiming(true, () => now);
    const events: ReturnType<ScreenVisionTiming["getEvents"]> = [];
    const unsubscribe = timing.subscribe((event) => events.push(event));

    timing.mark("monitor-request-0001", "renderer", "request-started", true, "monitor");
    now = 180;
    timing.mark("monitor-request-0001", "main", "detector-candidate", true, "monitor");
    now = 12_100;
    timing.mark("monitor-request-0001", "main", "monitor-timeout", false, "monitor");
    unsubscribe();

    expect(events).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({
      module: TIMED_DIAGNOSTICS_TEST_MODULE,
      group: "monitor",
      stage: "monitor-timeout",
      stepMs: 11_920,
      totalMs: 12_000,
      ok: false
    });
    expect(timing.getEvents()).toEqual(events);
    expect(consoleLog).not.toHaveBeenCalled();
    consoleLog.mockRestore();
  });
});
