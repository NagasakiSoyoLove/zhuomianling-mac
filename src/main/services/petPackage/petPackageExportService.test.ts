import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yauzl from "yauzl";
import type { PetDefinition } from "../../../shared/types/pet";

let userData = "";
let sourcePet: PetDefinition;
vi.mock("electron", () => ({ app: { getPath: () => userData, getVersion: () => "1.4.2" } }));
vi.mock("../config/petConfigStore", () => ({
  getLocalPetDefinition: vi.fn(async () => sourcePet),
  validateReferenceAudioDuration: vi.fn()
}));
vi.mock("../ai/aiSettings", () => ({ getAiConnectionSummary: vi.fn(async () => ({ baseUrl: "https://must-not-leak.example/v1", model: "secret-model", hasApiKey: true })) }));

import { exportPetPackage } from "./petPackageExportService";

function readZip(filePath: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => yauzl.open(filePath, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) { reject(error); return; }
    const result = new Map<string, Buffer>();
    zip.on("entry", (entry) => zip.openReadStream(entry, (streamError, stream) => {
      if (streamError || !stream) { reject(streamError); return; }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => { result.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
    }));
    zip.on("end", () => resolve(result)); zip.on("error", reject); zip.readEntry();
  }));
}

describe("pet package export allowlist", () => {
  beforeEach(async () => {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), "zmling-export-"));
    const petDirectory = path.join(userData, "pets", "pet-a");
    const live2d = path.join(petDirectory, "live2d");
    await fs.mkdir(live2d, { recursive: true });
    await fs.writeFile(path.join(live2d, "model.json"), JSON.stringify({ model: "model.moc", textures: ["texture.png"], motions: { idle: [{ file: "idle.mtn" }] } }));
    await fs.writeFile(path.join(live2d, "model.moc"), "moc");
    await fs.writeFile(path.join(live2d, "texture.png"), "texture");
    await fs.writeFile(path.join(live2d, "idle.mtn"), "motion");
    await fs.writeFile(path.join(live2d, "private-notes.json"), JSON.stringify({ apiKey: "must-not-leak-from-model-folder" }));
    await fs.mkdir(path.join(petDirectory, "assets"));
    await fs.writeFile(path.join(petDirectory, "assets", "avatar.png"), "avatar-image");
    sourcePet = {
      id: "pet-a", name: "安全测试", description: "portable", modelPath: "pet-resource://local/pet-a/live2d/model.json", personaPrompt: "hello",
      avatar: "安", avatarImage: "pet-resource://local/pet-a/assets/avatar.png",
      capabilities: { chat: true, voiceOutput: false, subtitles: true }, details: { role: "r", personality: "p", scenes: [], features: [] },
      uiSettings: { theme: "soft", customTheme: { id: "must-not-copy" } as never, desktopPosition: { x: 20, y: 30 } },
      memorySettings: { onboardingCompleted: true, recallEnabled: true, autoCaptureEnabled: true, retainSources: true, recallLimit: 6, contextBudgetChars: 4000 },
      voiceInputSettings: { provider: "tencent-asr", hasCredentials: true, connected: true, autoEndEnabled: true, silenceSeconds: 2, volumeThreshold: .1, continuousConversationEnabled: false }, isLocal: true
    };
  });
  afterEach(async () => fs.rm(userData, { recursive: true, force: true }));

  it("round-trips a synthetic Cubism 2 resource tree without sensitive settings", async () => {
    const destination = path.join(userData, "safe.zmling");
    const result = await exportPetPackage("pet-a", destination);
    expect(result.ok).toBe(true);
    const zip = await readZip(destination);
    expect([...zip.keys()]).toEqual(expect.arrayContaining(["manifest.json", "pet.json", "assets/avatar.png", "live2d/model.json", "live2d/model.moc", "live2d/texture.png", "live2d/idle.mtn"]));
    expect(zip.has("live2d/private-notes.json")).toBe(false);
    const allText = [...zip.values()].map((value) => value.toString("utf8")).join("\n");
    expect(allText).not.toContain("must-not-leak");
    expect(allText).not.toContain("memorySettings");
    expect(allText).not.toContain("voiceInputSettings");
    expect(allText).not.toContain("desktopPosition");
    expect(allText).not.toContain("must-not-copy");
    const portable = JSON.parse(zip.get("pet.json")!.toString("utf8"));
    expect(portable.avatar).toBe("assets/avatar.png");
    expect(portable).not.toHaveProperty("avatarImage");
    const manifest = JSON.parse(zip.get("manifest.json")!.toString("utf8"));
    expect(manifest.requirements).toEqual({ ai: true, gptSoVits: false });
  });

  it("packages configured GPT-SoVITS resources while voice output is disabled and disconnected", async () => {
    const resources = path.join(userData, "voice-source");
    await fs.mkdir(resources);
    const sovits = path.join(resources, "voice.pth");
    const gpt = path.join(resources, "voice.ckpt");
    const reference = path.join(resources, "reference.wav");
    await fs.writeFile(sovits, "sovits"); await fs.writeFile(gpt, "gpt"); await fs.writeFile(reference, "RIFF0000WAVE");
    sourcePet = {
      ...sourcePet,
      capabilities: { ...sourcePet.capabilities, voiceOutput: false },
      uiSettings: {
        theme: "custom",
        customTheme: {
          id: "portable-theme", name: "Portable", description: "theme", version: 1,
          tokens: { background: "#fff", surface: "#fff", text: "#111", mutedText: "#666", accent: "#08f", border: "#ddd" }
        }
      },
      voiceModelSettings: {
        enabled: false, connected: false, modelVersion: "v2ProPlus", gptSoVitsRootPath: "D:\\private-runtime",
        sovitsModelPath: sovits, gptModelPath: gpt, referenceAudioPath: reference, referenceText: "测试",
        referenceLanguage: "zh", language: "zh", playMode: "sentence", inferenceDevice: "cpu", halfPrecision: false, syncTextWithVoice: true
      }
    };
    const destination = path.join(userData, "voice.zmling");
    const exported = await exportPetPackage("pet-a", destination);
    expect(exported.ok, exported.message).toBe(true);
    const zip = await readZip(destination);
    expect([...zip.keys()]).toEqual(expect.arrayContaining([
      "voice/models/sovits/voice.pth", "voice/models/gpt/voice.ckpt", "voice/reference/reference.wav"
    ]));
    const portable = JSON.parse(zip.get("pet.json")!.toString("utf8"));
    const manifest = JSON.parse(zip.get("manifest.json")!.toString("utf8"));
    expect(manifest.requirements.gptSoVits).toBe(true);
    expect(portable.uiSettings.customTheme.id).toBe("portable-theme");
    expect(portable.voiceModelSettings).toMatchObject({ enabled: false, connected: false, sovitsModel: "voice/models/sovits/voice.pth", gptModel: "voice/models/gpt/voice.ckpt", referenceAudio: "voice/reference/reference.wav" });
    expect(JSON.stringify(portable)).not.toContain("private-runtime");
    expect(JSON.stringify(portable)).not.toContain(resources);
  });
});
