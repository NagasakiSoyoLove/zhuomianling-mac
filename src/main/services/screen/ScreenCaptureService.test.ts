// TIMED DIAGNOSTICS TEST MODULE: capture, detector, and automatic monitor tests.
import { EventEmitter } from "node:events";
import type { Session, WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screenChangeSignatureByteLength } from "../../../shared/screenChangeSignature";
import { ScreenVisionRequestError } from "../../../shared/screenVisionError";
import { ScreenMonitorService } from "./ScreenMonitorService";

const mocks = vi.hoisted(() => ({
  getSources: vi.fn(),
  fromFrame: vi.fn(),
  isPetWindowWebContents: vi.fn(() => true),
  screenVisionService: {
    analyzeDirect: vi.fn(),
    analyzeMonitor: vi.fn()
  },
  moodService: {
    getDisplayState: vi.fn(),
    pauseDecay: vi.fn(),
    resumeDecay: vi.fn()
  },
  registerMoodTextToSpeechSnapshot: vi.fn()
}));

vi.mock("electron", () => ({
  desktopCapturer: {
    getSources: mocks.getSources
  },
  webContents: {
    fromFrame: mocks.fromFrame
  }
}));

vi.mock("../../petWindow", () => ({
  isPetWindowWebContents: mocks.isPetWindowWebContents
}));

vi.mock("./ScreenVisionService", () => ({
  screenVisionService: mocks.screenVisionService
}));

vi.mock("../mood/MoodService", () => ({
  moodService: mocks.moodService
}));

vi.mock("../speech/textToSpeech", () => ({
  registerMoodTextToSpeechSnapshot: mocks.registerMoodTextToSpeechSnapshot
}));

class FakeWebContents extends EventEmitter {
  readonly id = 42;
  destroyed = false;
  readonly send = vi.fn();

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function asWebContents(owner: FakeWebContents): WebContents {
  return owner as unknown as WebContents;
}

function playMonitorReply(
  service: { reportReplyDelivery: (owner: WebContents, request: {
    petId: string;
    sessionId: string;
    replyId: string;
    status: "accepted" | "played" | "dropped";
  }) => void },
  owner: FakeWebContents,
  result: { reply?: { replyId?: string }; sessionId: string },
  petId = "pet-a"
): void {
  const replyId = result.reply?.replyId;
  if (!replyId) return;
  service.reportReplyDelivery(asWebContents(owner), {
    petId,
    sessionId: result.sessionId,
    replyId,
    status: "accepted"
  });
  service.reportReplyDelivery(asWebContents(owner), {
    petId,
    sessionId: result.sessionId,
    replyId,
    status: "played"
  });
}

describe("ScreenCaptureService capture handshake", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.isPetWindowWebContents.mockReturnValue(true);
    mocks.moodService.getDisplayState.mockResolvedValue({
      value: -95,
      rangeId: "darkened",
      label: "黑化"
    });
  });

  it("publishes a pending session before asynchronous source validation finishes", async () => {
    const source = { id: "screen:1", name: "Desktop" };
    const sourceResolvers: Array<(value: typeof source[]) => void> = [];
    mocks.getSources.mockImplementation(
      () => new Promise<typeof source[]>((resolve) => sourceResolvers.push(resolve))
    );

    const owner = new FakeWebContents();
    mocks.fromFrame.mockReturnValue(owner);
    const { ScreenCaptureService } = await import("./ScreenCaptureService");
    const service = new ScreenCaptureService(mocks.screenVisionService as never);
    let displayMediaHandler:
      | ((request: { frame: object; videoRequested: boolean; audioRequested: boolean; userGesture: boolean }, callback: (streams: unknown) => void) => void)
      | undefined;
    const displaySession = {
      setDisplayMediaRequestHandler: (handler: typeof displayMediaHandler): void => {
        displayMediaHandler = handler;
      }
    } as unknown as Session;
    service.configureDisplayMediaHandler(displaySession);

    const startPromise = service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: source.id,
      sourceKind: "screen",
      mode: "quiet",
      purpose: "manual-monitor",
      requestId: "screen-request-1"
    }, true);

    expect(mocks.getSources).toHaveBeenCalledTimes(1);
    const callback = vi.fn();
    displayMediaHandler?.(
      { frame: {}, videoRequested: true, audioRequested: false, userGesture: true },
      callback
    );
    await Promise.resolve();

    expect(mocks.getSources).toHaveBeenCalledTimes(2);
    expect(callback).not.toHaveBeenCalled();

    sourceResolvers[0]([source]);
    await expect(startPromise).resolves.toMatchObject({ ok: true, sessionId: expect.any(String) });
    sourceResolvers[1]([source]);

    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ video: source }));
  });

  it.each(["quiet", "companion"] as const)("runs one initial observation on the first %s frame", async (mode) => {
    const source = { id: "screen:1", name: "Desktop" };
    mocks.getSources.mockResolvedValue([source]);
    mocks.screenVisionService.analyzeMonitor.mockResolvedValue({
      action: "speak",
      event: "same-scene",
      sceneKey: "scene-initial",
      reply: "我看到你现在的画面了。"
    });

    const owner = new FakeWebContents();
    const { ScreenCaptureService } = await import("./ScreenCaptureService");
    const service = new ScreenCaptureService(mocks.screenVisionService as never);
    const started = await service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: source.id,
      sourceKind: "screen",
      mode,
      purpose: "manual-monitor",
      requestId: "screen-request-initial"
    }, true);

    expect(started.ok).toBe(true);
    const result = await service.processFrame(asWebContents(owner), {
      petId: "pet-a",
      sessionId: started.sessionId!,
      frameId: "frame-initial",
      purpose: "manual-monitor",
      frame: {
        data: new Uint8Array([1, 2, 3]),
        pixelSignature: new Uint8Array(screenChangeSignatureByteLength),
        mimeType: "image/jpeg",
        width: 1,
        height: 1,
        capturedAt: 100
      }
    });

    expect(result.reply).toMatchObject({ action: "speak", sceneKey: "scene-initial" });
    expect(mocks.registerMoodTextToSpeechSnapshot).toHaveBeenCalledWith(
      asWebContents(owner),
      "pet-a",
      result.reply?.replyId,
      "darkened"
    );
    expect(mocks.screenVisionService.analyzeMonitor).toHaveBeenCalledTimes(1);
    expect(mocks.screenVisionService.analyzeMonitor.mock.calls[0]?.[5]).toMatchObject({
      initialObservation: true,
      onTiming: expect.any(Function)
    });
    expect(mocks.moodService.pauseDecay).toHaveBeenCalledWith("pet-a", started.sessionId);

    await service.stop(asWebContents(owner), started.sessionId);
    expect(mocks.moodService.resumeDecay).toHaveBeenCalledWith("pet-a", started.sessionId);
  });

  it("does not pause mood decay for a direct screen question", async () => {
    const source = { id: "screen:1", name: "Desktop" };
    mocks.getSources.mockResolvedValue([source]);
    mocks.screenVisionService.analyzeDirect.mockResolvedValue({ reply: "屏幕读取完成。" });

    const owner = new FakeWebContents();
    const { ScreenCaptureService } = await import("./ScreenCaptureService");
    const service = new ScreenCaptureService(mocks.screenVisionService as never);
    const started = await service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: source.id,
      sourceKind: "screen",
      mode: "quiet",
      purpose: "direct-screen-question",
      requestId: "screen-request-direct-no-pause"
    }, true);

    await service.processFrame(asWebContents(owner), {
      petId: "pet-a",
      sessionId: started.sessionId!,
      frameId: "frame-direct-no-pause",
      purpose: "direct-screen-question",
      requestId: "screen-request-direct-no-pause",
      question: "你能看见吗？",
      frame: {
        data: new Uint8Array([1, 2, 3]),
        mimeType: "image/jpeg",
        width: 1,
        height: 1,
        capturedAt: 100
      }
    });

    expect(mocks.moodService.pauseDecay).not.toHaveBeenCalled();
    await service.stop(asWebContents(owner), started.sessionId);
  });

  it("keeps the mood pause and monitoring session when automatic analysis fails", async () => {
    const source = { id: "screen:1", name: "Desktop" };
    mocks.getSources.mockResolvedValue([source]);
    mocks.screenVisionService.analyzeMonitor.mockRejectedValue(
      new ScreenVisionRequestError("provider-network")
    );

    const owner = new FakeWebContents();
    const { ScreenCaptureService } = await import("./ScreenCaptureService");
    const service = new ScreenCaptureService(mocks.screenVisionService as never);
    const started = await service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: source.id,
      sourceKind: "screen",
      mode: "quiet",
      purpose: "manual-monitor",
      requestId: "screen-request-analysis-failure"
    }, true);

    const result = await service.processFrame(asWebContents(owner), {
      petId: "pet-a",
      sessionId: started.sessionId!,
      frameId: "frame-analysis-failure",
      purpose: "manual-monitor",
      frame: {
        data: new Uint8Array([1, 2, 3]),
        pixelSignature: new Uint8Array(screenChangeSignatureByteLength),
        mimeType: "image/jpeg",
        width: 1,
        height: 1,
        capturedAt: 100
      }
    });

    expect(result).toMatchObject({ ok: false, state: "watching", errorCode: "provider-network" });
    expect(mocks.moodService.pauseDecay).toHaveBeenCalledWith("pet-a", started.sessionId);
    expect(mocks.moodService.resumeDecay).not.toHaveBeenCalled();
    expect(service.getState(asWebContents(owner))).toMatchObject({
      sessionId: started.sessionId,
      purpose: "manual-monitor",
      state: "watching"
    });

    await service.stop(asWebContents(owner), started.sessionId);
    expect(mocks.moodService.resumeDecay).toHaveBeenCalledWith("pet-a", started.sessionId);
  });

  it("keeps the monitoring session when a frame has no local change feature", async () => {
    const source = { id: "screen:1", name: "Desktop" };
    mocks.getSources.mockResolvedValue([source]);
    mocks.screenVisionService.analyzeMonitor.mockResolvedValue({
      action: "silent",
      event: "same-scene",
      sceneKey: "scene-feature-baseline",
      reply: ""
    });

    const owner = new FakeWebContents();
    const { ScreenCaptureService } = await import("./ScreenCaptureService");
    const service = new ScreenCaptureService(mocks.screenVisionService as never);
    const started = await service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: source.id,
      sourceKind: "screen",
      mode: "quiet",
      purpose: "manual-monitor",
      requestId: "screen-request-feature-missing"
    }, true);

    await service.processFrame(asWebContents(owner), {
      petId: "pet-a",
      sessionId: started.sessionId!,
      frameId: "frame-feature-baseline",
      purpose: "manual-monitor",
      frame: {
        data: new Uint8Array([1, 2, 3]),
        pixelSignature: new Uint8Array(screenChangeSignatureByteLength),
        mimeType: "image/jpeg",
        width: 1,
        height: 1,
        capturedAt: 100
      }
    });

    const invalid = await service.processFrame(asWebContents(owner), {
      petId: "pet-a",
      sessionId: started.sessionId!,
      frameId: "frame-feature-missing",
      purpose: "manual-monitor",
      frame: {
        data: new Uint8Array([4, 5, 6]),
        mimeType: "image/jpeg",
        width: 1,
        height: 1,
        capturedAt: 200
      }
    });

    expect(invalid).toMatchObject({
      ok: false,
      state: "watching",
      errorCode: "frame-invalid",
      diagnostic: { stage: "detector", reason: "feature-missing" }
    });
    expect(service.getState(asWebContents(owner))).toMatchObject({
      sessionId: started.sessionId,
      state: "watching"
    });
    expect(mocks.moodService.resumeDecay).not.toHaveBeenCalled();

    await service.stop(asWebContents(owner), started.sessionId);
    expect(mocks.moodService.resumeDecay).toHaveBeenCalledWith("pet-a", started.sessionId);
  });

  it("releases the mood pause when the pet renderer is destroyed", async () => {
    const source = { id: "screen:1", name: "Desktop" };
    mocks.getSources.mockResolvedValue([source]);
    mocks.screenVisionService.analyzeMonitor.mockResolvedValue({
      action: "silent",
      event: "same-scene",
      sceneKey: "scene-destroyed",
      reply: ""
    });

    const owner = new FakeWebContents();
    const { ScreenCaptureService } = await import("./ScreenCaptureService");
    const service = new ScreenCaptureService(mocks.screenVisionService as never);
    const started = await service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: source.id,
      sourceKind: "screen",
      mode: "quiet",
      purpose: "manual-monitor",
      requestId: "screen-request-renderer-destroyed"
    }, true);

    await service.processFrame(asWebContents(owner), {
      petId: "pet-a",
      sessionId: started.sessionId!,
      frameId: "frame-renderer-destroyed",
      purpose: "manual-monitor",
      frame: {
        data: new Uint8Array([1, 2, 3]),
        pixelSignature: new Uint8Array(screenChangeSignatureByteLength),
        mimeType: "image/jpeg",
        width: 1,
        height: 1,
        capturedAt: 100
      }
    });

    owner.destroyed = true;
    owner.emit("destroyed");
    await vi.waitFor(() => expect(mocks.moodService.resumeDecay).toHaveBeenCalledWith("pet-a", started.sessionId));
    expect(service.getState(asWebContents(owner))).toBeUndefined();
  });

  it("preserves automatic monitoring while canceling a direct question for click-through", async () => {
    const source = { id: "screen:1", name: "Desktop" };
    mocks.getSources.mockResolvedValue([source]);

    const owner = new FakeWebContents();
    const { ScreenCaptureService } = await import("./ScreenCaptureService");
    const service = new ScreenCaptureService(mocks.screenVisionService as never);
    const manual = await service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: source.id,
      sourceKind: "screen",
      mode: "quiet",
      purpose: "manual-monitor",
      requestId: "screen-request-click-through-manual"
    }, true);

    service.stopDirectQuestionForOwner(asWebContents(owner));
    expect(service.getState(asWebContents(owner))).toMatchObject({
      sessionId: manual.sessionId,
      purpose: "manual-monitor"
    });

    const direct = await service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: source.id,
      sourceKind: "screen",
      mode: "quiet",
      purpose: "direct-screen-question",
      requestId: "screen-request-click-through-direct"
    }, true);
    expect(direct.ok).toBe(true);

    service.stopDirectQuestionForOwner(asWebContents(owner));
    expect(service.getState(asWebContents(owner))).toBeUndefined();
  });

  it("keeps a persistent full-screen session separate from window observation", async () => {
    const screen = { id: "screen:1", name: "Desktop" };
    const windowSource = { id: "window:1", name: "Editor" };
    mocks.getSources.mockResolvedValue([screen, windowSource]);
    mocks.screenVisionService.analyzeDirect.mockImplementation(async (...args: unknown[]) => {
      const onChunk = args[5] as ((chunk: { reply: string }) => void) | undefined;
      onChunk?.({ reply: "正在读取" });
      return { reply: "屏幕读取完成。" };
    });

    const owner = new FakeWebContents();
    const { ScreenCaptureService } = await import("./ScreenCaptureService");
    const service = new ScreenCaptureService(mocks.screenVisionService as never);
    const persistent = await service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: screen.id,
      sourceKind: "screen",
      mode: "quiet",
      purpose: "persistent-capture",
      requestId: "persistent-request-1"
    }, true);
    const manual = await service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: windowSource.id,
      sourceKind: "window",
      mode: "quiet",
      purpose: "manual-monitor",
      requestId: "manual-request-1"
    }, true);

    await service.processFrame(asWebContents(owner), {
      petId: "pet-a",
      sessionId: persistent.sessionId!,
      frameId: "frame-direct-1",
      purpose: "direct-screen-question",
      requestId: "direct-request-1",
      question: "我现在在做什么？",
      context: [{ role: "user", content: "看看屏幕" }],
      frame: {
        data: new Uint8Array([1, 2, 3]),
        mimeType: "image/jpeg",
        width: 1,
        height: 1,
        capturedAt: 100
      }
    });

    expect(mocks.screenVisionService.analyzeDirect).toHaveBeenCalledTimes(1);
    expect(owner.send).toHaveBeenCalledWith(
      "screen-vision:reply-event",
      expect.objectContaining({
        sessionId: persistent.sessionId,
        purpose: "direct-screen-question"
      })
    );
    expect(service.getState(asWebContents(owner))).toMatchObject({
      sessionId: manual.sessionId,
      purpose: "manual-monitor",
      selectedSource: { kind: "window" }
    });
  });

  it("returns the provider-specific error instead of a generic unreadable-screen message", async () => {
    const source = { id: "screen:1", name: "Desktop" };
    mocks.getSources.mockResolvedValue([source]);
    mocks.screenVisionService.analyzeDirect.mockRejectedValue(
      new ScreenVisionRequestError("provider-authentication")
    );

    const owner = new FakeWebContents();
    const { ScreenCaptureService } = await import("./ScreenCaptureService");
    const service = new ScreenCaptureService(mocks.screenVisionService as never);
    const started = await service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: source.id,
      sourceKind: "screen",
      mode: "quiet",
      purpose: "direct-screen-question",
      requestId: "screen-request-auth"
    }, true);

    const result = await service.processFrame(asWebContents(owner), {
      petId: "pet-a",
      sessionId: started.sessionId!,
      frameId: "frame-authentication",
      purpose: "direct-screen-question",
      requestId: "screen-request-auth",
      question: "你能看见吗？",
      frame: {
        data: new Uint8Array([1, 2, 3]),
        mimeType: "image/jpeg",
        width: 1,
        height: 1,
        capturedAt: 100
      }
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: "provider-authentication",
      state: "error"
    });
  });

  it("passes session-only visual history to the next monitor analysis, not ordinary context", async () => {
    const source = { id: "screen:1", name: "Desktop" };
    mocks.getSources.mockResolvedValue([source]);
    mocks.screenVisionService.analyzeMonitor.mockImplementation(async (...args: unknown[]) => {
      const candidate = args[2] as { sceneKey: string; event: "same-scene" | "content-change" | "page-change" | "app-switch" | "uncertain" };
      return {
        action: "speak",
        event: candidate.event,
        sceneKey: candidate.sceneKey,
        reply: "我陪你看着。"
      };
    });

    const owner = new FakeWebContents();
    const { ScreenCaptureService } = await import("./ScreenCaptureService");
    const service = new ScreenCaptureService(mocks.screenVisionService as never);
    const started = await service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: source.id,
      sourceKind: "screen",
      mode: "companion",
      purpose: "manual-monitor",
      requestId: "screen-request-history"
    }, true);
    const signatureA = new Uint8Array(screenChangeSignatureByteLength);
    const signatureB = new Uint8Array(screenChangeSignatureByteLength).fill(255);
    const send = (capturedAt: number, signature: Uint8Array) => service.processFrame(asWebContents(owner), {
      petId: "pet-a",
      sessionId: started.sessionId!,
      frameId: `frame-history-${capturedAt}`,
      purpose: "manual-monitor",
      context: [{ role: "user", content: "这条普通聊天消息不应进入监测" }],
      frame: {
        data: new Uint8Array([capturedAt % 255, 2, 3]),
        pixelSignature: signature,
        mimeType: "image/jpeg",
        width: 1,
        height: 1,
        capturedAt
      }
    });

    const initial = await send(0, signatureA);
    playMonitorReply(service, owner, initial);
    await send(100, signatureB);
    const delivered = await send(1_200, signatureB);
    playMonitorReply(service, owner, delivered);

    expect(mocks.screenVisionService.analyzeMonitor).toHaveBeenCalledTimes(2);
    expect(mocks.screenVisionService.analyzeMonitor.mock.calls[0]?.[5]).toMatchObject({
      initialObservation: true,
      onTiming: expect.any(Function)
    });
    const nextOptions = mocks.screenVisionService.analyzeMonitor.mock.calls[1]?.[5] as {
      visualHistory?: Array<{ frame: { data: Uint8Array }; decision: { reply: string } }>;
    };
    expect(nextOptions.visualHistory).toHaveLength(1);
    expect(nextOptions.visualHistory?.[0]?.frame.data).toEqual(new Uint8Array([0, 2, 3]));
    expect(nextOptions).not.toHaveProperty("context");
  });

  it("does not add a silent monitor decision to visual history", async () => {
    const source = { id: "screen:1", name: "Desktop" };
    mocks.getSources.mockResolvedValue([source]);
    mocks.screenVisionService.analyzeMonitor.mockImplementation(async (...args: unknown[]) => {
      const candidate = args[2] as { sceneKey: string; event: "same-scene" | "content-change" | "page-change" | "app-switch" | "uncertain" };
      return {
        action: "silent",
        event: candidate.event,
        sceneKey: candidate.sceneKey,
        reply: ""
      };
    });

    const owner = new FakeWebContents();
    const { ScreenCaptureService } = await import("./ScreenCaptureService");
    const service = new ScreenCaptureService(
      mocks.screenVisionService as never,
      new ScreenMonitorService({ minimumAnalysisIntervalMs: 0, sameSceneCooldownMs: 0 })
    );
    const started = await service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: source.id,
      sourceKind: "screen",
      mode: "companion",
      purpose: "manual-monitor",
      requestId: "screen-request-silent-history"
    }, true);
    const signatureA = new Uint8Array(screenChangeSignatureByteLength);
    const signatureB = new Uint8Array(screenChangeSignatureByteLength).fill(255);
    const send = (capturedAt: number, signature: Uint8Array) => service.processFrame(asWebContents(owner), {
      petId: "pet-a",
      sessionId: started.sessionId!,
      frameId: `frame-silent-history-${capturedAt}`,
      purpose: "manual-monitor",
      frame: {
        data: new Uint8Array([capturedAt % 255, 2, 3]),
        pixelSignature: signature,
        mimeType: "image/jpeg",
        width: 1,
        height: 1,
        capturedAt
      }
    });

    await send(0, signatureA);
    await send(100, signatureB);
    await send(1_200, signatureB);

    expect(mocks.screenVisionService.analyzeMonitor).toHaveBeenCalledTimes(2);
    expect(mocks.screenVisionService.analyzeMonitor.mock.calls[1]?.[5]).not.toHaveProperty("visualHistory");
  });

  it("keeps timeout fallbacks and the third-timeout notice out of history and reply budget", async () => {
    const source = { id: "screen:1", name: "Desktop" };
    mocks.getSources.mockResolvedValue([source]);
    let calls = 0;
    mocks.screenVisionService.analyzeMonitor.mockImplementation(async (...args: unknown[]) => {
      calls += 1;
      const candidate = args[2] as { event: "same-scene" | "content-change" | "page-change" | "app-switch" | "uncertain"; sceneKey: string };
      if (calls >= 5) {
        return {
          action: "speak" as const,
          event: candidate.event,
          sceneKey: candidate.sceneKey,
          reply: "视觉服务恢复了。"
        };
      }
      return {
        action: "speak" as const,
        event: candidate.event,
        sceneKey: candidate.sceneKey,
        reply: "我刚开始观察，但暂时没看清当前画面。",
        analysisFailure: "timeout" as const
      };
    });

    const owner = new FakeWebContents();
    const { ScreenCaptureService } = await import("./ScreenCaptureService");
    const service = new ScreenCaptureService(
      mocks.screenVisionService as never,
      new ScreenMonitorService({ minimumAnalysisIntervalMs: 0, sameSceneCooldownMs: 0, maxRepliesPerWindow: 1 })
    );
    const started = await service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: source.id,
      sourceKind: "screen",
      mode: "quiet",
      purpose: "manual-monitor",
      requestId: "screen-request-timeout-policy"
    }, true);
    const signatures = [
      new Uint8Array(screenChangeSignatureByteLength),
      new Uint8Array(screenChangeSignatureByteLength).fill(255),
      new Uint8Array(screenChangeSignatureByteLength).fill(128),
      new Uint8Array(screenChangeSignatureByteLength).fill(64),
      new Uint8Array(screenChangeSignatureByteLength).fill(200)
    ];
    const send = (capturedAt: number, signature: Uint8Array) => service.processFrame(asWebContents(owner), {
      petId: "pet-a",
      sessionId: started.sessionId!,
      frameId: `frame-timeout-policy-${capturedAt}`,
      purpose: "manual-monitor",
      frame: {
        data: new Uint8Array([capturedAt % 255, 2, 3]),
        pixelSignature: signature,
        mimeType: "image/jpeg",
        width: 1,
        height: 1,
        capturedAt
      }
    });

    await send(0, signatures[0]!);
    await send(100, signatures[1]!);
    await send(1_300, signatures[1]!);
    await send(1_400, signatures[2]!);
    const thirdTimeout = await send(2_600, signatures[2]!);
    await send(2_700, signatures[3]!);
    const fourthTimeout = await send(3_900, signatures[3]!);
    await send(4_000, signatures[4]!);
    const successful = await send(5_200, signatures[4]!);

    expect(calls).toBe(5);
    expect(thirdTimeout.reply).toMatchObject({
      action: "speak",
      reply: "视觉检测连续超时，请检查网络连接。"
    });
    expect(fourthTimeout.reply).toMatchObject({ action: "silent" });
    expect(fourthTimeout.reply).not.toHaveProperty("reply");
    expect(successful.reply).toMatchObject({ action: "speak", reply: "视觉服务恢复了。" });
    expect(mocks.screenVisionService.analyzeMonitor.mock.calls[1]?.[5]).not.toHaveProperty("visualHistory");
    expect(mocks.screenVisionService.analyzeMonitor.mock.calls[2]?.[5]).not.toHaveProperty("visualHistory");
    expect(mocks.screenVisionService.analyzeMonitor.mock.calls[3]?.[5]).not.toHaveProperty("visualHistory");
    expect(mocks.screenVisionService.analyzeMonitor.mock.calls[4]?.[5]).not.toHaveProperty("visualHistory");
  });

  it("retains a large candidate through analysis cooldown and analyzes the latest frame", async () => {
    const source = { id: "screen:1", name: "Desktop" };
    mocks.getSources.mockResolvedValue([source]);
    let now = 0;
    let analysisCalls = 0;
    mocks.screenVisionService.analyzeMonitor.mockImplementation(async (...args: unknown[]) => {
      analysisCalls += 1;
      const candidate = args[2] as { sceneKey: string; event: "same-scene" | "content-change" | "page-change" | "app-switch" | "uncertain" };
      return {
        action: "speak",
        event: candidate.event,
        sceneKey: candidate.sceneKey,
        reply: `我看到第 ${analysisCalls} 个变化了。`
      };
    });

    const owner = new FakeWebContents();
    const { ScreenCaptureService } = await import("./ScreenCaptureService");
    const service = new ScreenCaptureService(
      mocks.screenVisionService as never,
      new ScreenMonitorService({ now: () => now, minimumAnalysisIntervalMs: 5_000, sameSceneCooldownMs: 0 })
    );
    const started = await service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: source.id,
      sourceKind: "screen",
      mode: "companion",
      purpose: "manual-monitor",
      requestId: "screen-request-cooldown-candidate"
    }, true);
    const signatureA = new Uint8Array(screenChangeSignatureByteLength);
    const signatureB = new Uint8Array(screenChangeSignatureByteLength).fill(255);
    const signatureC = new Uint8Array(screenChangeSignatureByteLength).fill(128);
    const send = (capturedAt: number, signature: Uint8Array, dataSeed: number) => service.processFrame(asWebContents(owner), {
      petId: "pet-a",
      sessionId: started.sessionId!,
      frameId: `frame-cooldown-candidate-${capturedAt}`,
      purpose: "manual-monitor",
      frame: {
        data: new Uint8Array([dataSeed, 2, 3]),
        pixelSignature: signature,
        mimeType: "image/jpeg",
        width: 1,
        height: 1,
        capturedAt
      }
    });

    const initial = await send(0, signatureA, 0);
    playMonitorReply(service, owner, initial);
    await send(100, signatureB, 1);
    now = 100;
    const firstChange = await send(1_200, signatureB, 2);
    playMonitorReply(service, owner, firstChange);
    await send(1_300, signatureC, 3);
    now = 200;
    const cooling = await send(2_400, signatureC, 4);
    expect(cooling.diagnostic).toMatchObject({ stage: "gate", reason: "analysis-cooldown" });
    expect(analysisCalls).toBe(2);

    now = 4_000;
    await send(3_600, signatureC, 5);
    expect(analysisCalls).toBe(2);

    now = 5_101;
    const resumed = await send(4_800, signatureC, 6);
    expect(resumed.reply).toMatchObject({ action: "speak" });
    expect(analysisCalls).toBe(3);
    expect(mocks.screenVisionService.analyzeMonitor.mock.calls[2]?.[1]).toMatchObject({
      data: new Uint8Array([6, 2, 3]),
      capturedAt: 4_800
    });
  });

  it("commits the delivered reply frame as the detector reference", async () => {
    const source = { id: "screen:1", name: "Desktop" };
    mocks.getSources.mockResolvedValue([source]);
    mocks.screenVisionService.analyzeMonitor.mockImplementation(async (...args: unknown[]) => {
      const candidate = args[2] as { sceneKey: string; event: "same-scene" | "content-change" | "page-change" | "app-switch" | "uncertain" };
      return {
        action: "speak",
        event: candidate.event,
        sceneKey: candidate.sceneKey,
        reply: "我陪你看着。"
      };
    });

    const owner = new FakeWebContents();
    const { ScreenCaptureService } = await import("./ScreenCaptureService");
    const service = new ScreenCaptureService(mocks.screenVisionService as never);
    const started = await service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: source.id,
      sourceKind: "screen",
      mode: "companion",
      purpose: "manual-monitor",
      requestId: "screen-request-reference"
    }, true);
    const send = (capturedAt: number, value: number) => service.processFrame(asWebContents(owner), {
      petId: "pet-a",
      sessionId: started.sessionId!,
      frameId: `frame-reference-${capturedAt}`,
      purpose: "manual-monitor",
      frame: {
        data: new Uint8Array([value, 2, 3]),
        pixelSignature: new Uint8Array(screenChangeSignatureByteLength).fill(value),
        mimeType: "image/jpeg",
        width: 1,
        height: 1,
        capturedAt
      }
    });

    const initial = await send(0, 0);
    playMonitorReply(service, owner, initial);
    await send(100, 255);
    await send(1_000, 255);
    await send(1_100, 235);
    const gradualChange = await send(1_200, 215);
    playMonitorReply(service, owner, gradualChange);

    expect(mocks.screenVisionService.analyzeMonitor).toHaveBeenCalledTimes(2);
    expect(gradualChange.diagnostic?.changeRatio).toBeGreaterThan(0.09);
  });

  it("does not retry Electron's one-time callback after a callback failure", async () => {
    const source = { id: "screen:1", name: "Desktop" };
    mocks.getSources.mockResolvedValue([source]);

    const owner = new FakeWebContents();
    mocks.fromFrame.mockReturnValue(owner);
    const { ScreenCaptureService } = await import("./ScreenCaptureService");
    const service = new ScreenCaptureService(mocks.screenVisionService as never);
    let displayMediaHandler:
      | ((request: { frame: object; videoRequested: boolean; audioRequested: boolean; userGesture: boolean }, callback: (streams: unknown) => void) => void)
      | undefined;
    const displaySession = {
      setDisplayMediaRequestHandler: (handler: typeof displayMediaHandler): void => {
        displayMediaHandler = handler;
      }
    } as unknown as Session;
    service.configureDisplayMediaHandler(displaySession);

    await expect(service.startSession(asWebContents(owner), {
      petId: "pet-a",
      sourceId: source.id,
      sourceKind: "screen",
      mode: "quiet",
      purpose: "manual-monitor",
      requestId: "screen-request-once"
    }, true)).resolves.toMatchObject({ ok: true });

    const callback = vi.fn(() => {
      throw new Error("callback already consumed by Electron");
    });
    displayMediaHandler?.(
      { frame: {}, videoRequested: true, audioRequested: false, userGesture: true },
      callback
    );

    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
  });
});
