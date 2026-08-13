// TIMED DIAGNOSTICS TEST MODULE: automatic screen capture and monitor timing hooks.
import {
  desktopCapturer,
  webContents,
  type Session,
  type WebContents
} from "electron";
import { randomUUID } from "node:crypto";
import { screenChangeSignatureByteLength } from "../../../shared/screenChangeSignature";
import type {
  ScreenCaptureSessionRequest,
  ScreenCaptureSessionResult,
  ScreenFrameRequest,
  ScreenFrameResult,
  ScreenMonitorReplyStatusRequest,
  ScreenMonitorRuntimeState,
  ScreenSourceSummary,
  ScreenVisionFailureCode,
  ScreenVisionReplyChunk,
  ScreenVisionTimingKind,
  ScreenVisionTimingPhase,
  ScreenVisionTimingStage
} from "../../../shared/types/screen";
import { isPetWindowWebContents } from "../../petWindow";
import { moodService } from "../mood/MoodService";
import { registerMoodTextToSpeechSnapshot } from "../speech/textToSpeech";
import { ScreenChangeDetector, type ScreenDetectorCandidate } from "./ScreenChangeDetector";
import { ScreenMonitorService } from "./ScreenMonitorService";
import {
  screenVisionService,
  type ScreenMonitorAnalysis,
  type ScreenVisionService
} from "./ScreenVisionService";
import {
  getScreenVisionFailureMessage,
  isScreenVisionRequestError
} from "../../../shared/screenVisionError";
import { screenVisionTiming } from "./ScreenVisionTiming";
import {
  appendScreenVisualContext,
  clearScreenVisualContext,
  createScreenVisualContextEntry,
  type ScreenVisualContextEntry
} from "./ScreenVisualContext";

interface ActiveScreenSession {
  sessionId: string;
  owner: WebContents;
  petId: string;
  request: ScreenCaptureSessionRequest;
  source: ScreenSourceSummary;
  controller: AbortController;
  state: ScreenMonitorRuntimeState["state"];
  detector: ScreenChangeDetector;
  initialObservationStarted: boolean;
  visualHistory: ScreenVisualContextEntry[];
  pendingMonitorReplies: Map<string, PendingMonitorReply>;
  moodDecayPauseToken?: string;
  removeLifecycleListeners: () => void;
}

interface PendingMonitorReply {
  frame: ScreenFrameRequest["frame"];
  candidate: ScreenDetectorCandidate;
  analysis: ScreenMonitorAnalysis;
}

function sourceKindFromId(sourceId: string): "screen" | "window" | undefined {
  if (sourceId.startsWith("screen:")) return "screen";
  if (sourceId.startsWith("window:")) return "window";
  return undefined;
}

function isSafeSourceName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 256) || "未命名来源";
}

const displayMediaSessionWaitMs = 500;
const displayMediaSessionPollMs = 10;
const screenDetectorOptions = {
  quiet: { stableWaitMs: 1_200, noiseThreshold: 0.02, candidateThreshold: 0.15 },
  companion: { stableWaitMs: 900, noiseThreshold: 0.02, candidateThreshold: 0.09 }
} as const;

export class ScreenCaptureService {
  private readonly screenVision: ScreenVisionService;
  private readonly monitor: ScreenMonitorService;
  private readonly sessions = new Map<number, ActiveScreenSession>();
  private readonly persistentSessions = new Map<number, ActiveScreenSession>();
  private readonly pendingCaptureSessions = new Map<number, ActiveScreenSession>();
  private handlerRegistered = false;

  public constructor(
    screenVision: ScreenVisionService = screenVisionService,
    monitor: ScreenMonitorService = new ScreenMonitorService()
  ) {
    this.screenVision = screenVision;
    this.monitor = monitor;
  }

  private markTiming(
    session: ActiveScreenSession,
    phase: ScreenVisionTimingPhase,
    stage: ScreenVisionTimingStage,
    ok = true,
    requestId = session.request.requestId
  ): void {
    if (session.request.purpose !== "direct-screen-question" && !requestId) return;
    const kind: ScreenVisionTimingKind = session.request.purpose === "manual-monitor"
      ? "monitor"
      : "vision";
    screenVisionTiming.mark(requestId, phase, stage, ok, kind);
  }

  /**
   * Screen replies use the external renderer path, so they do not go through
   * the normal AI-chat mood snapshot registration.
   */
  private async registerMoodVoiceSnapshot(
    owner: WebContents,
    petId: string,
    voiceSessionId: string
  ): Promise<void> {
    try {
      const mood = await moodService.getDisplayState(petId);
      registerMoodTextToSpeechSnapshot(owner, petId, voiceSessionId, mood.rangeId);
    } catch {
      // Mood snapshot setup must not prevent the screen reply from arriving.
    }
  }

  private async waitForActiveSession(owner: WebContents): Promise<ActiveScreenSession | undefined> {
    const deadline = Date.now() + displayMediaSessionWaitMs;
    while (Date.now() < deadline) {
      const active = this.pendingCaptureSessions.get(owner.id) ?? this.sessions.get(owner.id) ?? this.persistentSessions.get(owner.id);
      if (active) return active;
      await new Promise<void>((resolve) => setTimeout(resolve, displayMediaSessionPollMs));
    }
    return this.pendingCaptureSessions.get(owner.id) ?? this.sessions.get(owner.id) ?? this.persistentSessions.get(owner.id);
  }

  private sessionMapFor(session: ActiveScreenSession): Map<number, ActiveScreenSession> {
    return session.request.purpose === "persistent-capture" ? this.persistentSessions : this.sessions;
  }

  private findSession(owner: WebContents, sessionId: string): ActiveScreenSession | undefined {
    const transient = this.sessions.get(owner.id);
    if (transient?.sessionId === sessionId) return transient;
    const persistent = this.persistentSessions.get(owner.id);
    return persistent?.sessionId === sessionId ? persistent : undefined;
  }

  private async stopSession(session: ActiveScreenSession): Promise<void> {
    session.removeLifecycleListeners();
    session.controller.abort("screen-vision-stopped");
    this.monitor.stop(session.sessionId);
    session.detector.reset();
    clearScreenVisualContext(session.visualHistory);
    session.pendingMonitorReplies.clear();
    this.sessionMapFor(session).delete(session.owner.id);
    if (this.pendingCaptureSessions.get(session.owner.id) === session) {
      this.pendingCaptureSessions.delete(session.owner.id);
    }
    const moodDecayPauseToken = session.moodDecayPauseToken;
    session.moodDecayPauseToken = undefined;
    if (moodDecayPauseToken) {
      await moodService.resumeDecay(session.petId, moodDecayPauseToken);
    }
  }

  public async stopTransientForOwner(owner: WebContents): Promise<void> {
    const session = this.sessions.get(owner.id);
    if (session) await this.stopSession(session);
  }

  public async stopDirectQuestionForOwner(owner: WebContents): Promise<void> {
    const session = this.sessions.get(owner.id);
    if (session?.request.purpose === "direct-screen-question") {
      await this.stopSession(session);
    }
  }

  private async stopPersistentForOwner(owner: WebContents): Promise<void> {
    const session = this.persistentSessions.get(owner.id);
    if (session) await this.stopSession(session);
  }

  private pauseMoodDecayForManualMonitor(session: ActiveScreenSession): void {
    if (session.request.purpose !== "manual-monitor" || session.moodDecayPauseToken) return;
    session.moodDecayPauseToken = session.sessionId;
    moodService.pauseDecay(session.petId, session.moodDecayPauseToken);
  }

  public configureDisplayMediaHandler(targetSession: Session): void {
    if (this.handlerRegistered) return;
    this.handlerRegistered = true;
    targetSession.setDisplayMediaRequestHandler((request, callback) => {
      let callbackSettled = false;
      const respondOnce = (streams: Parameters<typeof callback>[0]): void => {
        if (callbackSettled) return;
        callbackSettled = true;
        try {
          callback(streams);
        } catch {
          // Electron owns this one-time callback. Once attempted, no fallback
          // path may call it again.
        }
      };
      const owner = request.frame ? webContents.fromFrame(request.frame.top ?? request.frame) : undefined;
      const ownerDestroyed = owner?.isDestroyed() ?? false;
      const ownerIsPet = Boolean(owner && !ownerDestroyed && isPetWindowWebContents(owner));
      if (
        !owner ||
        ownerDestroyed ||
        !ownerIsPet ||
        !request.videoRequested ||
        request.audioRequested
      ) {
        respondOnce({});
        return;
      }

      void (async () => {
        const active = this.pendingCaptureSessions.get(owner.id)
          ?? this.sessions.get(owner.id)
          ?? this.persistentSessions.get(owner.id)
          ?? await this.waitForActiveSession(owner);
        if (!active || owner.isDestroyed() || active.controller.signal.aborted) {
          respondOnce({});
          return;
        }
        try {
          const sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
            thumbnailSize: { width: 1, height: 1 },
            fetchWindowIcons: false
          });
          const source = sources.find((candidate) => candidate.id === active.request.sourceId);
          const sourceKindValid = Boolean(source && sourceKindFromId(source.id) === active.request.sourceKind);
          const sessionAborted = active.controller.signal.aborted;
          if (!source || !sourceKindValid || sessionAborted) {
            respondOnce({});
            return;
          }
          respondOnce({ video: { id: source.id, name: source.name } });
        } catch {
          respondOnce({});
        }
      })().catch(() => {
        respondOnce({});
      });
    });
  }

  public async listSources(owner: WebContents): Promise<ScreenSourceSummary[]> {
    if (owner.isDestroyed() || !isPetWindowWebContents(owner)) return [];
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false
    });
    return sources.flatMap((source) => {
      const kind = sourceKindFromId(source.id);
      if (!kind) return [];
      return [{ id: source.id.slice(0, 512), name: isSafeSourceName(source.name), kind }];
    });
  }

  public async startSession(
    owner: WebContents,
    request: ScreenCaptureSessionRequest,
    canUseVision: boolean
  ): Promise<ScreenCaptureSessionResult> {
    const ownerDestroyed = owner.isDestroyed();
    const ownerIsPet = !ownerDestroyed && isPetWindowWebContents(owner);
    if (ownerDestroyed || !ownerIsPet || !canUseVision) {
      return {
        ok: false,
        message: getScreenVisionFailureMessage("vision-unavailable"),
        errorCode: "vision-unavailable",
        state: "error"
      };
    }
    if (
      (request.purpose === "direct-screen-question" || request.purpose === "persistent-capture") &&
      request.sourceKind !== "screen"
    ) {
      return {
        ok: false,
        message: getScreenVisionFailureMessage("frame-invalid"),
        errorCode: "frame-invalid",
        state: "error"
      };
    }

    if (request.purpose === "direct-screen-question") {
      screenVisionTiming.mark(request.requestId, "main", "capture-session-received");
    }

    const previousSession = request.purpose === "persistent-capture"
      ? this.persistentSessions.get(owner.id)
      : this.sessions.get(owner.id);
    if (previousSession) await this.stopSession(previousSession);
    const sessionId = `screen-${randomUUID()}`;
    const session: ActiveScreenSession = {
      sessionId,
      owner,
      petId: request.petId,
      request,
      source: {
        id: request.sourceId,
        name: "",
        kind: request.sourceKind
      },
      controller: new AbortController(),
      state: "starting",
      detector: new ScreenChangeDetector(screenDetectorOptions[request.mode]),
      initialObservationStarted: false,
      visualHistory: [],
      pendingMonitorReplies: new Map(),
      removeLifecycleListeners: () => undefined
    };
    this.sessionMapFor(session).set(owner.id, session);
    this.pendingCaptureSessions.set(owner.id, session);
    if (request.purpose !== "persistent-capture") {
      this.monitor.start(sessionId, request.mode);
    }
    const cleanup = (): void => { void this.stopForOwner(owner); };
    session.removeLifecycleListeners = (): void => {
      owner.removeListener("destroyed", cleanup);
      owner.removeListener("render-process-gone", cleanup);
    };
    owner.once("destroyed", cleanup);
    owner.once("render-process-gone", cleanup);

    let sources: ScreenSourceSummary[];
    try {
      sources = await this.listSources(owner);
    } catch {
      await this.stopSession(session);
      return {
        ok: false,
        message: getScreenVisionFailureMessage("screen-source-unavailable"),
        errorCode: "screen-source-unavailable",
        state: "error"
      };
    }
    if (this.sessionMapFor(session).get(owner.id) !== session || session.controller.signal.aborted) {
      return {
        ok: false,
        message: getScreenVisionFailureMessage("request-canceled"),
        errorCode: "request-canceled",
        state: "error"
      };
    }
    const source = sources.find((candidate) => candidate.id === request.sourceId && candidate.kind === request.sourceKind);
    if (!source) {
      await this.stopSession(session);
      return {
        ok: false,
        message: getScreenVisionFailureMessage("screen-source-unavailable"),
        errorCode: "screen-source-unavailable",
        state: "error"
      };
    }
    session.source = source;
    return { ok: true, message: "已准备屏幕来源，请确认开始观察。", sessionId, state: "starting" };
  }

  public async processFrame(owner: WebContents, request: ScreenFrameRequest): Promise<import("../../../shared/types/screen").ScreenFrameResult> {
    const session = this.findSession(owner, request.sessionId);
    const persistentDirectQuestion = session?.request.purpose === "persistent-capture" && request.purpose === "direct-screen-question";
    const purposeMatches = session?.request.purpose === request.purpose || persistentDirectQuestion;
    if (!session || session.petId !== request.petId || !purposeMatches) {
      return {
        ok: false,
        message: getScreenVisionFailureMessage("session-invalid"),
        errorCode: "session-invalid",
        sessionId: request.sessionId,
        state: "error"
      };
    }
    if (session.controller.signal.aborted) {
      return {
        ok: false,
        message: getScreenVisionFailureMessage("request-canceled"),
        errorCode: "request-canceled",
        sessionId: request.sessionId,
        state: "error"
      };
    }
    const directQuestion = request.purpose === "direct-screen-question";
    if (directQuestion && session.request.sourceKind !== "screen") {
      return {
        ok: false,
        message: getScreenVisionFailureMessage("frame-invalid"),
        errorCode: "frame-invalid",
        sessionId: request.sessionId,
        state: "error"
      };
    }
    const timingRequestId = request.requestId ?? session.request.requestId;
    session.state = directQuestion ? "analyzing" : "watching";
    const frame = request.frame;
    if (directQuestion) {
      await this.registerMoodVoiceSnapshot(owner, session.petId, session.request.requestId);
      this.markTiming(session, "main", "frame-received", true, timingRequestId);
      try {
        const result = await this.screenVision.analyzeDirect(
          session.petId,
          frame,
          request.question ?? session.request.question ?? "请分析我刚刚要求查看的当前屏幕。",
          request.context ?? session.request.context ?? [],
          session.controller.signal,
          (chunk) => this.emitReplyChunk(owner, session, request.frameId, request.purpose, chunk, timingRequestId),
          (phase, stage, ok) => this.markTiming(session, phase, stage, ok, timingRequestId)
        );
        if (this.findSession(owner, request.sessionId)?.sessionId !== request.sessionId) {
          return {
            ok: false,
            message: getScreenVisionFailureMessage("request-canceled"),
            errorCode: "request-canceled",
            sessionId: request.sessionId,
            state: "error"
          };
        }
        session.state = "watching";
        this.markTiming(session, "main", "reply-result-ready", true, timingRequestId);
        return {
          ok: true,
          message: "识屏完成。",
          sessionId: request.sessionId,
          state: "watching",
          reply: {
            ok: true,
            message: "识屏完成。",
            reply: result.reply,
            ...(result.voiceText ? { voiceText: result.voiceText } : {}),
            ...(result.emotion ? { emotion: result.emotion } : {}),
            state: "watching"
          }
        };
      } catch (error) {
        if (this.findSession(owner, request.sessionId)?.sessionId !== request.sessionId || session.controller.signal.aborted) {
          this.markTiming(session, "main", "request-failed", false, timingRequestId);
          return {
            ok: false,
            message: getScreenVisionFailureMessage("request-canceled"),
            errorCode: "request-canceled",
            sessionId: request.sessionId,
            state: "error"
          };
        }
        session.state = "error";
        this.markTiming(session, "main", "request-failed", false, timingRequestId);
        const errorCode: ScreenVisionFailureCode = isScreenVisionRequestError(error)
          ? error.code
          : "unknown";
        return {
          ok: false,
          message: getScreenVisionFailureMessage(errorCode),
          errorCode,
          sessionId: request.sessionId,
          state: "error"
        };
      }
    }

    this.markTiming(session, "main", "frame-received", true, timingRequestId);
    this.markTiming(session, "main", "detector-started", true, timingRequestId);

    if (!frame.pixelSignature || frame.pixelSignature.length !== screenChangeSignatureByteLength) {
      // A missing local feature is a bad frame, not a dead monitoring session.
      // Keep the capture and mood-decay lease alive so the renderer can retry
      // with a newly captured frame and apply its consecutive-failure policy.
      session.state = "watching";
      this.markTiming(session, "main", "detector-noise", false, timingRequestId);
      return {
        ok: false,
        message: "屏幕变化特征缺失，请重新启动观察。",
        errorCode: "frame-invalid",
        sessionId: request.sessionId,
        diagnostic: { stage: "detector", reason: "feature-missing" },
        state: "watching"
      };
    }

    // The first valid frame marks the point at which automatic monitoring is
    // actually receiving the screen. Starting a session alone (or a direct
    // question/persistent capture) must not pause mood decay.
    this.pauseMoodDecayForManualMonitor(session);

    const detectorResult = session.detector.observe({
      signature: frame.pixelSignature,
      sourceKey: `${session.source.kind}:${session.source.name}`,
      capturedAt: frame.capturedAt
    });
    if (detectorResult.kind === "baseline") {
      this.markTiming(session, "main", "detector-baseline", true, timingRequestId);
      session.state = "watching";
      if (session.initialObservationStarted) {
        return {
          ok: true,
          message: "画面基线已建立。",
          sessionId: request.sessionId,
          diagnostic: { stage: "detector", reason: "baseline" },
          state: "watching"
        };
      }

      session.initialObservationStarted = true;
      return this.processMonitorCandidate(
        owner,
        session,
        request.sessionId,
        frame,
        {
          sceneKey: "scene-initial",
          event: "same-scene",
          changeRatio: 0,
          stableForMs: 0
        },
        true,
        timingRequestId
      );
    }
    if (detectorResult.kind !== "candidate") {
      this.markTiming(session, "main", "detector-noise", true, timingRequestId);
      session.state = "watching";
      return {
        ok: true,
        message: "画面变化仍在本地观察中。",
        sessionId: request.sessionId,
        diagnostic: {
          stage: "detector",
          reason: "noise",
          ...(detectorResult.changeRatio !== undefined ? { changeRatio: detectorResult.changeRatio } : {})
        },
        state: "watching"
      };
    }
    if (!detectorResult.candidate) {
      this.markTiming(session, "main", "detector-noise", true, timingRequestId);
      session.state = "watching";
      return {
        ok: true,
        message: "画面变化仍在本地观察中。",
        sessionId: request.sessionId,
        diagnostic: {
          stage: "detector",
          reason: "noise",
          ...(detectorResult.changeRatio !== undefined ? { changeRatio: detectorResult.changeRatio } : {})
        },
        state: "watching"
      };
    }
    this.markTiming(session, "main", "detector-candidate", true, timingRequestId);
    return this.processMonitorCandidate(
      owner,
      session,
      request.sessionId,
      frame,
      detectorResult.candidate,
      false,
      timingRequestId
    );
  }

  private async processMonitorCandidate(
    owner: WebContents,
    session: ActiveScreenSession,
    sessionId: string,
    frame: ScreenFrameRequest["frame"],
    candidate: ScreenDetectorCandidate,
    initialObservation = false,
    timingRequestId = session.request.requestId
  ): Promise<ScreenFrameResult> {
    if (this.sessions.get(owner.id) !== session || session.controller.signal.aborted) {
      return {
        ok: false,
        message: getScreenVisionFailureMessage("request-canceled"),
        errorCode: "request-canceled",
        sessionId,
        state: "error"
      };
    }

    session.state = "analyzing";
    this.markTiming(session, "main", "monitor-analysis-started", true, timingRequestId);
    let deliveredAnalysis: ScreenMonitorAnalysis | undefined;
    const monitorReply = await this.monitor.processCandidate(
      session.sessionId,
      candidate,
      async () => {
        const analysis = await this.screenVision.analyzeMonitor(
          session.petId,
          frame,
          candidate,
          session.request.mode,
          session.controller.signal,
          {
            initialObservation,
            ...(session.visualHistory.length ? { visualHistory: session.visualHistory.slice() } : {}),
            onTiming: (phase, stage, ok) => this.markTiming(session, phase, stage, ok, timingRequestId)
          }
        );
        deliveredAnalysis = analysis;
        return analysis;
      },
      { initialObservation }
    );
    if (deliveredAnalysis?.analysisFailure === "timeout") {
      this.markTiming(session, "main", "monitor-timeout", false, timingRequestId);
    } else if (monitorReply.diagnostic?.stage === "gate") {
      this.markTiming(session, "main", "monitor-gate", true, timingRequestId);
    } else {
      this.markTiming(session, "main", "monitor-result-ready", monitorReply.ok, timingRequestId);
    }
    const modelFailure = monitorReply.diagnostic?.stage === "model"
      && monitorReply.diagnostic.reason === "provider-error";
    if (this.sessions.get(owner.id)?.sessionId === sessionId) {
      const retryableGate = monitorReply.diagnostic?.stage === "gate"
        && (
          monitorReply.diagnostic.reason === "analysis-cooldown" ||
          monitorReply.diagnostic.reason === "analysis-pending"
        );
      if (monitorReply.replyId && monitorReply.action === "speak" && monitorReply.reply?.trim() && deliveredAnalysis) {
        await this.registerMoodVoiceSnapshot(owner, session.petId, monitorReply.replyId);
        session.pendingMonitorReplies.set(monitorReply.replyId, {
          frame,
          candidate,
          analysis: deliveredAnalysis
        });
        if (deliveredAnalysis.analysisFailure === "timeout") {
          session.detector.discardCandidate(candidate.sceneKey);
        }
      } else if (!retryableGate) {
        session.detector.discardCandidate(candidate.sceneKey);
      }
      // Provider/model failures are retryable analysis outcomes. They must not
      // tear down the active capture or release the mood-decay lease.
      session.state = modelFailure || monitorReply.state !== "error" ? "watching" : "error";
    } else {
      return {
        ok: false,
        message: getScreenVisionFailureMessage("request-canceled"),
        errorCode: "request-canceled",
        sessionId,
        state: "error"
      };
    }
    if (monitorReply.state === "error" && !modelFailure) {
      await this.stopSession(session);
    }
    const returnedState = modelFailure
      ? "watching"
      : monitorReply.state === "analyzing"
        ? "analyzing"
        : monitorReply.state === "error"
          ? "error"
          : "watching";
    return {
      ok: monitorReply.ok,
      message: monitorReply.message,
      sessionId,
      state: returnedState,
      ...(monitorReply.errorCode ? { errorCode: monitorReply.errorCode } : {}),
      ...(monitorReply.diagnostic ? { diagnostic: monitorReply.diagnostic } : {}),
      reply: monitorReply
    };
  }

  private emitReplyChunk(
    owner: WebContents,
    session: ActiveScreenSession,
    streamId: string,
    purpose: ScreenFrameRequest["purpose"],
    chunk: ScreenVisionReplyChunk,
    timingRequestId?: string
  ): void {
    if (owner.isDestroyed() || this.findSession(owner, session.sessionId) !== session || session.controller.signal.aborted) {
      return;
    }
    const reply = chunk.reply?.trim().slice(0, 32 * 1024);
    const voiceText = chunk.voiceText?.trim().slice(0, 32 * 1024);
    if (!reply && !voiceText) return;
    this.markTiming(session, "main", "reply-event-sent", true, timingRequestId);
    owner.send("screen-vision:reply-event", {
      sessionId: session.sessionId,
      streamId,
      purpose,
      type: "chunk",
      ...(reply ? { reply } : {}),
      ...(voiceText ? { voiceText } : {}),
      ...(chunk.presentationKind ? { presentationKind: chunk.presentationKind } : {}),
      ...(chunk.protocolTier ? { protocolTier: chunk.protocolTier } : {})
    });
  }

  public reportReplyDelivery(owner: WebContents, request: ScreenMonitorReplyStatusRequest): void {
    const session = this.findSession(owner, request.sessionId);
    if (
      !session ||
      session.petId !== request.petId ||
      session.request.purpose !== "manual-monitor" ||
      session.controller.signal.aborted
    ) {
      return;
    }

    const update = this.monitor.updateReplyDelivery(
      session.sessionId,
      request.replyId,
      request.status
    );
    if (!update.ok) return;

    if (request.status === "dropped") {
      if (update.previous === "analyzed" || update.previous === "accepted") {
        const pending = session.pendingMonitorReplies.get(request.replyId);
        session.pendingMonitorReplies.delete(request.replyId);
        if (pending) session.detector.discardCandidate(pending.candidate.sceneKey);
      }
      return;
    }

    if (request.status !== "played" || update.previous === "played") return;
    const pending = session.pendingMonitorReplies.get(request.replyId);
    session.pendingMonitorReplies.delete(request.replyId);
    if (!pending || pending.analysis.analysisFailure === "timeout" || !pending.frame.pixelSignature) {
      if (pending) session.detector.discardCandidate(pending.candidate.sceneKey);
      return;
    }

    session.detector.commitReplyReference({
      signature: pending.frame.pixelSignature,
      sourceKey: `${session.source.kind}:${session.source.name}`,
      capturedAt: pending.frame.capturedAt
    }, pending.candidate.sceneKey);
    appendScreenVisualContext(
      session.visualHistory,
      createScreenVisualContextEntry(
        pending.frame,
        session.request.mode,
        pending.candidate,
        pending.analysis,
        pending.analysis.observation
      )
    );
  }

  public getState(owner: WebContents): ScreenMonitorRuntimeState | undefined {
    const session = this.sessions.get(owner.id) ?? this.persistentSessions.get(owner.id);
    if (!session) return undefined;
    const monitorState = session.request.purpose === "persistent-capture"
      ? undefined
      : this.monitor.getState(session.sessionId);
    return {
      sessionId: session.sessionId,
      purpose: session.request.purpose,
      mode: session.request.mode,
      state: monitorState === "analyzing" ? "analyzing" : session.state,
      selectedSource: session.source,
      lastSceneKey: this.monitor.getLastSceneKey(session.sessionId)
    };
  }

  public async stop(owner: WebContents, sessionId?: string): Promise<boolean> {
    if (sessionId) {
      const session = this.findSession(owner, sessionId);
      if (!session) return false;
      await this.stopSession(session);
      return true;
    }
    const session = this.sessions.get(owner.id) ?? this.persistentSessions.get(owner.id);
    if (!session) return false;
    await this.stopForOwner(owner);
    return true;
  }

  public async stopForOwner(owner: WebContents): Promise<void> {
    await Promise.all([
      this.stopTransientForOwner(owner),
      this.stopPersistentForOwner(owner)
    ]);
  }

  public async stopForPet(petId: string): Promise<void> {
    const owners = new Set<WebContents>();
    for (const session of [...this.sessions.values(), ...this.persistentSessions.values()]) {
      if (session.petId === petId) owners.add(session.owner);
    }
    await Promise.all([...owners].map((owner) => this.stopForOwner(owner)));
  }

  public async stopPersistentForPet(petId: string): Promise<void> {
    for (const session of [...this.persistentSessions.values()]) {
      if (session.petId === petId) await this.stopSession(session);
    }
  }

  public async stopAll(): Promise<void> {
    const owners = new Set<WebContents>();
    for (const session of [...this.sessions.values(), ...this.persistentSessions.values()]) owners.add(session.owner);
    await Promise.all([...owners].map((owner) => this.stopForOwner(owner)));
  }
}

export const screenCaptureService = new ScreenCaptureService();
