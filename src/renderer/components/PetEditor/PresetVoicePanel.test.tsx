import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PetDefinition } from "../../../shared/types/pet";
import { getPresetVoiceLanguageLabel, PresetVoicePanel } from "./PresetVoicePanel";

function createPet(): PetDefinition {
  return {
    id: "preset-voice-pet",
    name: "预设语音测试",
    description: "",
    modelPath: "",
    personaPrompt: "",
    capabilities: { chat: true, voiceOutput: true, subtitles: true },
    details: { role: "", personality: "", scenes: [], features: [] },
    voiceModelSettings: {
      enabled: true,
      connected: true,
      referenceAudioPath: "C:/local/reference.wav",
      referenceText: "参考文本",
      language: "zh",
      playMode: "sentence"
    }
  };
}

describe("PresetVoicePanel", () => {
  it("renders one global generation entry for event and mood lines", () => {
    const markup = renderToStaticMarkup(
      <PresetVoicePanel pet={createPet()} onDirtyChange={vi.fn()} />
    );
    expect(markup).toContain("预设台词语音");
    expect(markup).toContain("所有事件候选台词与心情进入台词");
    expect(markup).toContain("重新生成全部");
    expect(markup).not.toContain("单条生成");
  });

  it("exposes accessible filters and coverage progress", () => {
    const markup = renderToStaticMarkup(
      <PresetVoicePanel pet={createPet()} onDirtyChange={vi.fn()} />
    );
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="台词类型筛选"');
    expect(markup).toContain('aria-label="搜索台词"');
  });

  it("uses Chinese language names in the Chinese-facing editor", () => {
    expect(getPresetVoiceLanguageLabel("zh")).toBe("中文");
    expect(getPresetVoiceLanguageLabel("ja")).toBe("日语");
    expect(getPresetVoiceLanguageLabel("en")).toBe("英语");
  });
});
