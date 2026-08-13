// TIMED DIAGNOSTICS TEST MODULE: startup timing collector tests.
import { describe, expect, it, vi } from "vitest";
import { StartupProfiler } from "./startupProfiler";
import { TIMED_DIAGNOSTICS_TEST_MODULE } from "../shared/types/timedDiagnostics";

describe("StartupProfiler", () => {
  it("prints one bounded line for each unique startup stage", async () => {
    let clock = 100;
    const lines: string[] = [];
    const profiler = new StartupProfiler(true, () => clock, (line) => lines.push(line));

    clock = 125;
    profiler.markOnce("electron-ready", "Electron ready");
    profiler.markOnce("electron-ready", "Electron ready");
    await profiler.measureOnce("pet-scan", "读取桌宠配置", async () => {
      clock = 160;
      return "ok";
    });
    clock = 180;
    profiler.reportRendererStage("splash-hidden");

    expect(lines).toEqual([
      "[启动计时] 累计     25.0 ms | 本步     25.0 ms | 完成：Electron ready",
      "[启动计时] 累计     60.0 ms | 本步     35.0 ms | 完成：读取桌宠配置",
      "[启动计时] 累计     80.0 ms | 本步     20.0 ms | 完成：启动动画已完全隐藏"
    ]);
  });

  it("keeps profiling disabled without skipping the wrapped operation", async () => {
    const lines: string[] = [];
    const profiler = new StartupProfiler(false, () => 0, (line) => lines.push(line));
    const result = await profiler.measureOnce("step", "步骤", async () => 42);

    expect(result).toBe(42);
    expect(lines).toEqual([]);
  });

  it("marks failed steps without logging error details", async () => {
    let clock = 0;
    const lines: string[] = [];
    const profiler = new StartupProfiler(true, () => clock, (line) => lines.push(line));

    await expect(profiler.measureOnce("failure", "配置迁移", async () => {
      clock = 12;
      throw new Error("sensitive local detail");
    })).rejects.toThrow("sensitive local detail");

    expect(lines).toEqual([
      "[启动计时] 累计     12.0 ms | 本步     12.0 ms | 失败：配置迁移"
    ]);
  });

  it("publishes bounded events for the TIMED DIAGNOSTICS TEST MODULE without requiring logs", () => {
    let clock = 10;
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const profiler = new StartupProfiler(true, () => clock);
    const events: Array<{ module: string; stage: string; totalMs: number }> = [];
    const unsubscribe = profiler.subscribe((event) => {
      events.push({ module: event.module, stage: event.stage, totalMs: event.totalMs });
    });

    clock = 35;
    profiler.markOnce("main-window", "创建主窗口");
    unsubscribe();

    expect(events).toEqual([{
      module: TIMED_DIAGNOSTICS_TEST_MODULE,
      stage: "main-window",
      totalMs: 25
    }]);
    expect(profiler.getEvents()).toHaveLength(1);
    expect(consoleLog).not.toHaveBeenCalled();
    consoleLog.mockRestore();
  });
});
