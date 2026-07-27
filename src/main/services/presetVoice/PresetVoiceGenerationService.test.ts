import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PetDefinition } from "../../../shared/types/pet";

const mocks = vi.hoisted(() => ({
  getPet: vi.fn(),
  commit: vi.fn(),
  synthesize: vi.fn(),
  store: vi.fn(),
  remove: vi.fn(),
  translate: vi.fn()
  ,clearTarget: vi.fn()
  ,clear: vi.fn()
  ,removeAll: vi.fn()
}));

vi.mock("../config/petConfigStore", () => ({
  getLocalPetDefinition: mocks.getPet,
  commitLocalPetPresetAudio: mocks.commit,
  clearLocalPetPresetAudioTarget: mocks.clearTarget,
  clearLocalPetPresetAudio: mocks.clear
}));
vi.mock("../speech/textToSpeech", () => ({ synthesizePresetText: mocks.synthesize }));
vi.mock("./presetVoiceStorage", () => ({
  storePresetVoiceAudio: mocks.store,
  removePresetVoiceAudio: mocks.remove,
  removeAllPresetVoiceAudio: mocks.removeAll,
  readPresetVoiceAudio: vi.fn()
}));
vi.mock("./presetVoiceTranslation", () => ({ translatePresetVoiceText: mocks.translate }));

import { PresetVoiceGenerationService } from "./PresetVoiceGenerationService";

function createPet(): PetDefinition {
  return {
    id: "pet-a",
    name: "A",
    description: "",
    modelPath: "",
    personaPrompt: "说话简短、傲娇，但会关心用户。",
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
    lines: { ready: ["加载好了"] },
    moodSettings: {
      ranges: {
        calm: { voiceOverride: { referenceAudio: "calm.wav", referenceText: "平静参考" } },
        excited: { enterLine: "太棒了" }
      }
    }
  };
}

async function waitForFinished(service: PresetVoiceGenerationService): Promise<void> {
  await new Promise<void>((resolve) => {
    const unsubscribe = service.onProgress((snapshot) => {
      if (snapshot.status !== "running") {
        unsubscribe();
        resolve();
      }
    });
  });
}

describe("PresetVoiceGenerationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const pet = createPet();
    mocks.getPet.mockResolvedValue(pet);
    mocks.commit.mockResolvedValue({ pet });
    mocks.synthesize.mockImplementation(async (_request, options) => ({
      ok: true,
      message: "ok",
      audioBase64: Buffer.from("0123456789abcdef").toString("base64"),
      mimeType: "audio/wav",
      ...(options.moodRangeId ? { resolvedMoodRange: "calm" } : {})
    }));
    mocks.store.mockResolvedValue({ resourceId: "audio1", mimeType: "audio/wav" });
    mocks.translate.mockResolvedValue("translated");
    mocks.clear.mockResolvedValue({ pet, removed: [] });
    mocks.clearTarget.mockResolvedValue({ pet, shouldDeleteFile: false });
    mocks.removeAll.mockResolvedValue(undefined);
  });

  it("generates all event lines and mood enter lines and commits each success", async () => {
    const service = new PresetVoiceGenerationService();
    const started = await service.start({ petId: "pet-a", scope: "missing", translation: "source" });
    expect(started.ok).toBe(true);
    await waitForFinished(service);
    expect(service.getTask("pet-a")).toMatchObject({ status: "completed", total: 2, succeeded: 2, failed: 0 });
    expect(mocks.commit).toHaveBeenCalledTimes(2);
    expect(mocks.synthesize.mock.calls.some((call) => call[1].moodRangeId === "excited")).toBe(true);
  });

  it("uses explicit AI translation before synthesis", async () => {
    const pet = createPet();
    pet.moodSettings = undefined;
    mocks.getPet.mockResolvedValue(pet);
    const service = new PresetVoiceGenerationService();
    await service.start({
      petId: "pet-a",
      scope: "missing",
      translation: "translate",
      targetLanguage: "ja"
    });
    await waitForFinished(service);
    expect(mocks.translate).toHaveBeenCalledWith(expect.objectContaining({
      text: "加载好了",
      personaPrompt: pet.personaPrompt,
      targetLanguage: "ja"
    }));
    expect(mocks.synthesize).toHaveBeenCalledWith(expect.objectContaining({ text: "translated" }), expect.objectContaining({ language: "ja" }));
    expect(mocks.commit.mock.calls[0]?.[0].audio.personaFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("restricts a single-line task to the requested target", async () => {
    const service = new PresetVoiceGenerationService();
    const overview = await service.getOverview("pet-a");
    const target = overview.targets.find((item) => item.kind === "event-line")!;
    const started = await service.start({
      petId: "pet-a",
      scope: "all",
      targetId: target.targetId,
      translation: "source"
    });
    expect(started.task?.total).toBe(1);
    await waitForFinished(service);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.commit.mock.calls[0]?.[0].target.targetId).toBe(target.targetId);
  });

  it("deletes one binding and removes its orphaned audio file", async () => {
    const pet = createPet();
    const audio = {
      schemaVersion: 1 as const,
      resourceId: "single_audio",
      sourceTextHash: "a".repeat(64),
      spokenText: "加载好了",
      language: "zh" as const,
      mimeType: "audio/wav",
      voiceFingerprint: "b".repeat(64),
      generatedAt: 1
    };
    pet.lines = { ready: [{ id: "line-ready", text: "加载好了", presetAudio: audio }] };
    mocks.getPet.mockResolvedValue(pet);
    mocks.clearTarget.mockResolvedValue({ pet, removed: audio, shouldDeleteFile: true });
    const service = new PresetVoiceGenerationService();

    const result = await service.deleteOne("pet-a", "line-ready");

    expect(result).toMatchObject({ ok: true, removed: 1 });
    expect(mocks.clearTarget).toHaveBeenCalledWith(expect.objectContaining({
      petId: "pet-a",
      target: expect.objectContaining({ targetId: "line-ready" })
    }));
    expect(mocks.remove).toHaveBeenCalledWith({
      petId: "pet-a",
      resourceId: "single_audio",
      mimeType: "audio/wav"
    });
  });

  it("rejects single-line deletion while a preset voice task is running", async () => {
    const pet = createPet();
    pet.moodSettings = undefined;
    mocks.getPet.mockResolvedValue(pet);
    mocks.synthesize.mockImplementation((_request, options) => new Promise((resolve) => {
      options.signal.addEventListener("abort", () => resolve({ ok: false, message: "canceled", code: "CANCELED" }), { once: true });
    }));
    const service = new PresetVoiceGenerationService();

    await service.start({ petId: "pet-a", scope: "missing", translation: "source" });
    const result = await service.deleteOne("pet-a", "line-ready");

    expect(result).toMatchObject({ ok: false, removed: 0 });
    expect(result.message).toContain("任务运行期间");
    expect(mocks.clearTarget).not.toHaveBeenCalled();
    await service.disposePet("pet-a");
  });

  it("keeps successful items when a later target fails", async () => {
    mocks.synthesize
      .mockResolvedValueOnce({ ok: true, message: "ok", audioBase64: Buffer.from("0123456789abcdef").toString("base64"), mimeType: "audio/wav" })
      .mockResolvedValueOnce({ ok: false, message: "service unavailable" });
    const service = new PresetVoiceGenerationService();
    await service.start({ petId: "pet-a", scope: "missing", translation: "source" });
    await waitForFinished(service);
    expect(service.getTask("pet-a")).toMatchObject({ status: "completed", succeeded: 1, failed: 1 });
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });

  it("aborts and waits for the active synthesis before pet deletion", async () => {
    const pet = createPet();
    pet.moodSettings = undefined;
    mocks.getPet.mockResolvedValue(pet);
    mocks.synthesize.mockImplementation((_request, options) => new Promise((resolve) => {
      options.signal.addEventListener("abort", () => resolve({ ok: false, message: "canceled", code: "CANCELED" }), { once: true });
    }));
    const service = new PresetVoiceGenerationService();
    await service.start({ petId: "pet-a", scope: "missing", translation: "source" });
    await service.disposePet("pet-a");
    expect(service.getTask("pet-a")).toBeUndefined();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("clears configuration before deleting the app-owned preset directory", async () => {
    const service = new PresetVoiceGenerationService();
    const result = await service.deleteAll("pet-a");
    expect(result.ok).toBe(true);
    expect(mocks.clear).toHaveBeenCalledWith("pet-a");
    expect(mocks.removeAll).toHaveBeenCalledWith("pet-a");
  });
});
