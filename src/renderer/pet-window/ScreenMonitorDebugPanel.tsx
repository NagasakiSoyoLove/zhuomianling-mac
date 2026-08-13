// TIMED DIAGNOSTICS TEST MODULE: legacy pet-window monitor debug panel.
import { Bug, X } from "lucide-react";
import type { PetUiTheme } from "../../shared/types/pet";
import type { ScreenMonitorDiagnostic } from "../../shared/types/screenMonitorDebug";
import type { ScreenAwarenessPhase } from "./useScreenAwareness";
import {
  screenMonitorDebugEnabled,
  type ScreenMonitorDebugSnapshot
} from "./screenMonitorDebug";

const stageLabels: Record<ScreenMonitorDiagnostic["stage"], string> = {
  capture: "捕获",
  detector: "本地检测",
  gate: "门控",
  model: "模型",
  delivery: "回复投递"
};

const reasonLabels: Record<ScreenMonitorDiagnostic["reason"], string> = {
  started: "已开始等待首帧",
  "capture-failed": "屏幕捕获失败",
  "capture-error": "捕获或读取帧失败",
  "capture-ended": "捕获轨道已结束",
  "frame-encoding-failed": "截图编码失败",
  "frame-transfer-failed": "截图未送达主进程",
  "feature-missing": "本地像素特征缺失",
  baseline: "已建立首帧基线",
  noise: "变化仍在持续确认，继续本地观察",
  candidate: "发现稳定候选",
  "analysis-pending": "上一帧仍在分析",
  "reply-pending": "回复已接受，等待播放",
  "analysis-cooldown": "普通分析间隔冷却中",
  "same-scene-cooldown": "同一场景冷却中",
  "reply-budget": "自动回复次数已达上限",
  "model-silent": "模型判断本次静默",
  "duplicate-reply": "相似回复被抑制",
  "provider-timeout": "视觉模型请求超时",
  "provider-error": "模型请求失败",
  "model-replied": "模型生成了回复",
  "reply-delivered": "回复已交给桌宠"
};

const eventLabels: Record<NonNullable<ScreenMonitorDiagnostic["event"]>, string> = {
  "app-switch": "应用切换",
  "page-change": "页面变化",
  "content-change": "内容变化",
  "same-scene": "首次观察/同场景",
  uncertain: "不确定"
};

const phaseLabels: Record<ScreenAwarenessPhase, string> = {
  inactive: "未开启",
  starting: "启动捕获",
  watching: "捕获中",
  analyzing: "分析中",
  retrying: "重试中",
  error: "异常"
};

function formatChangeRatio(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

function formatStableFor(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return `${Math.round(Math.max(0, value) / 100) / 10}s`;
}

export function describeScreenMonitorDiagnostic(
  diagnostic: ScreenMonitorDiagnostic | undefined
): string {
  if (!diagnostic) return "等待首帧诊断";
  return `${stageLabels[diagnostic.stage]}：${reasonLabels[diagnostic.reason]}`;
}

export function ScreenMonitorDebugPanel({
  theme,
  phase,
  snapshot,
  onClose
}: {
  theme: PetUiTheme;
  phase: ScreenAwarenessPhase;
  snapshot: ScreenMonitorDebugSnapshot;
  onClose: () => void;
}): JSX.Element | null {
  if (!screenMonitorDebugEnabled) return null;

  const diagnostic = snapshot.latest;
  const changeRatio = formatChangeRatio(diagnostic?.changeRatio);
  const stableFor = formatStableFor(diagnostic?.stableForMs);
  const replySimilarity = diagnostic?.replySimilarity === undefined || !Number.isFinite(diagnostic.replySimilarity)
    ? undefined
    : `${Math.round(Math.min(1, Math.max(0, diagnostic.replySimilarity)) * 100)}%`;

  return (
    <section
      className={["screenMonitorDebugPanel", `theme-${theme}`].join(" ")}
      aria-label="屏幕监测诊断"
      role="dialog"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="screenMonitorDebugHeader">
        <span>
          <Bug size={13} />
          屏幕监测诊断
          <small>DEV</small>
        </span>
        <button type="button" title="关闭诊断" onClick={onClose}>
          <X size={13} />
          <span className="srOnly">关闭诊断</span>
        </button>
      </header>
      <div className="screenMonitorDebugBody">
        <p className="screenMonitorDebugStatus">
          <i aria-hidden="true" />
          {phaseLabels[phase]}
        </p>
        <p className="screenMonitorDebugLatest">
          {describeScreenMonitorDiagnostic(diagnostic)}
        </p>
        {diagnostic?.event || changeRatio || stableFor ? (
          <p className="screenMonitorDebugMeta">
            {diagnostic?.event ? `事件：${eventLabels[diagnostic.event]}` : ""}
            {changeRatio ? `${diagnostic?.event ? " · " : ""}变化 ${changeRatio}` : ""}
            {stableFor ? `${diagnostic?.event || changeRatio ? " · " : ""}稳定 ${stableFor}` : ""}
            {replySimilarity ? `${diagnostic?.event || changeRatio || stableFor ? " · " : ""}回复相似度 ${replySimilarity}` : ""}
          </p>
        ) : null}
        <div className="screenMonitorDebugMetrics" aria-label="监测统计">
          <span>采样 <strong>{snapshot.samples}</strong></span>
          <span>候选 <strong>{snapshot.candidates}</strong></span>
          <span>分析 <strong>{snapshot.analyses}</strong></span>
          <span>回复 <strong>{snapshot.replies}</strong></span>
        </div>
        <p className="screenMonitorDebugNote">仅显示阶段、计数和变化率，不保存截图或正文。</p>
      </div>
    </section>
  );
}
