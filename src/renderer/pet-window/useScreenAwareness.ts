import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AI_CHAT_LIMITS,
  type AiChatImageAttachment,
  type AiChatMessage
} from "../../shared/types/ai";
import {
  screenChangeSignatureChannels,
  screenChangeSignatureHeight,
  screenChangeSignatureWidth
} from "../../shared/screenChangeSignature";
import type {
  ScreenAwarenessAvailability,
  ScreenAwarenessMode,
  ScreenCaptureSessionRequest,
  ScreenCaptureSessionResult,
  ScreenFrame,
  ScreenFramePurpose,
  ScreenFrameResult,
  ScreenSessionPurpose,
  ScreenSourceSummary,
  ScreenVisionFailureCode,
  ScreenVisionPresentationKind,
  ScreenVisionReplyChunk,
  ScreenVisionTimingKind,
  ScreenVisionTimingStage
} from "../../shared/types/screen";
import type { ScreenMonitorDiagnostic } from "../../shared/types/screenMonitorDebug";
import {
  getScreenVisionFailureMessage,
  isScreenVisionRequestError,
  ScreenVisionRequestError
} from "../../shared/screenVisionError";
import { SharedCapturePool, type SharedCaptureLease } from "./screenCapturePool";
import {
  createScreenMonitorDebugSnapshot,
  isScreenMonitorAnalysisDiagnostic,
  isScreenMonitorCandidateDiagnostic,
  screenMonitorDebugEnabled,
  type ScreenMonitorDebugSnapshot
} from "./screenMonitorDebug";

export type ScreenAwarenessPhase = "inactive" | "starting" | "watching" | "analyzing" | "retrying" | "error";

export interface ScreenAwarenessReplyMeta {
  purpose: ScreenSessionPurpose;
  question?: string;
  sessionId?: string;
  replyId?: string;
}

export interface ScreenAwarenessReply {
  reply: string;
  voiceText?: string;
  emotion?: string;
  presentationKind?: ScreenVisionPresentationKind;
}

interface UseScreenAwarenessOptions {
  petId: string;
  enabled: boolean;
  persistentCaptureEnabled: boolean;
  mode?: ScreenAwarenessMode;
  onReply: (reply: ScreenAwarenessReply, meta: ScreenAwarenessReplyMeta) => void | Promise<void>;
  onReplyChunk?: (reply: ScreenVisionReplyChunk, meta: ScreenAwarenessReplyMeta) => void;
  onError?: (message: string) => void;
}

export interface UseScreenAwarenessResult {
  availability?: ScreenAwarenessAvailability;
  sources: ScreenSourceSummary[];
  sourcesLoading: boolean;
  selectedSource?: ScreenSourceSummary;
  mode: ScreenAwarenessMode;
  phase: ScreenAwarenessPhase;
  manualObservationActive: boolean;
  panelOpen: boolean;
  error?: string;
  canUseVision: boolean;
  debugSnapshot: ScreenMonitorDebugSnapshot;
  openPanel: () => void;
  closePanel: () => void;
  refreshSources: () => Promise<void>;
  selectSource: (source: ScreenSourceSummary) => void;
  setMode: (mode: ScreenAwarenessMode) => void;
  startWatching: () => Promise<void>;
  stop: () => Promise<void>;
  stopAll: () => Promise<void>;
  cancelDirectQuestion: () => Promise<void>;
  toggleFromMenu: () => void;
  requestDirectQuestion: (
    question: string,
    context?: AiChatMessage[],
    requestId?: string,
    onFrame?: (screenshot: AiChatImageAttachment) => void
  ) => Promise<{ ok: boolean; errorCode?: ScreenVisionFailureCode; message?: string }>;
}

const frameIntervalMs = 500;
const maximumCanvasWidth = 1_600;
const maximumCanvasHeight = 900;
const maximumFrameBytes = 512 * 1024;
export const screenMonitorMaxConsecutiveFrameFailures = 3;

export type ScreenMonitorFrameFailureKind = "encoding" | "transfer" | "ipc" | "feature";
export type ScreenMonitorFrameFailureCounts = Record<ScreenMonitorFrameFailureKind, number>;

export function createScreenMonitorFrameFailureCounts(): ScreenMonitorFrameFailureCounts {
  return { encoding: 0, transfer: 0, ipc: 0, feature: 0 };
}

export function incrementScreenMonitorFrameFailure(
  counts: ScreenMonitorFrameFailureCounts,
  kind: ScreenMonitorFrameFailureKind
): number {
  counts[kind] += 1;
  return counts[kind];
}

export function clearScreenMonitorFrameFailure(
  counts: ScreenMonitorFrameFailureCounts,
  kind: ScreenMonitorFrameFailureKind
): void {
  counts[kind] = 0;
}

class ScreenMonitorFrameTransportError extends ScreenVisionRequestError {
  public readonly kind: "ipc" | "transfer";

  public constructor(kind: "ipc" | "transfer") {
    super("frame-transfer-failed");
    this.name = "ScreenMonitorFrameTransportError";
    this.kind = kind;
  }
}

function requestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createScreenVisionRequestId(): string {
  return requestId("screen-direct");
}

// TIMED DIAGNOSTICS TEST MODULE: automatic screen-monitor timing instrumentation.
function reportVisionTiming(
  petId: string,
  requestIdValue: string,
  stage: ScreenVisionTimingStage,
  ok = true,
  kind: ScreenVisionTimingKind = "vision"
): void {
  window.desktopPet?.screenMonitor.timing?.({
    petId,
    requestId: requestIdValue,
    kind,
    phase: "renderer",
    stage,
    ok
  });
}

function isActivePhase(phase: ScreenAwarenessPhase): boolean {
  return phase === "starting" || phase === "watching" || phase === "analyzing" || phase === "retrying";
}

function safeScreenError(message: string | undefined, fallback: string): string {
  const normalized = message?.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized ? normalized.slice(0, 240) : fallback;
}

function normalizeScreenVisionError(error: unknown, fallback: ScreenVisionFailureCode): Error {
  if (isScreenVisionRequestError(error)) return error;
  if (error instanceof DOMException && error.name === "AbortError") return error;
  return new ScreenVisionRequestError(fallback);
}

export function screenVisionFailureCodeFromError(
  error: unknown,
  fallback: ScreenVisionFailureCode
): ScreenVisionFailureCode {
  if (isScreenVisionRequestError(error)) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") return "request-canceled";
  return fallback;
}

function screenMonitorCaptureDiagnosticReason(
  code: ScreenVisionFailureCode
): ScreenMonitorDiagnostic["reason"] {
  if (code === "capture-failed") return "capture-failed";
  if (code === "frame-encoding-failed") return "frame-encoding-failed";
  if (code === "frame-transfer-failed") return "frame-transfer-failed";
  return "capture-error";
}

function screenMonitorFrameTransportFailureKind(error: unknown): "ipc" | "transfer" | undefined {
  return error instanceof ScreenMonitorFrameTransportError ? error.kind : undefined;
}

function isScreenMonitorFeatureFailure(result: ScreenFrameResult): boolean {
  const diagnostic = result.diagnostic ?? result.reply?.diagnostic;
  return result.errorCode === "frame-invalid"
    && diagnostic?.stage === "detector"
    && diagnostic.reason === "feature-missing";
}

function isScreenMonitorModelFailure(result: ScreenFrameResult): boolean {
  const diagnostic = result.diagnostic ?? result.reply?.diagnostic;
  return diagnostic?.stage === "model"
    && (diagnostic.reason === "provider-error" || diagnostic.reason === "provider-timeout");
}

function waitForVideoMetadata(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: number | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onMetadata);
      signal.removeEventListener("abort", onAbort);
    };
    const onMetadata = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException("Screen capture canceled.", "AbortError"));
    };
    video.addEventListener("loadedmetadata", onMetadata, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    timer = window.setTimeout(() => {
      cleanup();
      reject(new ScreenVisionRequestError("capture-failed"));
    }, 4_000);
  });
}

interface DisplayCaptureResource {
  stream: MediaStream;
  video: HTMLVideoElement;
}

interface CaptureResourceHandle {
  resource: DisplayCaptureResource;
  release: () => void;
}

function disposeDisplayCapture(resource: DisplayCaptureResource): void {
  resource.video.pause();
  resource.video.srcObject = null;
  resource.stream.getTracks().forEach((track) => track.stop());
}

async function createDisplayCapture(signal: AbortSignal): Promise<DisplayCaptureResource> {
  if (signal.aborted) throw new DOMException("Screen capture canceled.", "AbortError");
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new ScreenVisionRequestError("capture-failed");
  }

  let stream: MediaStream | undefined;
  let video: HTMLVideoElement | undefined;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 2, max: 2 } },
      audio: false
    });
    if (signal.aborted) throw new DOMException("Screen capture canceled.", "AbortError");
    video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    await waitForVideoMetadata(video, signal);
    if (signal.aborted) throw new DOMException("Screen capture canceled.", "AbortError");
    return { stream, video };
  } catch (error) {
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    stream?.getTracks().forEach((track) => track.stop());
    throw normalizeScreenVisionError(error, "capture-failed");
  }
}

async function canvasFrame(video: HTMLVideoElement, signal: AbortSignal): Promise<ScreenFrame> {
  if (signal.aborted) throw new DOMException("Screen capture canceled.", "AbortError");
  const sourceWidth = Math.max(1, video.videoWidth || 1_280);
  const sourceHeight = Math.max(1, video.videoHeight || 720);
  const scale = Math.min(1, maximumCanvasWidth / sourceWidth, maximumCanvasHeight / sourceHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("无法准备屏幕帧。 ");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  try {
    const signatureCanvas = document.createElement("canvas");
    signatureCanvas.width = screenChangeSignatureWidth;
    signatureCanvas.height = screenChangeSignatureHeight;
    try {
      const signatureContext = signatureCanvas.getContext("2d", { alpha: false });
      if (!signatureContext) throw new Error("无法准备屏幕变化特征。 ");
      signatureContext.imageSmoothingEnabled = true;
      signatureContext.drawImage(
        canvas,
        0,
        0,
        screenChangeSignatureWidth,
        screenChangeSignatureHeight
      );
      const pixels = signatureContext.getImageData(
        0,
        0,
        screenChangeSignatureWidth,
        screenChangeSignatureHeight
      ).data;
      const pixelSignature = new Uint8Array(
        screenChangeSignatureWidth * screenChangeSignatureHeight * screenChangeSignatureChannels
      );
      for (let sourceIndex = 0, targetIndex = 0; targetIndex < pixelSignature.length; sourceIndex += 4) {
        pixelSignature[targetIndex++] = pixels[sourceIndex]!;
        pixelSignature[targetIndex++] = pixels[sourceIndex + 1]!;
        pixelSignature[targetIndex++] = pixels[sourceIndex + 2]!;
      }

      let blob: Blob | null = null;
      for (const quality of [0.62, 0.48, 0.36]) {
        blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (blob && blob.size <= maximumFrameBytes) break;
      }
      if (!blob || blob.size > maximumFrameBytes) throw new Error("屏幕帧过大。 ");
      const data = new Uint8Array(await blob.arrayBuffer());
      return {
        data,
        pixelSignature,
        mimeType: "image/jpeg",
        width: canvas.width,
        height: canvas.height,
        capturedAt: Date.now()
      };
    } finally {
      signatureCanvas.width = 1;
      signatureCanvas.height = 1;
    }
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

export function looksLikeDirectScreenQuestion(value: string): boolean {
  return /(屏幕|识屏|看看|看一下|看下|再看看|当前画面|桌面)/u.test(value.trim());
}

export function useScreenAwareness(options: UseScreenAwarenessOptions): UseScreenAwarenessResult {
  const optionsRef = useRef(options);
  const [availability, setAvailability] = useState<ScreenAwarenessAvailability>();
  const availabilityRef = useRef<ScreenAwarenessAvailability>();
  const [sources, setSources] = useState<ScreenSourceSummary[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [selectedSource, setSelectedSource] = useState<ScreenSourceSummary>();
  const selectedSourceRef = useRef<ScreenSourceSummary>();
  const [mode, setModeState] = useState<ScreenAwarenessMode>(options.mode === "companion" ? "companion" : "quiet");
  const modeRef = useRef<ScreenAwarenessMode>(options.mode === "companion" ? "companion" : "quiet");
  const [phase, setPhase] = useState<ScreenAwarenessPhase>("inactive");
  const [manualObservationActive, setManualObservationActive] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [debugSnapshot, setDebugSnapshot] = useState<ScreenMonitorDebugSnapshot>(() => createScreenMonitorDebugSnapshot());
  const phaseRef = useRef<ScreenAwarenessPhase>("inactive");
  const manualObservationActiveRef = useRef(false);
  const generationRef = useRef(0);
  const sessionIdRef = useRef<string>();
  const streamRef = useRef<MediaStream>();
  const videoRef = useRef<HTMLVideoElement>();
  const captureReleaseRef = useRef<(() => void)>();
  const captureControllerRef = useRef<AbortController>();
  const persistentSessionIdRef = useRef<string>();
  const persistentStreamRef = useRef<MediaStream>();
  const persistentVideoRef = useRef<HTMLVideoElement>();
  const persistentCaptureReleaseRef = useRef<(() => void)>();
  const persistentCaptureControllerRef = useRef<AbortController>();
  const persistentCapturePromiseRef = useRef<Promise<{ sessionId: string; stream: MediaStream; video: HTMLVideoElement }> | undefined>();
  const directScreenSourceRef = useRef<ScreenSourceSummary>();
  const activeDirectSessionIdRef = useRef<string>();
  const activeDirectUsesPersistentCaptureRef = useRef(false);
  const timerRef = useRef<number>();
  const captureBusyRef = useRef(false);
  const stopRef = useRef<() => Promise<void>>(async () => undefined);
  const stopAllRef = useRef<() => Promise<void>>(async () => undefined);
  const capturePoolRef = useRef<SharedCapturePool<DisplayCaptureResource>>();
  const activeTimingRequestIdRef = useRef<string>();
  const timingFirstReplyReportedRef = useRef(false);
  const frameFailureCountsRef = useRef<ScreenMonitorFrameFailureCounts>(createScreenMonitorFrameFailureCounts());

  const resetDebugSnapshot = useCallback((latest?: ScreenMonitorDiagnostic): void => {
    if (!screenMonitorDebugEnabled) return;
    setDebugSnapshot(createScreenMonitorDebugSnapshot(latest));
  }, []);

  const recordDebugDiagnostic = useCallback((diagnostic: ScreenMonitorDiagnostic): void => {
    if (!screenMonitorDebugEnabled) return;
    setDebugSnapshot((current) => ({
      ...current,
      candidates: current.candidates + (isScreenMonitorCandidateDiagnostic(diagnostic) ? 1 : 0),
      analyses: current.analyses + (isScreenMonitorAnalysisDiagnostic(diagnostic) ? 1 : 0),
      latest: diagnostic
    }));
  }, []);

  const recordDebugSample = useCallback((): void => {
    if (!screenMonitorDebugEnabled) return;
    setDebugSnapshot((current) => ({ ...current, samples: current.samples + 1 }));
  }, []);

  const recordDebugReplyDelivered = useCallback((diagnostic?: ScreenMonitorDiagnostic): void => {
    if (!screenMonitorDebugEnabled) return;
    setDebugSnapshot((current) => ({
      ...current,
      replies: current.replies + 1,
      latest: {
        stage: "delivery",
        reason: "reply-delivered",
        ...(diagnostic?.event ? { event: diagnostic.event } : {}),
        ...(diagnostic?.changeRatio !== undefined ? { changeRatio: diagnostic.changeRatio } : {}),
        ...(diagnostic?.stableForMs !== undefined ? { stableForMs: diagnostic.stableForMs } : {})
      }
    }));
  }, []);

  if (!capturePoolRef.current) {
    capturePoolRef.current = new SharedCapturePool<DisplayCaptureResource>(
      disposeDisplayCapture,
      (key, resource, invalidate) => {
        for (const track of resource.stream.getTracks()) {
          track.addEventListener("ended", () => {
            if (invalidate()) void stopAllRef.current();
          }, { once: true });
        }
      }
    );
  }

  useLayoutEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    const unsubscribe = window.desktopPet?.screenMonitor.onReplyEvent((event) => {
      if (event.type !== "chunk") return;
      const expectedSessionId = event.purpose === "direct-screen-question"
        ? activeDirectSessionIdRef.current
        : sessionIdRef.current;
      if (!expectedSessionId || event.sessionId !== expectedSessionId) return;
      const reply = event.reply?.trim();
      const voiceText = event.voiceText?.trim();
      if (!reply && !voiceText) return;
      if (
        event.purpose === "direct-screen-question" &&
        activeTimingRequestIdRef.current &&
        !timingFirstReplyReportedRef.current
      ) {
        timingFirstReplyReportedRef.current = true;
        reportVisionTiming(
          optionsRef.current.petId,
          activeTimingRequestIdRef.current,
          "reply-chunk-received"
        );
      }
      optionsRef.current.onReplyChunk?.(
        {
          ...(reply ? { reply } : {}),
          ...(voiceText ? { voiceText } : {}),
          ...(event.protocolTier ? { protocolTier: event.protocolTier } : {})
        },
        { purpose: event.purpose, question: undefined }
      );
    });
    return () => { unsubscribe?.(); };
  }, []);

  useLayoutEffect(() => {
    availabilityRef.current = availability;
  }, [availability]);

  useLayoutEffect(() => {
    selectedSourceRef.current = selectedSource;
  }, [selectedSource]);

  useLayoutEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const setPhaseState = useCallback((next: ScreenAwarenessPhase): void => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const setManualObservationActiveState = useCallback((next: boolean): void => {
    manualObservationActiveRef.current = next;
    setManualObservationActive(next);
  }, []);

  const loadAvailability = useCallback(async (): Promise<void> => {
    try {
      const next = await window.desktopPet?.screenMonitor.getAvailability();
      if (next && next.petId === optionsRef.current.petId) {
        availabilityRef.current = next;
        setAvailability(next);
      }
    } catch {
      availabilityRef.current = undefined;
      setAvailability(undefined);
    }
  }, []);

  const refreshSources = useCallback(async (): Promise<void> => {
    if (!optionsRef.current.enabled) return;
    setSourcesLoading(true);
    try {
      const next = (await window.desktopPet?.screenMonitor.listSources()) ?? [];
      setSources(next);
      directScreenSourceRef.current = next.find((source) => source.kind === "screen");
      const nextSelected = selectedSourceRef.current && next.some((source) => source.id === selectedSourceRef.current?.id)
        ? selectedSourceRef.current
        : next[0];
      selectedSourceRef.current = nextSelected;
      setSelectedSource(nextSelected);
      setError(undefined);
    } catch {
      setError("无法读取屏幕来源，请稍后重试。");
    } finally {
      setSourcesLoading(false);
    }
  }, []);

  const stop = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    captureControllerRef.current?.abort("screen-vision-stopped");
    captureControllerRef.current = undefined;
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = undefined;
    const releaseCapture = captureReleaseRef.current;
    captureReleaseRef.current = undefined;
    streamRef.current = undefined;
    videoRef.current = undefined;
    releaseCapture?.();
    captureBusyRef.current = false;
    frameFailureCountsRef.current = createScreenMonitorFrameFailureCounts();
    setManualObservationActiveState(false);
    setPhaseState("inactive");
    if (sessionId) {
      await window.desktopPet?.screenMonitor.stop({
        petId: optionsRef.current.petId,
        sessionId
      }).catch(() => undefined);
    }
    if (generation !== generationRef.current) return;
  }, [setManualObservationActiveState, setPhaseState]);

  const stopPersistentCapture = useCallback(async (): Promise<void> => {
    persistentCaptureControllerRef.current?.abort("screen-vision-stopped");
    persistentCaptureControllerRef.current = undefined;
    persistentCapturePromiseRef.current = undefined;
    const sessionId = persistentSessionIdRef.current;
    persistentSessionIdRef.current = undefined;
    const releaseCapture = persistentCaptureReleaseRef.current;
    persistentCaptureReleaseRef.current = undefined;
    persistentStreamRef.current = undefined;
    persistentVideoRef.current = undefined;
    releaseCapture?.();
    if (sessionId) {
      await window.desktopPet?.screenMonitor.stop({
        petId: optionsRef.current.petId,
        sessionId
      }).catch(() => undefined);
    }
  }, []);

  const stopAll = useCallback(async (): Promise<void> => {
    await Promise.all([stop(), stopPersistentCapture()]);
  }, [stop, stopPersistentCapture]);

  useLayoutEffect(() => {
    stopRef.current = stop;
    stopAllRef.current = stopAll;
  }, [stop, stopAll]);

  const reportError = useCallback((
    message: string | undefined,
    shouldStop = false,
    errorCode?: ScreenVisionFailureCode
  ): string => {
    const safeMessage = errorCode
      ? getScreenVisionFailureMessage(errorCode)
      : safeScreenError(message, "视觉观察暂时不可用。");
    setError(safeMessage);
    optionsRef.current.onError?.(safeMessage);
    if (shouldStop) void stopRef.current();
    return safeMessage;
  }, []);

  const registerManualFrameFailure = useCallback((
    kind: ScreenMonitorFrameFailureKind,
    errorCode: ScreenVisionFailureCode
  ): boolean => {
    const nextCount = incrementScreenMonitorFrameFailure(frameFailureCountsRef.current, kind);
    if (nextCount >= screenMonitorMaxConsecutiveFrameFailures) {
      reportError(undefined, true, errorCode);
      return true;
    }
    // Keep the session alive and make the retry state explicit. No error
    // callback or voice message is emitted until the third consecutive
    // failure. The next scheduled attempt captures a fresh frame.
    setError(undefined);
    setPhaseState("retrying");
    return false;
  }, [reportError, setPhaseState]);

  const clearManualFrameFailure = useCallback((kind: ScreenMonitorFrameFailureKind): void => {
    clearScreenMonitorFrameFailure(frameFailureCountsRef.current, kind);
  }, []);

  const acquireCaptureHandle = useCallback(async (
    sourceKind: ScreenSourceSummary["kind"],
    sourceId: string,
    signal: AbortSignal
  ): Promise<CaptureResourceHandle> => {
    if (sourceKind === "screen") {
      const lease: SharedCaptureLease<DisplayCaptureResource> = await capturePoolRef.current!.acquire(
        sourceId,
        () => createDisplayCapture(signal)
      );
      return { resource: lease.resource, release: lease.release };
    }
    const resource = await createDisplayCapture(signal);
    return { resource, release: () => disposeDisplayCapture(resource) };
  }, []);

  const ensurePersistentCapture = useCallback(async (): Promise<{
    sessionId: string;
    stream: MediaStream;
    video: HTMLVideoElement;
  } | undefined> => {
    const currentOptions = optionsRef.current;
    const api = window.desktopPet?.screenMonitor;
    if (
      !api ||
      !currentOptions.enabled ||
      !currentOptions.persistentCaptureEnabled ||
      !availabilityRef.current?.canUseVision
    ) return undefined;

    const currentStream = persistentStreamRef.current;
    const currentVideo = persistentVideoRef.current;
    if (
      persistentSessionIdRef.current &&
      currentStream &&
      currentVideo &&
      currentStream.getTracks().some((track) => track.readyState !== "ended")
    ) {
      return { sessionId: persistentSessionIdRef.current, stream: currentStream, video: currentVideo };
    }
    if (persistentCapturePromiseRef.current) {
      return persistentCapturePromiseRef.current.catch(() => undefined);
    }

    let source = directScreenSourceRef.current;
    if (!source) {
      try {
        source = ((await api.listSources()) ?? []).find((candidate) => candidate.kind === "screen");
        directScreenSourceRef.current = source;
      } catch {
        return undefined;
      }
    }
    if (!source) return undefined;

    const captureController = new AbortController();
    persistentCaptureControllerRef.current = captureController;
    const capturePromise = (async (): Promise<{
      sessionId: string;
      stream: MediaStream;
      video: HTMLVideoElement;
    }> => {
      let startResult: ScreenCaptureSessionResult | undefined;
      let captureHandle: CaptureResourceHandle | undefined;
      try {
        const startPromise = api.start({
          petId: currentOptions.petId,
          sourceId: source.id,
          sourceKind: "screen",
          mode: modeRef.current,
          purpose: "persistent-capture",
          requestId: requestId("screen-persistent")
        }).catch((error: unknown) => {
          throw normalizeScreenVisionError(error, "screen-source-unavailable");
        });
        const capturePromise = acquireCaptureHandle("screen", source.id, captureController.signal);
        const [startOutcome, captureOutcome] = await Promise.allSettled([startPromise, capturePromise]);
        if (startOutcome.status === "rejected") {
          if (captureOutcome.status === "fulfilled") captureOutcome.value.release();
          throw startOutcome.reason;
        }
        startResult = startOutcome.value;
        if (!startResult.ok || !startResult.sessionId) {
          if (captureOutcome.status === "fulfilled") captureOutcome.value.release();
          throw new ScreenVisionRequestError(startResult.errorCode ?? "screen-source-unavailable");
        }
        if (captureOutcome.status === "rejected") throw captureOutcome.reason;
        captureHandle = captureOutcome.value;
        if (captureController.signal.aborted) throw new DOMException("Screen capture canceled.", "AbortError");
        persistentSessionIdRef.current = startResult.sessionId;
        persistentStreamRef.current = captureHandle.resource.stream;
        persistentVideoRef.current = captureHandle.resource.video;
        persistentCaptureReleaseRef.current = captureHandle.release;
        const result = {
          sessionId: startResult.sessionId,
          stream: captureHandle.resource.stream,
          video: captureHandle.resource.video
        };
        captureHandle = undefined;
        return result;
      } catch (captureError) {
        captureController.abort("screen-vision-capture-failed");
        captureHandle?.release();
        if (startResult?.sessionId) {
          await api.stop({ petId: currentOptions.petId, sessionId: startResult.sessionId }).catch(() => undefined);
        }
        if (persistentSessionIdRef.current === startResult?.sessionId) persistentSessionIdRef.current = undefined;
        throw normalizeScreenVisionError(captureError, "capture-failed");
      }
    })();
    persistentCapturePromiseRef.current = capturePromise;
    try {
      return await capturePromise;
    } catch (captureError) {
      if ((captureError as DOMException).name !== "AbortError") {
        setError("持续屏幕捕获未能启动，识屏时会临时建立捕获。");
      }
      return undefined;
    } finally {
      if (persistentCapturePromiseRef.current === capturePromise) persistentCapturePromiseRef.current = undefined;
      // Keep the controller while the persistent session is alive so a later
      // stop() can cancel any frame encoding that is using this capture.
      if (
        persistentCaptureControllerRef.current === captureController
        && !persistentSessionIdRef.current
      ) {
        persistentCaptureControllerRef.current = undefined;
      }
    }
  }, [acquireCaptureHandle]);

  const beginCapture = useCallback(async (
    request: Omit<ScreenCaptureSessionRequest, "petId" | "requestId"> & { requestId?: string }
  ): Promise<{ sessionId: string; stream: MediaStream; generation: number }> => {
    const currentOptions = optionsRef.current;
    const api = window.desktopPet?.screenMonitor;
    if (!api || !currentOptions.enabled || !availabilityRef.current?.canUseVision) {
      throw new ScreenVisionRequestError("vision-unavailable");
    }
    void stopRef.current();
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    frameFailureCountsRef.current = createScreenMonitorFrameFailureCounts();
    setError(undefined);
    setPhaseState("starting");
    const captureController = new AbortController();
    captureControllerRef.current = captureController;
    let startResult: ScreenCaptureSessionResult | undefined;
    let captureHandle: CaptureResourceHandle | undefined;
    try {
      const startPromise = api.start({
        ...request,
        petId: currentOptions.petId,
        requestId: request.requestId ?? requestId("screen")
      }).catch((error: unknown) => {
        throw normalizeScreenVisionError(error, "screen-source-unavailable");
      });
      const capturePromise = acquireCaptureHandle(request.sourceKind, request.sourceId, captureController.signal);
      const [startOutcome, captureOutcome] = await Promise.allSettled([startPromise, capturePromise]);
      if (startOutcome.status === "rejected") {
        if (captureOutcome.status === "fulfilled") {
          captureOutcome.value.release();
        }
        throw startOutcome.reason;
      }
      startResult = startOutcome.value;
      if (captureOutcome.status === "rejected") throw captureOutcome.reason;
      captureHandle = captureOutcome.value;
      if (!startResult.ok || !startResult.sessionId) {
        captureHandle.release();
        captureHandle = undefined;
        setPhaseState("error");
        throw new ScreenVisionRequestError(startResult.errorCode ?? "screen-source-unavailable");
      }
      if (generation !== generationRef.current) {
        captureHandle.release();
        captureHandle = undefined;
        await api.stop({ petId: currentOptions.petId, sessionId: startResult.sessionId }).catch(() => undefined);
        throw new DOMException("Screen capture canceled.", "AbortError");
      }
      if (captureController.signal.aborted || generation !== generationRef.current) {
        captureHandle.release();
        captureHandle = undefined;
        await api.stop({ petId: currentOptions.petId, sessionId: startResult.sessionId }).catch(() => undefined);
        throw new DOMException("Screen capture canceled.", "AbortError");
      }
      const stream = captureHandle.resource.stream;
      const video = captureHandle.resource.video;
      if (captureController.signal.aborted || generation !== generationRef.current) {
        captureHandle.release();
        captureHandle = undefined;
        await api.stop({ petId: currentOptions.petId, sessionId: startResult.sessionId }).catch(() => undefined);
        throw new DOMException("Screen capture canceled.", "AbortError");
      }
      sessionIdRef.current = startResult.sessionId;
      streamRef.current = stream;
      videoRef.current = video;
      captureReleaseRef.current = captureHandle.release;
      if (request.sourceKind === "window") {
        stream.getTracks().forEach((track) => {
          track.addEventListener("ended", () => {
            if (streamRef.current === stream) void stopRef.current();
          }, { once: true });
        });
      }
      captureHandle = undefined;
      setPhaseState("watching");
      return { sessionId: startResult.sessionId, stream, generation };
    } catch (captureError) {
      captureController.abort("screen-vision-capture-failed");
      if (captureControllerRef.current === captureController) captureControllerRef.current = undefined;
      captureHandle?.release();
      if (startResult?.sessionId) {
        await api.stop({ petId: currentOptions.petId, sessionId: startResult.sessionId }).catch(() => undefined);
      }
      if (sessionIdRef.current === startResult?.sessionId) sessionIdRef.current = undefined;
      setPhaseState("error");
      throw normalizeScreenVisionError(captureError, "capture-failed");
    }
  }, [acquireCaptureHandle, setPhaseState]);

  const sendFrame = useCallback(async (
    sessionId: string,
    frame: ScreenFrame,
    purpose: ScreenFramePurpose,
    generation: number,
    timingRequestId?: string
  ): Promise<ScreenFrameResult | undefined> => {
    if (generation !== generationRef.current || sessionIdRef.current !== sessionId) return undefined;
    const api = window.desktopPet?.screenMonitor;
    if (!api) throw new ScreenMonitorFrameTransportError("ipc");
    let result: ScreenFrameResult | undefined;
    if (timingRequestId) {
      reportVisionTiming(optionsRef.current.petId, timingRequestId, "frame-sent", true, "monitor");
    }
    try {
      result = await api.frame({
        petId: optionsRef.current.petId,
        sessionId,
        frameId: requestId("frame"),
        purpose,
        ...(timingRequestId ? { requestId: timingRequestId } : {}),
        frame
      });
    } catch {
      if (timingRequestId) {
        reportVisionTiming(optionsRef.current.petId, timingRequestId, "frame-result-received", false, "monitor");
      }
      throw new ScreenMonitorFrameTransportError("ipc");
    }
    if (!result) {
      if (generation !== generationRef.current || sessionIdRef.current !== sessionId) return undefined;
      if (timingRequestId) {
        reportVisionTiming(optionsRef.current.petId, timingRequestId, "frame-result-received", false, "monitor");
      }
      throw new ScreenMonitorFrameTransportError("transfer");
    }
    if (timingRequestId) {
      reportVisionTiming(optionsRef.current.petId, timingRequestId, "frame-result-received", true, "monitor");
    }
    if (generation !== generationRef.current || sessionIdRef.current !== sessionId) return undefined;
    const diagnostic = result.diagnostic ?? result.reply?.diagnostic;
    if (purpose === "manual-monitor" && diagnostic) {
      recordDebugDiagnostic(diagnostic);
    }
    const replyPayload = result.reply;
    const reply = replyPayload?.reply?.trim();
    if (result.ok && reply) {
      await optionsRef.current.onReply({
        reply: reply.slice(0, 4_000),
        ...(replyPayload?.voiceText?.trim() ? { voiceText: replyPayload.voiceText.trim().slice(0, 4_000) } : {}),
        ...(replyPayload?.emotion?.trim() ? { emotion: replyPayload.emotion.trim().slice(0, 128) } : {}),
        ...(replyPayload?.presentationKind ? { presentationKind: replyPayload.presentationKind } : {})
      }, {
        purpose,
        question: undefined,
        sessionId,
        ...(replyPayload?.replyId ? { replyId: replyPayload.replyId } : {})
      });
      if (purpose === "manual-monitor") recordDebugReplyDelivered(diagnostic);
    }
    return result;
  }, [recordDebugDiagnostic, recordDebugReplyDelivered]);

  const scheduleMonitoringFrame = useCallback((sessionId: string, generation: number, delayMs = frameIntervalMs): void => {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void (async () => {
        if (generation !== generationRef.current || sessionIdRef.current !== sessionId) return;
        if (captureBusyRef.current) {
          scheduleMonitoringFrame(sessionId, generation);
          return;
        }
        const video = videoRef.current;
        const stream = streamRef.current;
        if (!video || !stream || stream.getTracks().every((track) => track.readyState === "ended")) {
          recordDebugDiagnostic({ stage: "capture", reason: "capture-ended" });
          reportError("屏幕来源已经结束。", true);
          return;
        }
        captureBusyRef.current = true;
        const timingRequestId = requestId("screen-monitor");
        reportVisionTiming(optionsRef.current.petId, timingRequestId, "request-started", true, "monitor");
        try {
          reportVisionTiming(optionsRef.current.petId, timingRequestId, "frame-encoding-started", true, "monitor");
          let frame: ScreenFrame;
          try {
            frame = await canvasFrame(video, captureControllerRef.current?.signal ?? new AbortController().signal);
          } catch (error) {
            throw normalizeScreenVisionError(error, "frame-encoding-failed");
          }
          if (generation !== generationRef.current || sessionIdRef.current !== sessionId) return;
          clearManualFrameFailure("encoding");
          reportVisionTiming(optionsRef.current.petId, timingRequestId, "frame-encoded", true, "monitor");
          recordDebugSample();
          setPhaseState("analyzing");
          const result = await sendFrame(sessionId, frame, "manual-monitor", generation, timingRequestId);
          if (!result) return;

          // invoke() resolving with a result means IPC completed. A normal
          // main-process result also clears a previously consecutive transfer
          // failure, even when that result is a model-level error.
          clearManualFrameFailure("ipc");
          clearManualFrameFailure("transfer");
          const featureFailure = isScreenMonitorFeatureFailure(result);
          const modelFailure = isScreenMonitorModelFailure(result);
          if (featureFailure) {
            reportVisionTiming(optionsRef.current.petId, timingRequestId, "request-failed", false, "monitor");
            registerManualFrameFailure("feature", "frame-invalid");
          } else {
            clearManualFrameFailure("feature");
            if (!result.ok && !modelFailure) {
              reportVisionTiming(optionsRef.current.petId, timingRequestId, "request-failed", false, "monitor");
              if (result.errorCode === "request-canceled") {
                void stopRef.current();
              } else {
                reportError(result.message, true, result.errorCode ?? "unknown");
              }
            }
          }
        } catch (error) {
          if (generation !== generationRef.current || sessionIdRef.current !== sessionId) return;
          const transportFailureKind = screenMonitorFrameTransportFailureKind(error);
          const errorCode = screenVisionFailureCodeFromError(error, "unknown");
          if (errorCode === "request-canceled") {
            void stopRef.current();
          } else {
            reportVisionTiming(optionsRef.current.petId, timingRequestId, "request-failed", false, "monitor");
            recordDebugDiagnostic({ stage: "capture", reason: screenMonitorCaptureDiagnosticReason(errorCode) });
            if (transportFailureKind) {
              if (transportFailureKind === "transfer") clearManualFrameFailure("ipc");
              registerManualFrameFailure(transportFailureKind, "frame-transfer-failed");
            } else if (errorCode === "frame-encoding-failed") {
              registerManualFrameFailure("encoding", errorCode);
            } else {
              reportError(undefined, true, errorCode);
            }
          }
        } finally {
          captureBusyRef.current = false;
          if (generation === generationRef.current && sessionIdRef.current === sessionId) {
            if (phaseRef.current !== "retrying") setPhaseState("watching");
            scheduleMonitoringFrame(sessionId, generation);
          }
        }
      })();
    }, Math.max(0, delayMs));
  }, [clearManualFrameFailure, recordDebugDiagnostic, recordDebugSample, registerManualFrameFailure, reportError, sendFrame, setPhaseState]);

  const startWatching = useCallback(async (): Promise<void> => {
    const source = selectedSourceRef.current;
    if (!source) {
      reportError("请先选择屏幕或窗口来源。", false);
      return;
    }
    resetDebugSnapshot({ stage: "capture", reason: "started" });
    try {
      const capture = await beginCapture({
        sourceId: source.id,
        sourceKind: source.kind,
        mode: modeRef.current,
        purpose: "manual-monitor"
      });
      setManualObservationActiveState(true);
      setPanelOpen(false);
      scheduleMonitoringFrame(capture.sessionId, capture.generation, 0);
    } catch (captureError) {
      const errorCode = screenVisionFailureCodeFromError(captureError, "capture-failed");
      if (errorCode === "request-canceled") {
        setPhaseState("inactive");
        return;
      }
      recordDebugDiagnostic({ stage: "capture", reason: screenMonitorCaptureDiagnosticReason(errorCode) });
      reportError(undefined, false, errorCode);
    }
  }, [beginCapture, recordDebugDiagnostic, reportError, resetDebugSnapshot, scheduleMonitoringFrame, setManualObservationActiveState]);

  const resolveDirectScreenSource = useCallback(async (): Promise<ScreenSourceSummary | undefined> => {
    if (directScreenSourceRef.current) return directScreenSourceRef.current;
    let nextSources: ScreenSourceSummary[];
    try {
      nextSources = (await window.desktopPet?.screenMonitor.listSources()) ?? [];
    } catch {
      throw new ScreenVisionRequestError("screen-source-unavailable");
    }
    directScreenSourceRef.current = nextSources.find((source) => source.kind === "screen");
    setSources(nextSources);
    return directScreenSourceRef.current;
  }, []);

  const requestDirectQuestion = useCallback(async (
    question: string,
    context: AiChatMessage[] = [],
    providedRequestId?: string,
    onFrame?: (screenshot: AiChatImageAttachment) => void
  ): Promise<{ ok: boolean; errorCode?: ScreenVisionFailureCode; message?: string }> => {
    if (!optionsRef.current.enabled || !availabilityRef.current?.canUseVision) {
      const message = reportError(undefined, false, "vision-unavailable");
      return { ok: false, errorCode: "vision-unavailable", message };
    }
    const timingRequestId = providedRequestId ?? createScreenVisionRequestId();
    activeTimingRequestIdRef.current = timingRequestId;
    timingFirstReplyReportedRef.current = false;
    reportVisionTiming(optionsRef.current.petId, timingRequestId, "request-started");
    activeDirectSessionIdRef.current = undefined;
    activeDirectUsesPersistentCaptureRef.current = false;
    const questionValue = question.slice(0, 8_000);
    const contextValue = context.slice(-AI_CHAT_LIMITS.maxContextMessages);
    const hadManualObservation = manualObservationActiveRef.current;
    let transientCaptureStarted = false;
    let persistentCaptureUsed = false;
    try {
      reportVisionTiming(optionsRef.current.petId, timingRequestId, "capture-requested");
      const persistentCapture = await ensurePersistentCapture();
      let sessionId: string;
      let video: HTMLVideoElement;
      let frameSignal: AbortSignal;

      if (persistentCapture) {
        persistentCaptureUsed = true;
        activeDirectUsesPersistentCaptureRef.current = true;
        sessionId = persistentCapture.sessionId;
        video = persistentCapture.video;
        frameSignal = persistentCaptureControllerRef.current?.signal ?? new AbortController().signal;
      } else {
        reportVisionTiming(optionsRef.current.petId, timingRequestId, "source-list-started");
        const source = await resolveDirectScreenSource();
        reportVisionTiming(optionsRef.current.petId, timingRequestId, "source-list-completed");
        if (!source) {
          reportVisionTiming(optionsRef.current.petId, timingRequestId, "request-failed", false);
          const message = reportError(undefined, false, "screen-source-unavailable");
          return { ok: false, errorCode: "screen-source-unavailable", message };
        }
        const capture = await beginCapture({
          sourceId: source.id,
          sourceKind: "screen",
          mode: modeRef.current,
          purpose: "direct-screen-question",
          requestId: timingRequestId,
          question: questionValue,
          context: contextValue
        });
        transientCaptureStarted = true;
        sessionId = capture.sessionId;
        const currentVideo = videoRef.current;
        if (!currentVideo) throw new ScreenVisionRequestError("capture-failed");
        video = currentVideo;
        frameSignal = captureControllerRef.current?.signal ?? new AbortController().signal;
      }
      activeDirectSessionIdRef.current = sessionId;
      reportVisionTiming(optionsRef.current.petId, timingRequestId, "capture-ready");
      setPhaseState("analyzing");
      reportVisionTiming(optionsRef.current.petId, timingRequestId, "frame-encoding-started");
      let frame: ScreenFrame;
      try {
        frame = await canvasFrame(video, frameSignal);
      } catch (error) {
        throw normalizeScreenVisionError(error, "frame-encoding-failed");
      }
      reportVisionTiming(optionsRef.current.petId, timingRequestId, "frame-encoded");
      const api = window.desktopPet?.screenMonitor;
      if (!api) throw new ScreenVisionRequestError("frame-transfer-failed");
      let result: ScreenFrameResult | undefined;
      reportVisionTiming(optionsRef.current.petId, timingRequestId, "frame-sent");
      try {
        result = await api.frame({
          petId: optionsRef.current.petId,
          sessionId,
          frameId: requestId("frame"),
          purpose: "direct-screen-question",
          requestId: timingRequestId,
          question: questionValue,
          context: contextValue,
          frame
        });
      } catch (error) {
        reportVisionTiming(optionsRef.current.petId, timingRequestId, "frame-result-received", false);
        throw normalizeScreenVisionError(error, "frame-transfer-failed");
      }
      if (!result) {
        reportVisionTiming(optionsRef.current.petId, timingRequestId, "frame-result-received", false);
        throw new ScreenVisionRequestError("frame-transfer-failed");
      }
      reportVisionTiming(optionsRef.current.petId, timingRequestId, "frame-result-received");
      // The screenshot is attached only after invoke() resolves. A rejected
      // IPC validation/transport call must not leave a misleading image in
      // the conversation history as if the model had received it.
      onFrame?.({
        data: frame.data.slice(),
        mimeType: frame.mimeType
      });
      const replyPayload = result?.reply;
      const reply = replyPayload?.reply?.trim();
      if (result?.ok && reply) {
        if (!timingFirstReplyReportedRef.current) {
          timingFirstReplyReportedRef.current = true;
          reportVisionTiming(optionsRef.current.petId, timingRequestId, "reply-chunk-received");
        }
        await optionsRef.current.onReply({
          reply: reply.slice(0, 4_000),
          ...(replyPayload?.voiceText?.trim() ? { voiceText: replyPayload.voiceText.trim().slice(0, 4_000) } : {}),
          ...(replyPayload?.emotion?.trim() ? { emotion: replyPayload.emotion.trim().slice(0, 128) } : {}),
          ...(replyPayload?.presentationKind ? { presentationKind: replyPayload.presentationKind } : {})
        }, {
          purpose: "direct-screen-question",
          question: questionValue,
          sessionId,
          ...(replyPayload?.replyId ? { replyId: replyPayload.replyId } : {})
        });
      } else if (result && !result.ok && result.errorCode !== "request-canceled") {
        reportVisionTiming(optionsRef.current.petId, timingRequestId, "request-failed", false);
        reportError(result.message, false, result.errorCode ?? "unknown");
      }
      activeDirectSessionIdRef.current = undefined;
      activeDirectUsesPersistentCaptureRef.current = false;
      if (transientCaptureStarted) await stopRef.current();
      else setPhaseState(hadManualObservation ? "watching" : "inactive");
      return {
        ok: Boolean(result.ok && reply),
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(!result.ok ? { message: getScreenVisionFailureMessage(result.errorCode ?? "unknown") } : {})
      };
    } catch (captureError) {
      reportVisionTiming(optionsRef.current.petId, timingRequestId, "request-failed", false);
      activeDirectSessionIdRef.current = undefined;
      activeDirectUsesPersistentCaptureRef.current = false;
      if (transientCaptureStarted) await stopRef.current();
      if (persistentCaptureUsed) await stopPersistentCapture();
      const errorCode = screenVisionFailureCodeFromError(captureError, "unknown");
      if (errorCode !== "request-canceled") {
        const message = reportError(undefined, false, errorCode);
        return { ok: false, errorCode, message };
      }
      return { ok: false, errorCode, message: getScreenVisionFailureMessage(errorCode) };
    }
  }, [beginCapture, ensurePersistentCapture, reportError, resolveDirectScreenSource, setPhaseState, stopPersistentCapture]);

  const cancelDirectQuestion = useCallback(async (): Promise<void> => {
    const sessionId = activeDirectSessionIdRef.current;
    if (!sessionId) return;

    activeDirectSessionIdRef.current = undefined;
    const usesPersistentCapture = activeDirectUsesPersistentCaptureRef.current;
    activeDirectUsesPersistentCaptureRef.current = false;
    if (usesPersistentCapture) {
      await stopPersistentCapture();
      setPhaseState(manualObservationActiveRef.current ? "watching" : "inactive");
      return;
    }
    await stop();
  }, [setPhaseState, stop, stopPersistentCapture]);

  const openPanel = useCallback((): void => {
    if (!optionsRef.current.enabled || !availabilityRef.current?.canUseVision) return;
    setPanelOpen(true);
    void refreshSources();
  }, [refreshSources]);

  const closePanel = useCallback((): void => {
    setPanelOpen(false);
    if (isActivePhase(phaseRef.current)) {
      void stopRef.current();
    }
  }, []);

  const toggleFromMenu = useCallback((): void => {
    if (isActivePhase(phaseRef.current)) {
      void stopRef.current();
      return;
    }
    openPanel();
  }, [openPanel]);

  const selectSource = useCallback((source: ScreenSourceSummary): void => {
    selectedSourceRef.current = source;
    setSelectedSource(source);
  }, []);

  const setMode = useCallback((nextMode: ScreenAwarenessMode): void => {
    modeRef.current = nextMode;
    setModeState(nextMode);
  }, []);

  useEffect(() => {
    const nextMode = options.mode === "companion" ? "companion" : "quiet";
    modeRef.current = nextMode;
    setModeState(nextMode);
    void loadAvailability();
  }, [loadAvailability, options.enabled, options.mode, options.petId]);

  useEffect(() => {
    const unsubscribe = window.desktopPet?.petConfig.onChanged((changedPet) => {
      if (!changedPet || changedPet.id === optionsRef.current.petId) void loadAvailability();
    });
    return () => { unsubscribe?.(); };
  }, [loadAvailability]);

  useEffect(() => {
    if (
      options.enabled &&
      options.persistentCaptureEnabled &&
      availability?.canUseVision
    ) {
      void ensurePersistentCapture();
      return;
    }
    void stopPersistentCapture();
  }, [availability, ensurePersistentCapture, options.enabled, options.persistentCaptureEnabled, stopPersistentCapture]);

  useEffect(() => {
    if (!options.enabled) {
      setPanelOpen(false);
      void stopAllRef.current();
    }
  }, [options.enabled]);

  useEffect(() => {
    const stopOnHidden = (): void => {
      if (document.hidden) void stopRef.current();
    };
    const stopOnPageHide = (): void => { void stopAllRef.current(); };
    document.addEventListener("visibilitychange", stopOnHidden);
    window.addEventListener("pagehide", stopOnPageHide);
    return () => {
      document.removeEventListener("visibilitychange", stopOnHidden);
      window.removeEventListener("pagehide", stopOnPageHide);
    };
  }, []);

  useEffect(() => () => { void stopAllRef.current(); }, [options.petId]);

  return {
    availability,
    sources,
    sourcesLoading,
    selectedSource,
    mode,
    phase,
    manualObservationActive,
    panelOpen,
    error,
    canUseVision: Boolean(availability?.canUseVision && options.enabled),
    debugSnapshot,
    openPanel,
    closePanel,
    refreshSources,
    selectSource,
    setMode,
    startWatching,
    stop,
    stopAll,
    cancelDirectQuestion,
    toggleFromMenu,
    requestDirectQuestion
  };
}
