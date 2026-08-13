// TIMED DIAGNOSTICS TEST MODULE: screen timing IPC validation tests.
import { describe, expect, it } from "vitest";
import { screenChangeSignatureByteLength } from "../screenChangeSignature";
import {
  assertScreenAwarenessSettingsRequest,
  assertScreenFrameRequest,
  assertScreenMonitorReplyStatusRequest,
  assertScreenSessionId,
  assertScreenSourceSelectionRequest,
  assertScreenVisionTimingRequest,
  SCREEN_LIMITS
} from "./screen";

function validFrame(overrides: Record<string, unknown> = {}) {
  return {
    petId: "pet-a",
    sessionId: "screen-session-0001",
    frameId: "frame-1",
    purpose: "manual-monitor",
    frame: {
      data: new Uint8Array(64),
      mimeType: "image/jpeg",
      width: 1_280,
      height: 720,
      capturedAt: Date.now(),
      ...overrides
    }
  };
}

describe("screen vision validation", () => {
  it("accepts a bounded screenshot and the supported MIME types", () => {
    expect(() => assertScreenFrameRequest(validFrame())).not.toThrow();
    expect(() => assertScreenFrameRequest(validFrame({
      pixelSignature: new Uint8Array(screenChangeSignatureByteLength)
    }))).not.toThrow();
    for (const mimeType of ["image/png", "image/webp"] as const) {
      expect(() => assertScreenFrameRequest(validFrame({ mimeType }))).not.toThrow();
    }
    expect(() => assertScreenFrameRequest({
      ...validFrame(),
      purpose: "direct-screen-question",
      context: [{
        role: "user",
        content: "上一张图",
        image: { data: new Uint8Array(64), mimeType: "image/jpeg" }
      }]
    })).not.toThrow();
  });

  it("rejects unsupported MIME types, dimensions and oversized data", () => {
    expect(() => assertScreenFrameRequest(validFrame({ mimeType: "text/plain" }))).toThrow(/MIME/);
    expect(() => assertScreenFrameRequest(validFrame({ width: 0 }))).toThrow(/width/);
    expect(() => assertScreenFrameRequest(validFrame({ height: SCREEN_LIMITS.maxFrameHeight + 1 }))).toThrow(/height/);
    expect(() => assertScreenFrameRequest(validFrame({ data: new Uint8Array(SCREEN_LIMITS.maxFrameBytes + 1) }))).toThrow(/大小/);
    expect(() => assertScreenFrameRequest(validFrame({ data: new Uint8Array(31) }))).toThrow(/大小/);
    expect(() => assertScreenFrameRequest(validFrame({
      pixelSignature: new Uint8Array(screenChangeSignatureByteLength - 1)
    }))).toThrow(/特征/);
  });

  it("rejects cross-pet, malformed session and unknown request fields", () => {
    expect(() => assertScreenFrameRequest({ ...validFrame(), petId: "../other" })).toThrow(/桌宠/);
    expect(() => assertScreenFrameRequest({ ...validFrame(), sessionId: "short" })).toThrow(/sessionId/);
    expect(() => assertScreenFrameRequest({ ...validFrame(), unexpected: true })).toThrow(/不允许/);
    expect(() => assertScreenSessionId("screen-../../outside")).toThrow(/sessionId/);
    expect(() => assertScreenSessionId("screen-session-0001")).not.toThrow();
  });

  it("bounds the source request and awareness mode", () => {
    expect(() => assertScreenSourceSelectionRequest({
      petId: "pet-a",
      sourceId: "screen:1",
      sourceKind: "screen",
      mode: "quiet",
      purpose: "manual-monitor",
      requestId: "request-1",
      context: [{ role: "user", content: "看看" }]
    })).not.toThrow();
    expect(() => assertScreenSourceSelectionRequest({
      petId: "pet-a",
      sourceId: "screen:1",
      sourceKind: "screen",
      mode: "invalid",
      purpose: "manual-monitor",
      requestId: "request-1"
    })).toThrow(/mode/);
    expect(() => assertScreenSourceSelectionRequest({
      petId: "pet-a",
      sourceId: "screen:1",
      sourceKind: "screen",
      mode: "quiet",
      purpose: "manual-monitor",
      requestId: "request-1",
      question: "x".repeat(8_001)
    })).toThrow(/question/);
    expect(() => assertScreenSourceSelectionRequest({
      petId: "pet-a",
      sourceId: "window:1",
      sourceKind: "window",
      mode: "quiet",
      purpose: "direct-screen-question",
      requestId: "request-1"
    })).toThrow(/整个屏幕/);
    expect(() => assertScreenSourceSelectionRequest({
      petId: "pet-a",
      sourceId: "screen:1",
      sourceKind: "screen",
      mode: "quiet",
      purpose: "persistent-capture",
      requestId: "request-1"
    })).not.toThrow();
  });

  it("keeps enabling separate from the runtime monitoring session", () => {
    expect(() => assertScreenAwarenessSettingsRequest({ petId: "pet-a", enabled: false })).not.toThrow();
    expect(() => assertScreenAwarenessSettingsRequest({ petId: "pet-a", enabled: true, mode: "companion" })).not.toThrow();
    expect(() => assertScreenAwarenessSettingsRequest({ petId: "pet-a", enabled: true, persistentCaptureEnabled: true })).not.toThrow();
    expect(() => assertScreenAwarenessSettingsRequest({ petId: "pet-a", enabled: true, persistentCaptureEnabled: "yes" })).toThrow(/persistentCaptureEnabled/);
    expect(() => assertScreenAwarenessSettingsRequest({ petId: "pet-a", enabled: true, mode: "watching" })).toThrow(/mode/);
  });

  it("validates bounded monitor reply delivery acknowledgements", () => {
    const base = {
      petId: "pet-a",
      sessionId: "screen-session-0001",
      replyId: "screen-reply-00000001",
      status: "accepted"
    };
    expect(() => assertScreenMonitorReplyStatusRequest(base)).not.toThrow();
    expect(() => assertScreenMonitorReplyStatusRequest({ ...base, status: "played" })).not.toThrow();
    expect(() => assertScreenMonitorReplyStatusRequest({ ...base, status: "dropped" })).not.toThrow();
    expect(() => assertScreenMonitorReplyStatusRequest({ ...base, status: "queued" })).toThrow(/状态/);
    expect(() => assertScreenMonitorReplyStatusRequest({ ...base, unexpected: true })).toThrow(/不允许/);
  });

  it("accepts automatic monitor timing stages and rejects unknown stages", () => {
    expect(() => assertScreenVisionTimingRequest({
      petId: "pet-a",
      requestId: "screen-monitor-1",
      kind: "monitor",
      phase: "main",
      stage: "monitor-timeout",
      ok: false
    })).not.toThrow();
    expect(() => assertScreenVisionTimingRequest({
      petId: "pet-a",
      requestId: "screen-monitor-1",
      kind: "monitor",
      phase: "vision-model",
      stage: "model-action-ready"
    })).not.toThrow();
    expect(() => assertScreenVisionTimingRequest({
      petId: "pet-a",
      requestId: "screen-monitor-1",
      kind: "monitor",
      phase: "vision-model",
      stage: "model-decision-ready"
    })).not.toThrow();
    expect(() => assertScreenVisionTimingRequest({
      petId: "pet-a",
      requestId: "screen-monitor-1",
      kind: "monitor",
      phase: "main",
      stage: "secret-stage"
    })).toThrow(/stage/);
  });
});
