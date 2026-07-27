import { describe, expect, it } from "vitest";
import type { PetDefinition, PetPresetLine } from "../../../shared/types/pet";
import { collectPresetVoiceTargets, resolvePresetMoodVoiceSelection, summarizePresetVoiceTargets } from "./presetVoiceTargets";
import {
  createPresetVoiceFingerprint,
  hashPresetVoicePersona,
  hashPresetVoiceText
} from "./presetVoiceFingerprint";

function createPet(): PetDefinition {
  return {
    id: "pet-a",
    name: "A",
    description: "",
    modelPath: "",
    personaPrompt: "",
    capabilities: { chat: true, voiceOutput: true, subtitles: true },
    details: { role: "", personality: "", scenes: [], features: [] },
    voiceModelSettings: {
      enabled: true,
      connected: true,
      modelVersion: "v2ProPlus",
      referenceAudioPath: "C:/local/default.wav",
      referenceText: "默认参考",
      language: "zh",
      playMode: "sentence"
    },
    lines: {
      ready: ["加载好了", "又见面了"],
      click: [{ id: "line-click-1", text: "不要戳我" }]
    },
    moodSettings: {
      ranges: {
        calm: { voiceOverride: { referenceAudio: "calm.wav", referenceText: "平静参考" } },
        excited: { enterLine: "太棒了！" }
      }
    }
  };
}

describe("preset voice targets", () => {
  it("collects every configured event line and mood enter line", () => {
    const targets = collectPresetVoiceTargets(createPet());
    expect(targets).toHaveLength(4);
    expect(targets.filter((target) => target.kind === "event-line")).toHaveLength(3);
    expect(targets.filter((target) => target.kind === "mood-enter-line")).toHaveLength(1);
    expect(summarizePresetVoiceTargets(targets)).toMatchObject({ total: 4, missing: 4, eventTotal: 3, moodTotal: 1 });
  });

  it("keeps legacy target ids deterministic and preserves explicit ids", () => {
    const first = collectPresetVoiceTargets(createPet());
    const second = collectPresetVoiceTargets(createPet());
    expect(first.map((target) => target.targetId)).toEqual(second.map((target) => target.targetId));
    expect(first.find((target) => target.text === "不要戳我")?.targetId).toBe("line-click-1");
  });

  it("resolves mood voice toward calm before using the default reference", () => {
    const pet = createPet();
    expect(resolvePresetMoodVoiceSelection(pet, "excited")).toMatchObject({
      kind: "mood-override",
      requestedRangeId: "excited",
      resolvedRangeId: "calm",
      referenceText: "平静参考"
    });
    delete pet.moodSettings?.ranges?.calm?.voiceOverride;
    expect(resolvePresetMoodVoiceSelection(pet, "excited")).toMatchObject({
      kind: "default",
      requestedRangeId: "excited",
      referenceText: "默认参考"
    });
  });

  it("hashes normalized text and all synthesis-affecting fingerprint fields", () => {
    const pet = createPet();
    const settings = pet.voiceModelSettings!;
    expect(hashPresetVoiceText(" 台词 ")).toBe(hashPresetVoiceText("台词"));
    const first = createPresetVoiceFingerprint({
      sourceText: "台词",
      spokenText: "台词",
      language: "zh",
      voiceSettings: settings,
      referenceIdentity: "default",
      referenceText: "默认参考"
    });
    const second = createPresetVoiceFingerprint({
      sourceText: "台词",
      spokenText: "台词",
      language: "zh",
      voiceSettings: { ...settings, modelVersion: "v4" },
      referenceIdentity: "default",
      referenceText: "默认参考"
    });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  it("keeps finished audio valid across generation-setting changes and only stales changed text", () => {
    const pet = createPet();
    pet.personaPrompt = "说话活泼。";
    const line: PetPresetLine = { id: "styled-line", text: "欢迎回来" };
    const personaFingerprint = hashPresetVoicePersona(pet.personaPrompt);
    const settings = pet.voiceModelSettings!;
    line.presetAudio = {
      schemaVersion: 1,
      resourceId: "styled_audio",
      sourceTextHash: hashPresetVoiceText(line.text),
      spokenText: "おかえり！",
      language: "ja",
      mimeType: "audio/wav",
      personaFingerprint,
      voiceFingerprint: createPresetVoiceFingerprint({
        sourceText: line.text,
        spokenText: "おかえり！",
        language: "ja",
        voiceSettings: settings,
        referenceIdentity: `default:${settings.referenceAudioPath}`,
        referenceText: settings.referenceText,
        personaFingerprint
      }),
      generatedAt: 1
    };
    pet.lines = { ready: [line] };

    expect(collectPresetVoiceTargets(pet)[0]?.status).toBe("ready");
    pet.personaPrompt = "说话冷淡。";
    pet.voiceModelSettings = {
      ...settings,
      modelVersion: "v4",
      referenceAudioPath: "C:/local/replacement.wav",
      referenceText: "新的参考文本",
      language: "en",
      inferenceDevice: "cpu",
      halfPrecision: false
    };
    expect(collectPresetVoiceTargets(pet)[0]?.status).toBe("ready");

    line.text = "欢迎再次回来";
    expect(collectPresetVoiceTargets(pet)[0]?.status).toBe("stale");
  });
});
