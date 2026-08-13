import { randomUUID } from "node:crypto";
import type {
  ScreenAwarenessMode,
  ScreenMonitorDecision,
  ScreenMonitorReplyDeliveryState,
  ScreenMonitorReplyDeliveryStatus,
  ScreenVisionReply
} from "../../../shared/types/screen";
import type {
  ScreenMonitorDiagnostic,
  ScreenMonitorDiagnosticReason,
  ScreenMonitorDiagnosticStage
} from "../../../shared/types/screenMonitorDebug";
import {
  getScreenVisionFailureMessage,
  isScreenVisionRequestError
} from "../../../shared/screenVisionError";
import type { ScreenDetectorCandidate } from "./ScreenChangeDetector";

export interface ScreenMonitorServiceOptions {
  now?: () => number;
  minimumAnalysisIntervalMs?: number;
  sameSceneCooldownMs?: number;
  replyWindowMs?: number;
  maxRepliesPerWindow?: number;
}

interface ScreenMonitorModePolicy {
  minimumAnalysisIntervalMs: number;
  sameSceneCooldownMs: number;
  maxRepliesPerWindow?: number;
}

interface MonitorSession {
  sessionId: string;
  mode: ScreenAwarenessMode;
  policy: ScreenMonitorModePolicy;
  state: "watching" | "analyzing" | "stopping";
  lastAnalysisAt: number;
  sceneReplies: Map<string, number>;
  recentReplies: Array<{ fingerprint: string; at: number }>;
  replyWindowStartedAt: number;
  repliesInWindow: number;
  pending: boolean;
  lastSceneKey?: string;
  consecutiveTimeouts: number;
  timeoutNoticeShown: boolean;
  pendingReplies: Map<string, PendingMonitorReply>;
}

interface PendingMonitorReply {
  replyId: string;
  sceneKey: string;
  fingerprint: string;
  initialObservation: boolean;
  delivery: ScreenMonitorReplyDeliveryState;
  countsTowardPolicy: boolean;
}

interface ScreenMonitorAnalysisResult extends ScreenMonitorDecision {
  /** Internal metadata; never crosses the monitor IPC response boundary. */
  analysisFailure?: "timeout";
}

export interface ScreenMonitorReplyDeliveryUpdate {
  ok: boolean;
  previous?: ScreenMonitorReplyDeliveryState;
  current?: ScreenMonitorReplyDeliveryState;
}

const maxSceneCooldownEntries = 128;
const timeoutNoticeThreshold = 3;
const timeoutNotice = "视觉检测连续超时，请检查网络连接。";

const defaultModePolicies: Record<ScreenAwarenessMode, ScreenMonitorModePolicy> = {
  quiet: {
    minimumAnalysisIntervalMs: 12_000,
    sameSceneCooldownMs: 90_000,
    maxRepliesPerWindow: 4
  },
  companion: {
    minimumAnalysisIntervalMs: 8_000,
    sameSceneCooldownMs: 30_000
  }
};

function fingerprint(value: string): string {
  return value
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .slice(0, 1_000);
}

function replySimilarity(left: string, right: string): number {
  const a = fingerprint(left);
  const b = fingerprint(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 0;
}

function isSimilarReply(left: string, right: string): boolean {
  // Do not fuzzy-match short, character-based replies. A 3-gram Jaccard
  // threshold made ordinary Chinese replies such as “我看到了变化” and
  // “我看到了页面变化” look duplicated even when their useful detail differed.
  // The monitor prompt already asks the model to avoid repetition; this local
  // gate is only a bounded exact de-duplicator after punctuation/whitespace
  // normalization.
  return replySimilarity(left, right) === 1;
}

function candidateDiagnostic(
  candidate: ScreenDetectorCandidate,
  stage: ScreenMonitorDiagnosticStage,
  reason: ScreenMonitorDiagnosticReason,
  extra: Pick<ScreenMonitorDiagnostic, "replySimilarity"> = {}
): ScreenMonitorDiagnostic {
  return {
    stage,
    reason,
    ...extra,
    event: candidate.event,
    changeRatio: Number.isFinite(candidate.changeRatio)
      ? Math.min(1, Math.max(0, candidate.changeRatio))
      : undefined,
    stableForMs: Number.isFinite(candidate.stableForMs)
      ? Math.max(0, Math.round(candidate.stableForMs))
      : undefined
  };
}

export class ScreenMonitorService {
  private readonly now: () => number;
  private readonly replyWindowMs: number;
  private readonly policyOverrides: Partial<ScreenMonitorModePolicy>;
  private readonly sessions = new Map<string, MonitorSession>();

  public constructor(options: ScreenMonitorServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.replyWindowMs = options.replyWindowMs ?? 5 * 60_000;
    this.policyOverrides = {
      ...(options.minimumAnalysisIntervalMs !== undefined ? { minimumAnalysisIntervalMs: options.minimumAnalysisIntervalMs } : {}),
      ...(options.sameSceneCooldownMs !== undefined ? { sameSceneCooldownMs: options.sameSceneCooldownMs } : {}),
      ...(options.maxRepliesPerWindow !== undefined ? { maxRepliesPerWindow: options.maxRepliesPerWindow } : {})
    };
  }

  private policyFor(mode: ScreenAwarenessMode): ScreenMonitorModePolicy {
    return { ...defaultModePolicies[mode], ...this.policyOverrides };
  }

  public start(sessionId: string, mode: ScreenAwarenessMode): void {
    this.sessions.set(sessionId, {
      sessionId,
      mode,
      policy: this.policyFor(mode),
      state: "watching",
      lastAnalysisAt: Number.NEGATIVE_INFINITY,
      sceneReplies: new Map(),
      recentReplies: [],
      replyWindowStartedAt: this.now(),
      repliesInWindow: 0,
      pending: false,
      consecutiveTimeouts: 0,
      timeoutNoticeShown: false,
      pendingReplies: new Map()
    });
  }

  public stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.state = "stopping";
    this.sessions.delete(sessionId);
  }

  public getState(sessionId: string): MonitorSession["state"] | "watching" {
    return this.sessions.get(sessionId)?.state ?? "watching";
  }

  public getLastSceneKey(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.lastSceneKey;
  }

  private rememberScene(session: MonitorSession, sceneKey: string, at: number): void {
    session.sceneReplies.delete(sceneKey);
    session.sceneReplies.set(sceneKey, at);
    while (session.sceneReplies.size > maxSceneCooldownEntries) {
      const oldest = session.sceneReplies.keys().next().value;
      if (typeof oldest !== "string") break;
      session.sceneReplies.delete(oldest);
    }
  }

  private createReplyId(): string {
    return `screen-reply-${randomUUID()}`;
  }

  private pendingReplyForScene(
    session: MonitorSession,
    sceneKey: string
  ): PendingMonitorReply | undefined {
    return [...session.pendingReplies.values()].find(
      (reply) =>
        reply.sceneKey === sceneKey &&
        reply.delivery !== "dropped" &&
        (reply.countsTowardPolicy || reply.initialObservation)
    );
  }

  private registerPendingReply(
    session: MonitorSession,
    decision: ScreenMonitorDecision,
    initialObservation: boolean,
    countsTowardPolicy: boolean,
    sceneKey = decision.sceneKey
  ): string {
    const replyId = this.createReplyId();
    session.pendingReplies.set(replyId, {
      replyId,
      sceneKey,
      fingerprint: fingerprint(decision.reply),
      initialObservation,
      delivery: "analyzed",
      countsTowardPolicy
    });
    return replyId;
  }

  private commitPlayedReply(session: MonitorSession, pending: PendingMonitorReply, at: number): void {
    pending.delivery = "played";
    session.lastSceneKey = pending.sceneKey;
    if (!pending.countsTowardPolicy) {
      session.pendingReplies.delete(pending.replyId);
      return;
    }

    if (at - session.replyWindowStartedAt >= this.replyWindowMs) {
      session.replyWindowStartedAt = at;
      session.repliesInWindow = 0;
      session.recentReplies = [];
    }
    this.rememberScene(session, pending.sceneKey, at);
    session.recentReplies.push({ fingerprint: pending.fingerprint, at });
    session.recentReplies = session.recentReplies.slice(-8);
    session.repliesInWindow += 1;
    session.pendingReplies.delete(pending.replyId);
  }

  public updateReplyDelivery(
    sessionId: string,
    replyId: string,
    status: ScreenMonitorReplyDeliveryStatus
  ): ScreenMonitorReplyDeliveryUpdate {
    const session = this.sessions.get(sessionId);
    const pending = session?.pendingReplies.get(replyId);
    if (!session || !pending) return { ok: false };

    const previous = pending.delivery;
    if (status === "accepted") {
      if (previous === "analyzed") pending.delivery = "accepted";
      return { ok: true, previous, current: pending.delivery };
    }
    if (status === "dropped") {
      if (previous === "analyzed" || previous === "accepted") {
        pending.delivery = "dropped";
        session.pendingReplies.delete(replyId);
      }
      return { ok: true, previous, current: pending.delivery };
    }

    if (previous === "analyzed" || previous === "accepted") {
      this.commitPlayedReply(session, pending, this.now());
      return { ok: true, previous, current: "played" };
    }
    return { ok: true, previous, current: pending.delivery };
  }

  public async processCandidate(
    sessionId: string,
    candidate: ScreenDetectorCandidate | undefined,
    analyze: () => Promise<ScreenMonitorAnalysisResult>,
    options: { initialObservation?: boolean } = {}
  ): Promise<ScreenVisionReply> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        ok: false,
        message: getScreenVisionFailureMessage("session-invalid"),
        errorCode: "session-invalid",
        state: "error"
      };
    }
    if (!candidate) {
      return {
        ok: true,
        message: "没有检测到需要分析的明显变化。",
        diagnostic: { stage: "detector", reason: "noise" },
        state: "watching"
      };
    }
    if (session.pending) {
      return {
        ok: true,
        message: "正在分析上一个变化。",
        diagnostic: candidateDiagnostic(candidate, "gate", "analysis-pending"),
        state: "analyzing"
      };
    }

    const initialObservation = options.initialObservation === true;
    const now = this.now();
    if (!initialObservation) {
      if (this.pendingReplyForScene(session, candidate.sceneKey)) {
        session.lastSceneKey = candidate.sceneKey;
        return {
          ok: true,
          message: "这条监测回复正在等待播放。",
          sceneKey: candidate.sceneKey,
          diagnostic: candidateDiagnostic(candidate, "gate", "reply-pending"),
          state: "silent"
        };
      }
      const lastSceneAt = session.sceneReplies.get(candidate.sceneKey);
      if (lastSceneAt !== undefined && now - lastSceneAt < session.policy.sameSceneCooldownMs) {
        session.lastSceneKey = candidate.sceneKey;
        return {
          ok: true,
          message: "同一场景仍在冷却中。",
          sceneKey: candidate.sceneKey,
          diagnostic: candidateDiagnostic(candidate, "gate", "same-scene-cooldown"),
          state: "silent"
        };
      }
      if (now - session.lastAnalysisAt < session.policy.minimumAnalysisIntervalMs) {
        return {
          ok: true,
          message: "视觉分析正在冷却。",
          sceneKey: candidate.sceneKey,
          diagnostic: candidateDiagnostic(candidate, "gate", "analysis-cooldown"),
          state: "silent"
        };
      }
      if (now - session.replyWindowStartedAt >= this.replyWindowMs) {
        session.replyWindowStartedAt = now;
        session.repliesInWindow = 0;
        session.recentReplies = [];
      }
      if (
        session.policy.maxRepliesPerWindow !== undefined
        && session.repliesInWindow >= session.policy.maxRepliesPerWindow
      ) {
        return {
          ok: true,
          message: "本段时间的自动回应次数已达到上限。",
          sceneKey: candidate.sceneKey,
          diagnostic: candidateDiagnostic(candidate, "gate", "reply-budget"),
          state: "silent"
        };
      }
    }

    session.pending = true;
    session.state = "analyzing";
    if (!initialObservation) session.lastAnalysisAt = now;
    try {
      const decision = await analyze();
      if (!this.sessions.has(sessionId)) {
        return {
          ok: false,
          message: getScreenVisionFailureMessage("request-canceled"),
          errorCode: "request-canceled",
          state: "error"
        };
      }
      session.pending = false;
      session.state = "watching";
      session.lastSceneKey = candidate.sceneKey;
      if (decision.analysisFailure === "timeout") {
        session.consecutiveTimeouts += 1;
        const initialReply = initialObservation && decision.reply.trim() ? decision.reply.trim() : undefined;
        const shouldNotify = !initialObservation
          && !session.timeoutNoticeShown
          && session.consecutiveTimeouts >= timeoutNoticeThreshold;
        if (shouldNotify) session.timeoutNoticeShown = true;
        const reply = initialReply ?? (shouldNotify ? timeoutNotice : undefined);
        const presentationKind = decision.presentationKind ?? (reply && shouldNotify ? "fallback" : undefined);
        const replyId = reply
          ? this.registerPendingReply(
              session,
              {
                action: "speak",
                event: decision.event,
                sceneKey: candidate.sceneKey,
                reply,
                ...(presentationKind ? { presentationKind } : {})
              },
              initialObservation,
              false,
              candidate.sceneKey
            )
          : undefined;
        return {
          ok: true,
          message: initialReply
            ? "首次观察已完成。"
            : shouldNotify
              ? "视觉检测连续超时。"
              : "视觉观察超时，已静默。",
          ...(reply ? { reply } : {}),
          ...(reply && presentationKind ? { presentationKind } : {}),
          ...(replyId ? { replyId } : {}),
          sceneKey: candidate.sceneKey,
          action: reply ? "speak" : "silent",
          event: decision.event,
          diagnostic: candidateDiagnostic(candidate, "model", "provider-timeout"),
          state: reply ? "watching" : "silent"
        };
      }
      session.consecutiveTimeouts = 0;
      session.timeoutNoticeShown = false;
      if (decision.action !== "speak" || !decision.reply.trim()) {
        if (!initialObservation) this.rememberScene(session, candidate.sceneKey, now);
        session.lastSceneKey = candidate.sceneKey;
        return {
          ok: true,
          message: initialObservation ? "首次观察已完成。" : "这次变化不需要回应。",
          sceneKey: candidate.sceneKey,
          action: "silent",
          event: decision.event,
          diagnostic: candidateDiagnostic(candidate, "model", "model-silent"),
          state: "silent"
        };
      }

      const replyFingerprint = fingerprint(decision.reply);
      const duplicateMatch = !initialObservation
        ? [
            ...session.recentReplies
              .filter((item) => now - item.at < this.replyWindowMs)
              .map((item) => ({ ...item, similarity: replySimilarity(item.fingerprint, replyFingerprint) })),
            ...[...session.pendingReplies.values()]
              .filter((item) => item.delivery !== "dropped")
              .map((item) => ({
                fingerprint: item.fingerprint,
                at: now,
                similarity: replySimilarity(item.fingerprint, replyFingerprint)
              }))
          ]
          .find((item) => isSimilarReply(item.fingerprint, replyFingerprint))
        : undefined;
      const duplicated = Boolean(duplicateMatch);
      if (duplicated) {
        this.rememberScene(session, candidate.sceneKey, now);
        session.lastSceneKey = candidate.sceneKey;
        return {
          ok: true,
          message: "相似回应已被抑制。",
          sceneKey: candidate.sceneKey,
          action: "silent",
          event: decision.event,
          diagnostic: candidateDiagnostic(candidate, "gate", "duplicate-reply", {
            replySimilarity: duplicateMatch?.similarity
          }),
          state: "silent"
        };
      }

      const replyId = this.registerPendingReply(
        session,
        decision,
        initialObservation,
        !initialObservation,
        candidate.sceneKey
      );
      return {
        ok: true,
        message: initialObservation ? "首次观察已完成。" : "视觉观察已完成。",
        reply: decision.reply,
        ...(decision.presentationKind
          ? { presentationKind: decision.presentationKind }
          : {}),
        ...(decision.voiceText ? { voiceText: decision.voiceText } : {}),
        ...(decision.emotion ? { emotion: decision.emotion } : {}),
        replyId,
        sceneKey: candidate.sceneKey,
        action: "speak",
        event: decision.event,
        diagnostic: candidateDiagnostic(candidate, "model", "model-replied"),
        state: "watching"
      };
    } catch (error) {
      if (this.sessions.has(sessionId)) {
        session.pending = false;
        session.state = "watching";
      }
      const errorCode = isScreenVisionRequestError(error) ? error.code : "unknown";
      return {
        ok: false,
        message: getScreenVisionFailureMessage(errorCode),
        errorCode,
        diagnostic: candidateDiagnostic(candidate, "model", "provider-error"),
        state: "error"
      };
    }
  }
}

export function isScreenMonitorReplySimilar(left: string, right: string): boolean {
  return isSimilarReply(left, right);
}

export function calculateScreenMonitorReplySimilarity(left: string, right: string): number {
  return replySimilarity(left, right);
}
