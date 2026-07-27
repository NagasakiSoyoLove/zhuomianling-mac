import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertValidPetId } from "../../../shared/validation/petId";
import { writeBufferFileAtomically } from "../config/durableJsonFile";
import {
  assertPathContained,
  ensureSafeLocalPetSubdirectory
} from "../config/petConfigPersistence";

const maximumPresetAudioBytes = 32 * 1024 * 1024;
const mimeExtensions: Readonly<Record<string, string>> = {
  "audio/wav": ".wav",
  "audio/wave": ".wav",
  "audio/x-wav": ".wav",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/ogg": ".ogg",
  "audio/aac": ".aac"
};

async function getPresetVoiceDirectory(petId: string): Promise<string> {
  const voiceRoot = await ensureSafeLocalPetSubdirectory(assertValidPetId(petId), "voice");
  const presetDirectory = path.resolve(voiceRoot, "presets");
  assertPathContained(voiceRoot, presetDirectory, "预设语音目录越界。");
  await fs.mkdir(presetDirectory, { recursive: true });
  const [realVoiceRoot, realPresetDirectory] = await Promise.all([
    fs.realpath(voiceRoot),
    fs.realpath(presetDirectory)
  ]);
  assertPathContained(realVoiceRoot, realPresetDirectory, "预设语音目录越界。");
  return realPresetDirectory;
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0].trim().toLowerCase();
}

function hasExpectedSignature(bytes: Uint8Array, mimeType: string): boolean {
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.slice(start, start + length));
  switch (mimeType) {
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE";
    case "audio/mpeg":
    case "audio/mp3":
      return ascii(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    case "audio/ogg":
      return ascii(0, 4) === "OggS";
    case "audio/aac":
      return (bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0) || ascii(4, 4) === "ftyp";
    default:
      return false;
  }
}

export async function storePresetVoiceAudio(options: {
  petId: string;
  bytes: Uint8Array;
  mimeType: string;
}): Promise<{ resourceId: string; mimeType: string }> {
  const mimeType = normalizeMimeType(options.mimeType);
  const extension = mimeExtensions[mimeType];
  if (
    !extension || options.bytes.byteLength < 12 || options.bytes.byteLength > maximumPresetAudioBytes ||
    !hasExpectedSignature(options.bytes, mimeType)
  ) {
    throw new Error("生成的预设音频格式或大小无效。");
  }
  const resourceId = randomUUID().replace(/-/g, "");
  const directory = await getPresetVoiceDirectory(options.petId);
  await writeBufferFileAtomically(path.join(directory, `${resourceId}${extension}`), options.bytes);
  return { resourceId, mimeType };
}

export async function readPresetVoiceAudio(options: {
  petId: string;
  resourceId: string;
  mimeType: string;
}): Promise<Buffer> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.resourceId)) {
    throw new Error("预设语音资源 ID 无效。");
  }
  const extension = mimeExtensions[normalizeMimeType(options.mimeType)];
  if (!extension) throw new Error("预设语音格式无效。");
  const directory = await getPresetVoiceDirectory(options.petId);
  const filePath = path.resolve(directory, `${options.resourceId}${extension}`);
  assertPathContained(directory, filePath, "预设语音资源越界。");
  const realFile = await fs.realpath(filePath);
  assertPathContained(directory, realFile, "预设语音资源越界。");
  const bytes = await fs.readFile(realFile);
  if (!bytes.length || bytes.length > maximumPresetAudioBytes) throw new Error("预设语音资源无效。");
  return bytes;
}

export async function removePresetVoiceAudio(options: {
  petId: string;
  resourceId: string;
  mimeType: string;
}): Promise<void> {
  const extension = mimeExtensions[normalizeMimeType(options.mimeType)];
  if (!extension || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.resourceId)) return;
  const directory = await getPresetVoiceDirectory(options.petId);
  const filePath = path.resolve(directory, `${options.resourceId}${extension}`);
  assertPathContained(directory, filePath, "预设语音资源越界。");
  await fs.rm(filePath, { force: true });
}

export async function removeAllPresetVoiceAudio(petId: string): Promise<void> {
  const directory = await getPresetVoiceDirectory(petId);
  const voiceRoot = path.dirname(directory);
  assertPathContained(voiceRoot, directory, "预设语音目录越界。");
  const realDirectory = await fs.realpath(directory);
  assertPathContained(voiceRoot, realDirectory, "预设语音目录越界。");
  await fs.rm(realDirectory, { recursive: true, force: true });
}
