// TIMED DIAGNOSTICS TEST MODULE: startup phase collector.
import type { StartupRendererStage } from "../shared/types/startup";
import {
  TIMED_DIAGNOSTICS_TEST_MODULE,
  type TimedDiagnosticEvent
} from "../shared/types/timedDiagnostics";

type StartupClock = () => number;
type StartupLogWriter = (line: string) => void;
type StartupTimingListener = (event: TimedDiagnosticEvent) => void;

const rendererStageLabels: Record<StartupRendererStage, string> = {
  "html-inline-script-started": "HTML 启动内联脚本开始执行",
  "first-contentful-paint": "浏览器完成 First Contentful Paint",
  "renderer-entry-started": "渲染入口 main.tsx 开始执行",
  "react-runtime-loaded": "React runtime 已加载",
  "react-dom-loaded": "ReactDOM client 已加载",
  "global-styles-loaded": "全局 CSS import 已加载",
  "app-module-loaded": "App 模块及其首屏依赖已加载",
  "react-render-submitted": "React 首次 render 已提交",
  "react-mounted": "React 根组件已挂载",
  "dom-content-loaded": "页面触发 DOMContentLoaded",
  "window-load-complete": "页面触发 window.load",
  "main-window-shown": "渲染端确认主窗口已显示",
  "startup-surface-ready": "渲染端确认启动首帧可见",
  "initial-pets-loaded": "渲染端完成首次桌宠列表读取",
  "minimum-splash-elapsed": "启动动画最短展示时间已到",
  "splash-exit-started": "启动动画开始退出",
  "splash-hidden": "启动动画已完全隐藏"
};

function milliseconds(value: number): string {
  return Math.max(0, value).toFixed(1).padStart(8, " ");
}

export class StartupProfiler {
  private readonly startedAt: number;
  private lastLoggedAt: number;
  private readonly completedKeys = new Set<string>();
  private readonly events: TimedDiagnosticEvent[] = [];
  private readonly listeners = new Set<StartupTimingListener>();
  private nextEventSequence = 1;

  constructor(
    readonly enabled: boolean,
    private readonly now: StartupClock = () => performance.now(),
    private readonly write: StartupLogWriter = () => undefined,
    startedAt?: number
  ) {
    this.startedAt = startedAt ?? this.now();
    this.lastLoggedAt = this.startedAt;
  }

  private log(key: string, label: string, stepMilliseconds: number, failed = false): void {
    const current = this.now();
    const status = failed ? "失败" : "完成";
    const sequence = this.nextEventSequence++;
    const event: TimedDiagnosticEvent = {
      module: TIMED_DIAGNOSTICS_TEST_MODULE,
      eventId: `startup:${sequence}`,
      group: "startup",
      requestId: "startup",
      sequence,
      phase: "startup",
      stage: key,
      label,
      stepMs: Math.max(0, current - this.lastLoggedAt),
      totalMs: Math.max(0, current - this.startedAt),
      ok: !failed
    };
    this.events.push(event);
    if (this.events.length > 512) this.events.shift();
    for (const listener of this.listeners) listener(event);
    this.write(
      `[启动计时] 累计 ${milliseconds(current - this.startedAt)} ms | 本步 ${milliseconds(stepMilliseconds)} ms | ${status}：${label}`
    );
    this.lastLoggedAt = current;
  }

  markOnce(key: string, label: string): void {
    if (!this.enabled || this.completedKeys.has(key)) return;
    this.completedKeys.add(key);
    const current = this.now();
    this.log(key, label, current - this.lastLoggedAt);
  }

  reportRendererStage(stage: StartupRendererStage): void {
    this.markOnce(`renderer:${stage}`, rendererStageLabels[stage]);
  }

  async measureOnce<T>(key: string, label: string, operation: () => Promise<T>): Promise<T> {
    if (!this.enabled || this.completedKeys.has(key)) return operation();
    this.completedKeys.add(key);
    const stepStartedAt = this.now();
    try {
      const result = await operation();
      this.log(key, label, this.now() - stepStartedAt);
      return result;
    } catch (error) {
      this.log(key, label, this.now() - stepStartedAt, true);
      throw error;
    }
  }

  measureSyncOnce<T>(key: string, label: string, operation: () => T): T {
    if (!this.enabled || this.completedKeys.has(key)) return operation();
    this.completedKeys.add(key);
    const stepStartedAt = this.now();
    try {
      const result = operation();
      this.log(key, label, this.now() - stepStartedAt);
      return result;
    } catch (error) {
      this.log(key, label, this.now() - stepStartedAt, true);
      throw error;
    }
  }

  /** TIMED DIAGNOSTICS TEST MODULE: expose bounded events to the main window. */
  subscribe(listener: StartupTimingListener): () => void {
    if (!this.enabled) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getEvents(): TimedDiagnosticEvent[] {
    return this.events.slice();
  }
}

const requestedStartTime = Number(process.env.ZHUOMIANLING_STARTUP_STARTED_AT);
const currentWallTime = Date.now();
const validRequestedStartTime = Number.isFinite(requestedStartTime) &&
  requestedStartTime <= currentWallTime &&
  currentWallTime - requestedStartTime <= 10 * 60 * 1_000
  ? requestedStartTime
  : undefined;

export const startupProfiler = new StartupProfiler(
  process.env.ZHUOMIANLING_STARTUP_TIMING === "1",
  () => Date.now(),
  () => undefined,
  validRequestedStartTime
);
