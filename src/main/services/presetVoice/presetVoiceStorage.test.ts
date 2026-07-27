import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => state.userData } }));

import {
  readPresetVoiceAudio,
  removeAllPresetVoiceAudio,
  removePresetVoiceAudio,
  storePresetVoiceAudio
} from "./presetVoiceStorage";

function createWavFixture(): Buffer {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  return bytes;
}

beforeEach(async () => {
  state.userData = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-preset-voice-"));
});

afterEach(async () => {
  await fs.rm(state.userData, { recursive: true, force: true });
});

describe("preset voice storage", () => {
  it("atomically stores, reads, and removes an app-owned audio resource", async () => {
    const stored = await storePresetVoiceAudio({
      petId: "pet-a",
      bytes: createWavFixture(),
      mimeType: "audio/wav"
    });
    expect(stored.resourceId).toMatch(/^[a-f0-9]{32}$/);
    await expect(readPresetVoiceAudio({ petId: "pet-a", ...stored }))
      .resolves.toEqual(createWavFixture());
    await removePresetVoiceAudio({ petId: "pet-a", ...stored });
    await expect(readPresetVoiceAudio({ petId: "pet-a", ...stored })).rejects.toThrow();
  });

  it("rejects payloads whose bytes do not match their declared audio type", async () => {
    await expect(storePresetVoiceAudio({
      petId: "pet-a",
      bytes: Buffer.from("not a wave file"),
      mimeType: "audio/wav"
    })).rejects.toThrow(/格式或大小/);
  });

  it("removes only the validated preset directory", async () => {
    const stored = await storePresetVoiceAudio({
      petId: "pet-a",
      bytes: createWavFixture(),
      mimeType: "audio/wav"
    });
    await removeAllPresetVoiceAudio("pet-a");
    await expect(readPresetVoiceAudio({ petId: "pet-a", ...stored })).rejects.toThrow();
    await expect(fs.access(path.join(state.userData, "pets", "pet-a"))).resolves.toBeUndefined();
  });
});
