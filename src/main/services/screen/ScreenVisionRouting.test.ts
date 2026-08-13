// TIMED DIAGNOSTICS TEST MODULE: screen vision routing tests.
import { describe, expect, it } from "vitest";
import {
  createVisionCapabilityFingerprint,
  getVisionProviderProtocol
} from "./ScreenVisionConnectionStore";
import {
  matchesSyntheticVisionProbeFacts,
  monitorFallbackDecision,
  testChatVisionDraft
} from "./ScreenVisionService";

describe("screen vision provider routing", () => {
  it("routes Gemini native endpoints to inline_data and other endpoints to OpenAI compatible input", () => {
    expect(getVisionProviderProtocol("https://generativelanguage.googleapis.com/v1beta", "Gemini")).toBe("gemini-native");
    expect(getVisionProviderProtocol("https://generativelanguage.googleapis.com/v1beta/openai", "Gemini")).toBe("openai-compatible");
    expect(getVisionProviderProtocol("https://vision.example.test/v1", "OpenAI Compatible")).toBe("openai-compatible");

    expect(createVisionCapabilityFingerprint("https://generativelanguage.googleapis.com/v1beta", "models/gemini-2.0-flash", "Gemini")).toMatchObject({
      providerProtocol: "gemini-native",
      visionInputFormat: "inline_data",
      model: "models/gemini-2.0-flash"
    });
    expect(createVisionCapabilityFingerprint("https://vision.example.test/v1/", "vision-model")).toMatchObject({
      providerProtocol: "openai-compatible",
      visionInputFormat: "image_url-data-url",
      normalizedBaseUrl: "https://vision.example.test/v1"
    });
  });

  it("matches natural-language probe facts without exposing the image or raw request", () => {
    const facts = { color: "red" as const, shape: "circle" as const, position: "left" as const, count: 1 as const };
    expect(matchesSyntheticVisionProbeFacts("左边有一个红色圆形。", facts)).toBe(true);
    expect(matchesSyntheticVisionProbeFacts("中间有一个蓝色方形。", facts)).toBe(false);
    expect(matchesSyntheticVisionProbeFacts("one red circle on the left", facts)).toBe(true);
  });

  it("explains the reason for a monitor fallback instead of blaming the screenshot", () => {
    const candidate = { sceneKey: "scene-1", event: "page-change" as const };
    expect(monitorFallbackDecision(candidate, false, "visual-uncertain")).toMatchObject({
      presentationKind: "fallback",
      reply: "我检测到画面发生了变化，但这次没看清。"
    });
    expect(monitorFallbackDecision(candidate, false, "network").reply).toContain("视觉分析连接中断");
    expect(monitorFallbackDecision(candidate, false, "server").reply).toContain("视觉服务暂时不可用");
    expect(monitorFallbackDecision(candidate, false, "invalid-response").reply).toContain("结果无法识别");
    expect(monitorFallbackDecision(candidate, false, "timeout").reply).toContain("响应超时");

    for (const reason of ["network", "server", "invalid-response", "timeout"] as const) {
      expect(monitorFallbackDecision(candidate, false, reason).reply).not.toContain("没看清");
    }
  });

  it("tests a temporary chat draft with the same model capability routing", async () => {
    const result = await testChatVisionDraft({
      petId: "11111111-1111-4111-8111-111111111111",
      providerName: "OpenAI Compatible",
      baseUrl: "https://vision.example.test/v1",
      model: "gpt-4o-mini",
      apiKey: "secret"
    });

    expect(result).toMatchObject({
      ok: true,
      state: "tested",
      capability: {
        visionInput: "tested",
        fingerprint: {
          normalizedBaseUrl: "https://vision.example.test/v1",
          model: "gpt-4o-mini",
          providerProtocol: "openai-compatible",
          visionInputFormat: "image_url-data-url"
        }
      }
    });
  });
});
