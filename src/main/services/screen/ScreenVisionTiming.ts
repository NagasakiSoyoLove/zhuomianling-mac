// TIMED DIAGNOSTICS TEST MODULE: chat, vision, and automatic monitor phase collector.
import type {
  ScreenVisionTimingKind,
  ScreenVisionTimingPhase,
  ScreenVisionTimingStage
} from "../../../shared/types/screen";
import {
  TIMED_DIAGNOSTICS_TEST_MODULE,
  type TimedDiagnosticEvent
} from "../../../shared/types/timedDiagnostics";

type VisionTimingClock = () => number;
type VisionTimingWriter = (line: string) => void;
type VisionTimingListener = (event: TimedDiagnosticEvent) => void;

const phaseLabels: Record<ScreenVisionTimingPhase, string> = {
  renderer: "渲染端",
  main: "主进程",
  "vision-model": "视觉模型",
  "chat-model": "聊天模型"
};

const stageLabels: Record<ScreenVisionTimingKind, Record<ScreenVisionTimingStage, string>> = {
  vision: {
    "request-started": "开始识别屏幕问题",
    "source-list-started": "开始读取屏幕来源",
    "source-list-completed": "屏幕来源读取完成",
    "capture-requested": "开始建立屏幕捕获",
    "capture-session-received": "主进程收到捕获请求",
    "capture-ready": "屏幕捕获与视频已就绪",
    "frame-encoding-started": "开始截帧与 JPEG 压缩",
    "frame-encoded": "截图压缩完成",
    "frame-sent": "截图 IPC 请求已发出",
    "frame-result-received": "截图处理结果已返回",
    "frame-received": "截图已到达主进程",
    "request-body-ready": "视觉请求体准备完成",
    "model-request-body-serialized": "视觉请求 JSON 序列化完成",
    "model-request-started": "模型请求开始发送",
    "model-response-headers": "视觉模型响应头已到达",
    "model-first-network-chunk": "视觉模型首个网络数据块已到达",
    "model-first-output": "视觉模型首个文本输出",
    "model-action-ready": "视觉模型 action 已确定",
    "model-decision-ready": "视觉模型最小决策已完成",
    "model-output-completed": "模型输出完成",
    "reply-event-sent": "首个回复片段已发给渲染端",
    "reply-result-ready": "视觉回复结果已准备完成",
    "reply-chunk-received": "渲染端收到首个回复片段",
    "bubble-queued": "回复已进入聊天气泡打字机",
    "reply-completed": "聊天回复处理完成",
    "request-failed": "视觉请求失败",
    "detector-started": "本地变化检测开始",
    "detector-baseline": "本地检测建立基线",
    "detector-noise": "本地检测判定为持续变化",
    "detector-candidate": "本地检测确认稳定候选",
    "monitor-analysis-started": "自动检测进入模型分析",
    "monitor-gate": "自动检测被门控拦截",
    "monitor-result-ready": "自动检测结果已准备完成",
    "monitor-timeout": "自动检测触发总超时"
  },
  chat: {
    "request-started": "开始普通聊天",
    "source-list-started": "开始读取聊天来源",
    "source-list-completed": "聊天来源读取完成",
    "capture-requested": "开始准备聊天请求",
    "capture-session-received": "主进程收到聊天请求",
    "capture-ready": "聊天请求准备就绪",
    "frame-encoding-started": "开始准备聊天数据",
    "frame-encoded": "聊天数据准备完成",
    "frame-sent": "聊天 IPC 请求已发出",
    "frame-result-received": "聊天处理结果已返回",
    "frame-received": "聊天请求已到达主进程",
    "request-body-ready": "聊天请求体准备完成",
    "model-request-body-serialized": "聊天请求 JSON 序列化完成",
    "model-request-started": "聊天模型请求开始发送",
    "model-response-headers": "聊天模型响应头已到达",
    "model-first-network-chunk": "聊天模型首个网络数据块已到达",
    "model-first-output": "聊天模型首个文本输出",
    "model-action-ready": "聊天模型 action 已确定",
    "model-decision-ready": "聊天模型最小决策已完成",
    "model-output-completed": "聊天模型输出完成",
    "reply-event-sent": "首个聊天回复片段已发给渲染端",
    "reply-result-ready": "聊天回复结果已准备完成",
    "reply-chunk-received": "渲染端收到首个聊天回复片段",
    "bubble-queued": "普通聊天进入聊天气泡打字机",
    "reply-completed": "普通聊天回复处理完成",
    "request-failed": "普通聊天请求失败",
    "detector-started": "本地变化检测开始",
    "detector-baseline": "本地检测建立基线",
    "detector-noise": "本地检测判定为持续变化",
    "detector-candidate": "本地检测确认稳定候选",
    "monitor-analysis-started": "自动检测进入模型分析",
    "monitor-gate": "自动检测被门控拦截",
    "monitor-result-ready": "自动检测结果已准备完成",
    "monitor-timeout": "自动检测触发总超时"
  },
  monitor: {
    "request-started": "自动检测本轮开始",
    "source-list-started": "开始读取自动检测来源",
    "source-list-completed": "自动检测来源读取完成",
    "capture-requested": "开始准备自动检测捕获",
    "capture-session-received": "自动检测捕获会话已建立",
    "capture-ready": "自动检测捕获已就绪",
    "frame-encoding-started": "开始截取自动检测帧",
    "frame-encoded": "自动检测帧编码完成",
    "frame-sent": "自动检测帧 IPC 请求已发出",
    "frame-result-received": "自动检测处理结果已返回",
    "frame-received": "自动检测帧已到达主进程",
    "request-body-ready": "自动检测模型请求体准备完成",
    "model-request-body-serialized": "自动检测请求 JSON 序列化完成",
    "model-request-started": "自动检测模型请求开始发送",
    "model-response-headers": "自动检测模型响应头已到达",
    "model-first-network-chunk": "自动检测首个网络数据块已到达",
    "model-first-output": "自动检测模型首个文本输出",
    "model-action-ready": "自动检测 action 已确定",
    "model-decision-ready": "自动检测最小决策已完成",
    "model-output-completed": "自动检测模型输出完成",
    "reply-event-sent": "自动检测回复片段已发出",
    "reply-result-ready": "自动检测回复结果已准备完成",
    "reply-chunk-received": "自动检测收到首个回复片段",
    "bubble-queued": "自动检测回复进入聊天气泡",
    "reply-completed": "自动检测回复处理完成",
    "request-failed": "自动检测请求失败",
    "detector-started": "本地变化检测开始",
    "detector-baseline": "本地检测建立基线",
    "detector-noise": "本地检测判定为持续变化",
    "detector-candidate": "本地检测确认稳定候选",
    "monitor-analysis-started": "自动检测进入模型分析",
    "monitor-gate": "自动检测被门控拦截",
    "monitor-result-ready": "自动检测结果已准备完成",
    "monitor-timeout": "自动检测触发总超时"
  }
};

const timingPrefixes: Record<ScreenVisionTimingKind, string> = {
  vision: "视觉计时",
  chat: "聊天计时",
  monitor: "自动检测计时"
};

interface VisionTimingEntry {
  sequence: number;
  kind: ScreenVisionTimingKind;
  startedAt: number;
  lastLoggedAt: number;
  completedStages: Set<string>;
}

function milliseconds(value: number): string {
  return Math.max(0, value).toFixed(1).padStart(8, " ");
}

export class ScreenVisionTiming {
  private readonly entries = new Map<string, VisionTimingEntry>();
  private readonly events: TimedDiagnosticEvent[] = [];
  private readonly listeners = new Set<VisionTimingListener>();
  private nextSequence = 1;
  private nextEventSequence = 1;

  public constructor(
    readonly enabled: boolean,
    private readonly now: VisionTimingClock = () => Date.now(),
    private readonly write: VisionTimingWriter = () => undefined
  ) {}

  public mark(
    requestId: string,
    phase: ScreenVisionTimingPhase,
    stage: ScreenVisionTimingStage,
    ok = true,
    kind: ScreenVisionTimingKind = "vision"
  ): void {
    if (!this.enabled) return;

    let entry = this.entries.get(requestId);
    if (!entry) {
      const startedAt = this.now();
      entry = {
        sequence: this.nextSequence++,
        kind,
        startedAt,
        lastLoggedAt: startedAt,
        completedStages: new Set()
      };
      this.entries.set(requestId, entry);
    }

    const stageKey = `${phase}:${stage}`;
    if (entry.completedStages.has(stageKey)) return;
    entry.completedStages.add(stageKey);

    const current = this.now();
    const status = ok ? "完成" : "失败";
    const eventSequence = this.nextEventSequence++;
    const event: TimedDiagnosticEvent = {
      module: TIMED_DIAGNOSTICS_TEST_MODULE,
      eventId: `screen:${eventSequence}`,
      group: entry.kind === "chat" ? "chat" : entry.kind === "monitor" ? "monitor" : "vision",
      requestId,
      sequence: entry.sequence,
      phase,
      stage,
      label: stageLabels[entry.kind][stage],
      stepMs: Math.max(0, current - entry.lastLoggedAt),
      totalMs: Math.max(0, current - entry.startedAt),
      ok
    };
    this.events.push(event);
    if (this.events.length > 2_048) this.events.shift();
    for (const listener of this.listeners) listener(event);
    this.write(
      `[${timingPrefixes[entry.kind]} #${entry.sequence}] 累计 ${milliseconds(current - entry.startedAt)} ms | 本步 ${milliseconds(current - entry.lastLoggedAt)} ms | ${status}：${phaseLabels[phase]} · ${stageLabels[entry.kind][stage]}`
    );
    entry.lastLoggedAt = current;

    if (this.entries.size > 128) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest === "string") this.entries.delete(oldest);
    }
  }

  /** TIMED DIAGNOSTICS TEST MODULE: expose bounded timing events to the main window. */
  subscribe(listener: VisionTimingListener): () => void {
    if (!this.enabled) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getEvents(): TimedDiagnosticEvent[] {
    return this.events.slice();
  }
}

export const screenVisionTiming = new ScreenVisionTiming(
  process.env.ZHUOMIANLING_VISION_TIMING === "1"
);
