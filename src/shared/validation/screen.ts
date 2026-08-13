import { assertValidPetId } from "./petId";
import { screenChangeSignatureByteLength } from "../screenChangeSignature";
import {
  AI_CHAT_LIMITS,
  isAiChatImageMimeType
} from "../types/ai";
import type {
  ScreenCaptureSessionRequest,
  ScreenFrameRequest,
  ScreenMonitorReplyStatusRequest,
  ScreenSourceKind,
  ScreenVisionConnectionDraft,
  ScreenVisionTimingRequest
} from "../types/screen";

export const SCREEN_LIMITS = Object.freeze({
  maxFrameBytes: 512 * 1024,
  maxPixelSignatureBytes: screenChangeSignatureByteLength,
  maxObjectBudgetBytes: AI_CHAT_LIMITS.maxTotalImageBytes + (512 * 1024),
  maxFrameWidth: 3840,
  maxFrameHeight: 2160,
  maxSourceIdCharacters: 512,
  maxSourceNameCharacters: 256,
  maxSessionIdCharacters: 128,
  maxRequestIdCharacters: 128,
  maxQuestionCharacters: 8_000,
  maxContextMessages: AI_CHAT_LIMITS.maxContextMessages,
  maxContextMessageCharacters: 2_000,
  maxModels: 512
});

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const supportedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是普通对象。`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max) {
    throw new Error(`${label}无效。`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label}无效。`);
  }
  return value;
}

function assertContextMessages(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length > SCREEN_LIMITS.maxContextMessages) {
    throw new Error(`${label}无效。`);
  }
  for (const item of value) {
    const message = record(item, "context message");
    const allowed = new Set(["role", "content", "image"]);
    for (const key of Object.keys(message)) {
      if (!allowed.has(key)) throw new Error(`context message包含不允许字段 ${key}。`);
    }
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") {
      throw new Error("context message role无效。");
    }
    stringValue(message.content, "context message content", SCREEN_LIMITS.maxContextMessageCharacters, true);
    if (message.image === undefined) continue;
    const image = record(message.image, "context message image");
    const imageKeys = new Set(["data", "mimeType"]);
    for (const key of Object.keys(image)) {
      if (!imageKeys.has(key)) throw new Error(`context message image包含不允许字段 ${key}。`);
    }
    if (!isAiChatImageMimeType(image.mimeType)) throw new Error("context message image MIME 无效。");
    if (!(image.data instanceof ArrayBuffer) && !ArrayBuffer.isView(image.data)) {
      throw new Error("context message image data无效。");
    }
    if (image.data.byteLength < 32 || image.data.byteLength > AI_CHAT_LIMITS.maxImageBytes) {
      throw new Error("context message image大小无效。");
    }
  }
}

export function isSupportedScreenMimeType(value: unknown): value is "image/jpeg" | "image/png" | "image/webp" {
  return typeof value === "string" && supportedMimeTypes.has(value);
}

export function assertScreenRequestId(value: unknown, label = "requestId"): string {
  const requestId = stringValue(value, label, SCREEN_LIMITS.maxRequestIdCharacters);
  if (!idPattern.test(requestId)) throw new Error(`${label}格式无效。`);
  return requestId;
}

export function assertScreenSessionId(value: unknown): string {
  const sessionId = stringValue(value, "sessionId", SCREEN_LIMITS.maxSessionIdCharacters);
  if (!sessionIdPattern.test(sessionId)) throw new Error("sessionId格式无效。");
  return sessionId;
}

export function assertScreenVisionConnectionDraft(value: unknown): asserts value is ScreenVisionConnectionDraft {
  const draft = record(value, "视觉连接");
  const allowed = new Set(["petId", "providerName", "baseUrl", "model", "apiKey", "models"]);
  for (const key of Object.keys(draft)) if (!allowed.has(key)) throw new Error(`视觉连接包含不允许字段 ${key}。`);
  assertValidPetId(draft.petId);
  stringValue(draft.providerName, "providerName", 128, true);
  stringValue(draft.baseUrl, "baseUrl", 4_096, true);
  stringValue(draft.model, "model", 512, true);
  stringValue(draft.apiKey, "apiKey", 16_384, true);
  if (draft.models !== undefined) {
    if (!Array.isArray(draft.models) || draft.models.length > SCREEN_LIMITS.maxModels) {
      throw new Error("models无效。");
    }
    for (const item of draft.models) {
      const model = record(item, "model");
      stringValue(model.id, "model.id", 512);
      stringValue(model.name, "model.name", 512);
    }
  }
}

export function assertScreenAwarenessSettingsRequest(value: unknown): void {
  const request = record(value, "视觉设置");
  const allowed = new Set(["petId", "enabled", "mode", "persistentCaptureEnabled"]);
  for (const key of Object.keys(request)) if (!allowed.has(key)) throw new Error(`视觉设置包含不允许字段 ${key}。`);
  assertValidPetId(request.petId);
  if (typeof request.enabled !== "boolean") throw new Error("enabled必须是布尔值。");
  if (request.mode !== undefined && request.mode !== "quiet" && request.mode !== "companion") {
    throw new Error("mode无效。");
  }
  if (request.persistentCaptureEnabled !== undefined && typeof request.persistentCaptureEnabled !== "boolean") {
    throw new Error("persistentCaptureEnabled必须是布尔值。");
  }
}

export function assertScreenSourceSelectionRequest(value: unknown): void {
  const request = record(value, "屏幕来源");
  const allowed = new Set(["petId", "sourceId", "sourceKind", "mode", "purpose", "requestId", "question", "context"]);
  for (const key of Object.keys(request)) if (!allowed.has(key)) throw new Error(`屏幕来源包含不允许字段 ${key}。`);
  assertValidPetId(request.petId);
  stringValue(request.sourceId, "sourceId", SCREEN_LIMITS.maxSourceIdCharacters);
  if (request.sourceKind !== "screen" && request.sourceKind !== "window") throw new Error("sourceKind无效。");
  if (request.mode !== "quiet" && request.mode !== "companion") throw new Error("mode无效。");
  if (request.purpose !== "direct-screen-question" && request.purpose !== "manual-monitor" && request.purpose !== "persistent-capture") throw new Error("purpose无效。");
  if ((request.purpose === "direct-screen-question" || request.purpose === "persistent-capture") && request.sourceKind !== "screen") {
    throw new Error("聊天识屏只能使用整个屏幕。");
  }
  assertScreenRequestId(request.requestId);
  if (request.question !== undefined) stringValue(request.question, "question", 8_000);
  if (request.context !== undefined) {
    assertContextMessages(request.context, "context");
  }
}

export function assertScreenStopRequest(value: unknown): void {
  const request = record(value, "停止视觉请求");
  const allowed = new Set(["petId", "sessionId"]);
  for (const key of Object.keys(request)) if (!allowed.has(key)) throw new Error(`停止视觉请求包含不允许字段 ${key}。`);
  assertValidPetId(request.petId);
  if (request.sessionId !== undefined) assertScreenSessionId(request.sessionId);
}

export function assertScreenMonitorReplyStatusRequest(
  value: unknown
): asserts value is ScreenMonitorReplyStatusRequest {
  const request = record(value, "视觉回复状态");
  const allowed = new Set(["petId", "sessionId", "replyId", "status"]);
  for (const key of Object.keys(request)) {
    if (!allowed.has(key)) throw new Error(`视觉回复状态包含不允许字段 ${key}。`);
  }
  assertValidPetId(request.petId);
  assertScreenSessionId(request.sessionId);
  assertScreenRequestId(request.replyId, "replyId");
  if (request.status !== "accepted" && request.status !== "played" && request.status !== "dropped") {
    throw new Error("视觉回复状态无效。");
  }
}

export function assertScreenVisionTimingRequest(value: unknown): asserts value is ScreenVisionTimingRequest {
  const request = record(value, "视觉计时");
  const allowed = new Set(["petId", "requestId", "kind", "phase", "stage", "ok"]);
  for (const key of Object.keys(request)) if (!allowed.has(key)) throw new Error(`视觉计时包含不允许字段 ${key}。`);
  assertValidPetId(request.petId);
  assertScreenRequestId(request.requestId);
  if (request.kind !== undefined && request.kind !== "vision" && request.kind !== "chat" && request.kind !== "monitor") {
    throw new Error("视觉计时 kind 无效。");
  }
  if (request.phase !== "renderer" && request.phase !== "main" && request.phase !== "vision-model" && request.phase !== "chat-model") {
    throw new Error("视觉计时 phase 无效。");
  }
  const stages = new Set([
    "request-started",
    "source-list-started",
    "source-list-completed",
    "capture-requested",
    "capture-session-received",
    "capture-ready",
    "frame-encoding-started",
    "frame-encoded",
    "frame-sent",
    "frame-result-received",
    "frame-received",
    "request-body-ready",
    "model-request-body-serialized",
    "model-request-started",
    "model-response-headers",
    "model-first-network-chunk",
    "model-first-output",
    "model-action-ready",
    "model-decision-ready",
    "model-output-completed",
    "reply-event-sent",
    "reply-result-ready",
    "reply-chunk-received",
    "bubble-queued",
    "reply-completed",
    "request-failed",
    "detector-started",
    "detector-baseline",
    "detector-noise",
    "detector-candidate",
    "monitor-analysis-started",
    "monitor-gate",
    "monitor-result-ready",
    "monitor-timeout"
  ]);
  if (typeof request.stage !== "string" || !stages.has(request.stage)) throw new Error("视觉计时 stage 无效。");
  if (request.ok !== undefined && typeof request.ok !== "boolean") throw new Error("视觉计时 ok 无效。");
}

export function assertScreenFrameRequest(value: unknown): asserts value is ScreenFrameRequest {
  const request = record(value, "屏幕帧");
  const allowed = new Set(["petId", "sessionId", "frameId", "purpose", "requestId", "question", "context", "frame"]);
  for (const key of Object.keys(request)) if (!allowed.has(key)) throw new Error(`屏幕帧包含不允许字段 ${key}。`);
  assertValidPetId(request.petId);
  assertScreenSessionId(request.sessionId);
  assertScreenRequestId(request.frameId, "frameId");
  if (request.purpose !== "direct-screen-question" && request.purpose !== "manual-monitor") throw new Error("purpose无效。");
  const frame = record(request.frame, "frame");
  const frameKeys = new Set(["data", "pixelSignature", "mimeType", "width", "height", "capturedAt"]);
  for (const key of Object.keys(frame)) if (!frameKeys.has(key)) throw new Error(`frame包含不允许字段 ${key}。`);
  if (!isSupportedScreenMimeType(frame.mimeType)) throw new Error("截图 MIME 类型不受支持。");
  finiteNumber(frame.width, "frame.width", 1, SCREEN_LIMITS.maxFrameWidth);
  finiteNumber(frame.height, "frame.height", 1, SCREEN_LIMITS.maxFrameHeight);
  finiteNumber(frame.capturedAt, "frame.capturedAt", 0, Date.now() + 300_000);
  if (frame.pixelSignature !== undefined) {
    if (!(frame.pixelSignature instanceof Uint8Array) || frame.pixelSignature.byteLength !== SCREEN_LIMITS.maxPixelSignatureBytes) {
      throw new Error("屏幕变化特征无效。");
    }
  }
  const data = frame.data;
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) throw new Error("frame.data必须是二进制数据。");
  if (data.byteLength < 32 || data.byteLength > SCREEN_LIMITS.maxFrameBytes) throw new Error("截图大小无效。");
  if (request.requestId !== undefined) assertScreenRequestId(request.requestId);
  if (request.question !== undefined) stringValue(request.question, "question", SCREEN_LIMITS.maxQuestionCharacters);
  if (request.context !== undefined) {
    assertContextMessages(request.context, "context");
  }
}

export function assertScreenDirectQuestion(value: unknown): void {
  const request = record(value, "识屏问题");
  const allowed = new Set(["petId", "question", "context"]);
  for (const key of Object.keys(request)) if (!allowed.has(key)) throw new Error(`识屏问题包含不允许字段 ${key}。`);
  assertValidPetId(request.petId);
  stringValue(request.question, "question", SCREEN_LIMITS.maxQuestionCharacters);
  if (request.context !== undefined) {
    assertContextMessages(request.context, "context");
  }
}

export function getScreenSourceKind(value: unknown): ScreenSourceKind | undefined {
  return value === "screen" || value === "window" ? value : undefined;
}
