// TIMED DIAGNOSTICS TEST MODULE: timing phase and stage protocol extensions.
import type {
  AiChatMessage,
  AiModelOption,
  AiProtocolTier
} from "./ai";
import type { ScreenMonitorDiagnostic } from "./screenMonitorDebug";

export const screenVisionProbeVersion = 1 as const;

/**
 * The normal per-request limit used by capability probes and direct screen
 * questions. Automatic monitoring has a separate, longer budget because its
 * provider request can spend most of the time waiting for response headers.
 */
export const SCREEN_VISION_REQUEST_TIMEOUT_MS = 12_000;
export const SCREEN_MONITOR_TIMEOUT_MS = 20_000;

export type ScreenVisionProviderProtocol = "openai-compatible" | "gemini-native";
export type ScreenVisionInputFormat = "image_url-data-url" | "inline_data";
export type VisionInputStatus = "tested" | "unsupported" | "unknown";
export type VisionCapabilityState =
  | "untested"
  | "tested"
  | "unsupported"
  | "stale"
  | "transient-error";

export interface VisionCapabilityFingerprint {
  normalizedBaseUrl: string;
  model: string;
  providerProtocol: ScreenVisionProviderProtocol;
  visionInputFormat: ScreenVisionInputFormat;
  probeVersion: typeof screenVisionProbeVersion;
}

export interface VisionCapability {
  visionInput: VisionInputStatus;
  checkedAt: string;
  fingerprint: VisionCapabilityFingerprint;
  probeVersion: typeof screenVisionProbeVersion;
}

export interface ScreenVisionConnectionSummary {
  petId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  models: AiModelOption[];
  hasApiKey: boolean;
  capability?: VisionCapability;
  updatedAt?: string;
}

export interface ScreenVisionConnectionDraft {
  petId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  models?: AiModelOption[];
}

export interface ScreenVisionProbeResult {
  ok: boolean;
  message: string;
  checkedAt: string;
  state: VisionCapabilityState;
  capability?: VisionCapability;
  code?:
    | "API_KEY_REQUIRED"
    | "INVALID_VISION_SETTINGS"
    | "SECURE_STORAGE_UNAVAILABLE"
    | "SECURE_STORAGE_CORRUPTED";
}

export interface ScreenVisionModelListResult {
  ok: boolean;
  message: string;
  checkedAt: string;
  models: AiModelOption[];
  code?: ScreenVisionProbeResult["code"];
}

export interface EffectiveScreenVisionModel {
  kind: "chat" | "independent";
  providerName: string;
  baseUrl: string;
  model: string;
  protocol: ScreenVisionProviderProtocol;
}

export interface ScreenAwarenessAvailability {
  petId: string;
  visionEnabled: boolean;
  persistentCaptureEnabled: boolean;
  mode: ScreenAwarenessMode;
  chatModel?: ScreenVisionConnectionSummary;
  independentModel?: ScreenVisionConnectionSummary;
  chatCapabilityState: VisionCapabilityState;
  independentCapabilityState: VisionCapabilityState;
  effectiveVisionCapabilityState: VisionCapabilityState;
  effectiveVisionModel?: EffectiveScreenVisionModel;
  effectiveVisionCapability?: VisionCapability;
  canUseVision: boolean;
}

export type ScreenSessionPurpose = "direct-screen-question" | "manual-monitor" | "persistent-capture";
export type ScreenFramePurpose = Exclude<ScreenSessionPurpose, "persistent-capture">;
export type ScreenSourceKind = "screen" | "window";
export type ScreenAwarenessMode = "quiet" | "companion";

export type ScreenVisionFailureCode =
  | "vision-unavailable"
  | "screen-source-unavailable"
  | "capture-failed"
  | "frame-encoding-failed"
  | "frame-transfer-failed"
  | "frame-invalid"
  | "session-invalid"
  | "request-canceled"
  | "provider-authentication"
  | "provider-rate-limit"
  | "provider-network"
  | "provider-server"
  | "provider-unsupported"
  | "visual-uncertain"
  | "response-empty"
  | "response-invalid"
  | "unknown";

export interface ScreenSourceSummary {
  id: string;
  name: string;
  kind: ScreenSourceKind;
}

export interface ScreenCaptureSessionRequest {
  petId: string;
  sourceId: string;
  sourceKind: ScreenSourceKind;
  mode: ScreenAwarenessMode;
  purpose: ScreenSessionPurpose;
  requestId: string;
  question?: string;
  context?: AiChatMessage[];
}

export interface ScreenCaptureSessionResult {
  ok: boolean;
  message: string;
  errorCode?: ScreenVisionFailureCode;
  sessionId?: string;
  state: "inactive" | "starting" | "watching" | "stopping" | "error";
}

export interface ScreenFrame {
  data: Uint8Array;
  /** Transient decoded-pixel feature for local change detection; never persisted. */
  pixelSignature?: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  capturedAt: number;
}

export interface ScreenFrameRequest {
  petId: string;
  sessionId: string;
  frameId: string;
  purpose: ScreenFramePurpose;
  requestId?: string;
  question?: string;
  context?: AiChatMessage[];
  frame: ScreenFrame;
}

export interface ScreenObservation {
  sceneKey: string;
  activity: string;
  changeSummary: string;
  visibleTextSummary: string;
  keyPoints: string[];
  confidence: number;
  observedAt: string;
}

export interface ScreenQuestionObservation {
  subject: string;
  activity: string;
  visibleTextSummary: string;
  answerFocus: string;
  keyPoints: string[];
  uncertainPoints: string[];
  confidence: number;
  observedAt: string;
}

export type ScreenMonitorAction = "speak" | "silent";
/** Renderer-only semantic styling for a bounded, non-model fallback reply. */
export type ScreenVisionPresentationKind = "fallback";
export type ScreenMonitorReplyDeliveryStatus = "accepted" | "played" | "dropped";
export type ScreenMonitorReplyDeliveryState =
  | "analyzed"
  | ScreenMonitorReplyDeliveryStatus;
export type ScreenMonitorEvent =
  | "app-switch"
  | "page-change"
  | "content-change"
  | "same-scene"
  | "uncertain";

export interface ScreenMonitorDecision {
  action: ScreenMonitorAction;
  event: ScreenMonitorEvent;
  sceneKey: string;
  reply: string;
  voiceText?: string;
  emotion?: string;
  presentationKind?: ScreenVisionPresentationKind;
}

export interface ScreenVisionReply {
  ok: boolean;
  message: string;
  errorCode?: ScreenVisionFailureCode;
  reply?: string;
  voiceText?: string;
  emotion?: string;
  presentationKind?: ScreenVisionPresentationKind;
  /** Automatic monitor replies are acknowledged by the renderer by this id. */
  replyId?: string;
  sceneKey?: string;
  action?: ScreenMonitorAction;
  event?: ScreenMonitorEvent;
  diagnostic?: ScreenMonitorDiagnostic;
  state: "watching" | "analyzing" | "silent" | "error";
}

export interface ScreenMonitorReplyStatusRequest {
  petId: string;
  sessionId: string;
  replyId: string;
  status: ScreenMonitorReplyDeliveryStatus;
}

export interface ScreenVisionReplyChunk {
  reply?: string;
  voiceText?: string;
  protocolTier?: AiProtocolTier;
  presentationKind?: ScreenVisionPresentationKind;
}

export interface ScreenVisionReplyEvent extends ScreenVisionReplyChunk {
  sessionId: string;
  streamId: string;
  purpose: ScreenSessionPurpose;
  type: "chunk";
}

export type ScreenVisionTimingPhase = "renderer" | "main" | "vision-model" | "chat-model";

export type ScreenVisionTimingKind = "vision" | "chat" | "monitor";

export type ScreenVisionTimingStage =
  | "request-started"
  | "source-list-started"
  | "source-list-completed"
  | "capture-requested"
  | "capture-session-received"
  | "capture-ready"
  | "frame-encoding-started"
  | "frame-encoded"
  | "frame-sent"
  | "frame-result-received"
  | "frame-received"
  | "request-body-ready"
  | "model-request-body-serialized"
  | "model-request-started"
  | "model-response-headers"
  | "model-first-network-chunk"
  | "model-first-output"
  | "model-action-ready"
  | "model-decision-ready"
  | "model-output-completed"
  | "reply-event-sent"
  | "reply-result-ready"
  | "reply-chunk-received"
  | "bubble-queued"
  | "reply-completed"
  | "request-failed"
  | "detector-started"
  | "detector-baseline"
  | "detector-noise"
  | "detector-candidate"
  | "monitor-analysis-started"
  | "monitor-gate"
  | "monitor-result-ready"
  | "monitor-timeout";

export interface ScreenVisionTimingRequest {
  petId: string;
  requestId: string;
  kind?: ScreenVisionTimingKind;
  phase: ScreenVisionTimingPhase;
  stage: ScreenVisionTimingStage;
  ok?: boolean;
}

export interface ScreenFrameResult {
  ok: boolean;
  message: string;
  errorCode?: ScreenVisionFailureCode;
  sessionId: string;
  state: "watching" | "analyzing" | "stopping" | "error";
  diagnostic?: ScreenMonitorDiagnostic;
  reply?: ScreenVisionReply;
}

export interface ScreenMonitorRuntimeState {
  sessionId: string;
  purpose: ScreenSessionPurpose;
  mode: ScreenAwarenessMode;
  state: "inactive" | "starting" | "watching" | "analyzing" | "stopping" | "error";
  selectedSource?: ScreenSourceSummary;
  lastSceneKey?: string;
}

export interface ScreenVisionDirectQuestion {
  question: string;
  context?: AiChatMessage[];
}
