import { describe, expect, it } from "vitest";
import type { PetDefinition } from "../types/pet";
import { PET_PACKAGE_KIND } from "../types/petPackage";
import {
  allocateImportedPetId,
  createPortablePetDefinition,
  normalizePetPackageEntryPath,
  parsePetPackageManifest,
  parsePortablePetDefinition,
  sanitizePetPackageFileName
} from "./petPackage";

const pet: PetDefinition = {
  id: "pet-a",
  name: "测试桌宠",
  description: "desc",
  modelPath: "pet-resource://local/pet-a/live2d/model.model3.json",
  avatar: "pet-resource://local/pet-a/assets/avatar.png",
  avatarImage: "data:image/png;base64,secret",
  personaPrompt: "persona",
  memorySettings: { onboardingCompleted: true, recallEnabled: true, autoCaptureEnabled: true, retainSources: true, recallLimit: 6, contextBudgetChars: 4000 },
  voiceInputSettings: {
    provider: "tencent-asr", hasCredentials: true, connected: true, autoEndEnabled: true,
    silenceSeconds: 2, volumeThreshold: 0.1, continuousConversationEnabled: false
  },
  capabilities: { chat: true, voiceOutput: false, subtitles: true },
  details: { role: "role", personality: "kind", scenes: [], features: [] },
  uiSettings: { theme: "soft", customTheme: {} as never, desktopPosition: { x: 1, y: 2 } },
  isLocal: true
};

describe("pet package protocol", () => {
  it("parses a bounded v1 manifest", () => {
    expect(parsePetPackageManifest({
      kind: PET_PACKAGE_KIND,
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      appVersion: "1.0.0",
      pet: { originalPetId: "pet-a", name: "A" },
      requirements: { ai: false, gptSoVits: false },
      entries: [
        { path: "pet.json", size: 2, sha256: "a".repeat(64) },
        { path: "live2d/model.model3.json", size: 2, sha256: "b".repeat(64) }
      ]
    }).pet.originalPetId).toBe("pet-a");
  });

  it.each(["../pet.json", "/pet.json", "C:/pet.json", "live2d\\model.json", "live2d/CON", "live2d/a:b", "live2d/trailing. ", "unknown/a"])(
    "rejects unsafe archive path %s",
    (entry) => expect(() => normalizePetPackageEntryPath(entry)).toThrow()
  );

  it("rejects duplicate case-folded entries", () => {
    expect(() => parsePetPackageManifest({
      kind: PET_PACKAGE_KIND, formatVersion: 1, exportedAt: new Date().toISOString(), appVersion: "1",
      pet: { originalPetId: "a", name: "A" }, requirements: { ai: false, gptSoVits: false },
      entries: [
        { path: "pet.json", size: 1, sha256: "a".repeat(64) },
        { path: "assets/avatar.png", size: 1, sha256: "b".repeat(64) },
        { path: "assets/AVATAR.PNG", size: 1, sha256: "d".repeat(64) },
        { path: "live2d/model.json", size: 1, sha256: "c".repeat(64) }
      ]
    })).toThrow(/重复|冲突/);
  });

  it("creates a portable allowlisted definition", () => {
    const portable = createPortablePetDefinition(pet, "live2d/model.model3.json");
    const json = JSON.stringify(portable);
    expect(json).not.toContain("memorySettings");
    expect(json).not.toContain("voiceInputSettings");
    expect(json).not.toContain("desktopPosition");
    expect(json).not.toContain("avatarImage");
    expect(portable.uiSettings?.customTheme).toBeUndefined();
  });

  it("rejects secrets and absolute paths in portable data", () => {
    const base = createPortablePetDefinition(pet, "live2d/model.model3.json");
    expect(() => parsePortablePetDefinition({ ...base, apiKey: "secret" })).toThrow(/禁止字段|未知字段/);
    expect(() => parsePortablePetDefinition({ ...base, description: "C:\\private\\file" })).toThrow(/绝对路径/);
  });

  it("allocates collision-safe canonical ids and safe file names", () => {
    expect(allocateImportedPetId("pet", "ignored", new Set(["pet", "pet-2"]))).toBe("pet-3");
    expect(allocateImportedPetId("bad id", "小 宠物", new Set())).toBe("小-宠物");
    expect(sanitizePetPackageFileName(" A:pet. ")).toBe("桌面灵-A-pet.zmling");
  });
});
