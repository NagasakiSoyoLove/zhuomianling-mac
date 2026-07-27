import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn()
}));

vi.mock("../ai/aiSettings", () => ({
  getAiConnectionConfig: mocks.getConfig
}));

import { translatePresetVoiceText } from "./presetVoiceTranslation";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("persona-aware preset voice translation", () => {
  it("sends only the persona and one line to the independent localization request", async () => {
    mocks.getConfig.mockResolvedValue({
      baseUrl: "https://ai.example/v1",
      model: "fixture-model",
      apiKey: "fixture-key"
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"translation":"べ、別に待ってなかったよ。"}' } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const translated = await translatePresetVoiceText({
      petId: "pet-a",
      text: "我才没有等你呢。",
      personaPrompt: "角色说话傲娇，但实际很关心用户。",
      targetLanguage: "ja",
      signal: new AbortController().signal
    });

    expect(translated).toBe("べ、別に待ってなかったよ。");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
      response_format?: unknown;
    };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.content).toContain("独立的桌宠预设台词风格化翻译器");
    expect(body.messages[0]?.content).toContain("角色说话傲娇，但实际很关心用户。");
    expect(body.messages[1]).toEqual({ role: "user", content: "我才没有等你呢。" });
    expect(body.response_format).toEqual({ type: "json_object" });
  });
});
