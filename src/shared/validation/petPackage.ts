import path from "node:path";
import type { PetDefinition } from "../types/pet";
import {
  PET_PACKAGE_FORMAT_VERSION,
  PET_PACKAGE_KIND,
  type PetPackageEntryV1,
  type PetPackageManifestV1,
  type PortablePetDefinitionV1
} from "../types/petPackage";
import { isValidPetId, MAX_PET_ID_LENGTH } from "./petId";
import { isPetVoiceModelVersion } from "./petVoiceModel";

export const PET_PACKAGE_LIMITS = {
  maxArchiveBytes: 8 * 1024 ** 3,
  maxExtractedBytes: 12 * 1024 ** 3,
  maxEntryBytes: 6 * 1024 ** 3,
  maxEntries: 10_000,
  maxCompressionRatio: 200,
  maxManifestBytes: 256 * 1024,
  maxPetJsonBytes: 1024 * 1024
} as const;

const sha256Pattern = /^[a-f0-9]{64}$/;
const drivePattern = /^[A-Za-z]:/;
const reservedDevicePattern = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const allowedTopLevels = new Set(["manifest.json", "pet.json", "assets", "live2d", "voice"]);
const forbiddenPortableKeys = new Set([
  "modelPath", "avatarImage", "memorySettings", "voiceInputSettings", "gptSoVitsRootPath",
  "sovitsModelPath", "gptModelPath", "referenceAudioPath", "apiKey", "hasApiKey", "baseUrl",
  "providerName", "aiConnection", "secretKey", "secretId", "appId", "hasCredentials"
]);
const allowedPortableKeys = new Set([
  "schemaVersion", "live2dEntry", "name", "description", "avatar", "personaPrompt", "defaultVoice",
  "personaSettings", "voiceModelSettings", "live2dSettings", "uiSettings", "moodSettings", "capabilities",
  "details", "expressions", "expressionDescriptions", "expressionSelectionMode", "expressionRandomScope",
  "expressionSourceKinds", "expressionSourceFiles", "expressionSources", "expressionEffects", "eventSettings",
  "lines", "subtitleStyle"
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 格式无效。`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim()) || value.includes("\0")) {
    throw new Error(`${label} 无效。`);
  }
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) throw new Error(`${label} 包含未知字段 ${key}。`);
}

export function normalizePetPackageEntryPath(value: unknown): string {
  const entryPath = boundedString(value, "包内路径", 1024);
  if (
    entryPath.includes("\\") ||
    entryPath.startsWith("/") || entryPath.startsWith("//") || drivePattern.test(entryPath) ||
    entryPath.endsWith("/") || entryPath.split("/").some((part) =>
      !part || part === "." || part === ".." || reservedDevicePattern.test(part) ||
      /[. ]$/.test(part) || /[:\u0000-\u001f]/.test(part)
    )
  ) throw new Error("桌宠包包含不安全路径。");
  const normalized = path.posix.normalize(entryPath);
  if (normalized !== entryPath || !allowedTopLevels.has(entryPath.split("/")[0])) {
    throw new Error("桌宠包包含未知或非规范路径。");
  }
  return entryPath;
}

function parseEntry(value: unknown): PetPackageEntryV1 {
  const item = record(value, "manifest entry");
  assertOnlyKeys(item, ["path", "size", "sha256"], "manifest entry");
  const entryPath = normalizePetPackageEntryPath(item.path);
  const size = item.size;
  const sha256 = boundedString(item.sha256, "entry sha256", 64);
  if (!Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > PET_PACKAGE_LIMITS.maxEntryBytes || !sha256Pattern.test(sha256)) {
    throw new Error("桌宠包文件清单无效。");
  }
  return { path: entryPath, size: size as number, sha256 };
}

export function parsePetPackageManifest(value: unknown): PetPackageManifestV1 {
  const root = record(value, "manifest");
  assertOnlyKeys(root, ["kind", "formatVersion", "exportedAt", "appVersion", "pet", "requirements", "entries"], "manifest");
  if (root.kind !== PET_PACKAGE_KIND || root.formatVersion !== PET_PACKAGE_FORMAT_VERSION) throw new Error("不支持的桌宠包版本。");
  const pet = record(root.pet, "manifest.pet");
  const requirements = record(root.requirements, "manifest.requirements");
  assertOnlyKeys(pet, ["originalPetId", "name"], "manifest.pet");
  assertOnlyKeys(requirements, ["ai", "gptSoVits"], "manifest.requirements");
  if (typeof requirements.ai !== "boolean" || typeof requirements.gptSoVits !== "boolean") throw new Error("manifest requirements 无效。");
  if (!Array.isArray(root.entries) || root.entries.length > PET_PACKAGE_LIMITS.maxEntries) throw new Error("桌宠包文件数量超出限制。");
  const entries = root.entries.map(parseEntry);
  const folded = new Set<string>();
  for (const entry of entries) {
    const key = entry.path.toLocaleLowerCase("en-US");
    if (folded.has(key)) throw new Error("桌宠包包含重复或大小写冲突的路径。");
    folded.add(key);
  }
  if (!folded.has("pet.json") || !entries.some((entry) => entry.path.startsWith("live2d/"))) throw new Error("桌宠包缺少必要资源。");
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (!Number.isSafeInteger(total) || total > PET_PACKAGE_LIMITS.maxExtractedBytes) throw new Error("桌宠包解压大小超出限制。");
  const exportedAt = boundedString(root.exportedAt, "导出时间", 64);
  if (!Number.isFinite(Date.parse(exportedAt))) throw new Error("导出时间无效。");
  return {
    kind: PET_PACKAGE_KIND,
    formatVersion: PET_PACKAGE_FORMAT_VERSION,
    exportedAt,
    appVersion: boundedString(root.appVersion, "应用版本", 64),
    pet: { originalPetId: boundedString(pet.originalPetId, "原桌宠 ID", MAX_PET_ID_LENGTH, true), name: boundedString(pet.name, "桌宠名称", 128) },
    requirements: {
      ai: requirements.ai,
      gptSoVits: requirements.gptSoVits
    },
    entries
  };
}

function scanPortableValue(value: unknown, key = "root"): void {
  if (typeof value === "string") {
    if (value.includes("\0") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/Users/") || value.startsWith("/home/")) {
      throw new Error(`便携配置字段 ${key} 包含本机绝对路径。`);
    }
    return;
  }
  if (Array.isArray(value)) { value.forEach((item, index) => scanPortableValue(item, `${key}[${index}]`)); return; }
  if (!value || typeof value !== "object") return;
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenPortableKeys.has(childKey) || (childKey !== "tokens" && /(?:api.?key|token|password|credential|secret)/i.test(childKey))) {
      throw new Error(`便携配置包含禁止字段 ${childKey}。`);
    }
    scanPortableValue(child, `${key}.${childKey}`);
  }
}

export function parsePortablePetDefinition(value: unknown): PortablePetDefinitionV1 {
  const portable = record(value, "pet.json");
  for (const key of Object.keys(portable)) if (!allowedPortableKeys.has(key)) throw new Error(`便携配置包含未知字段 ${key}。`);
  scanPortableValue(portable);
  if (portable.schemaVersion !== 1) throw new Error("不支持的便携桌宠配置版本。");
  boundedString(portable.name, "桌宠名称", 128);
  const live2dEntry = normalizePetPackageEntryPath(portable.live2dEntry);
  if (!live2dEntry.startsWith("live2d/") || !/(?:model\.json|\.model3\.json)$/i.test(live2dEntry)) throw new Error("Live2D 入口无效。");
  if (portable.avatar !== undefined) {
    const avatar = normalizePetPackageEntryPath(portable.avatar);
    if (!avatar.startsWith("assets/")) throw new Error("便携头像引用无效。");
    portable.avatar = avatar;
  }
  const ui = portable.uiSettings === undefined ? undefined : record(portable.uiSettings, "uiSettings");
  if (ui?.desktopPosition !== undefined) throw new Error("便携配置不得包含桌面位置。");
  if (ui && ui.theme !== "custom") delete ui.customTheme;
  if (ui?.theme === "custom" && !ui.customTheme) throw new Error("自定义主题缺少定义。");
  const voice = portable.voiceModelSettings === undefined ? undefined : record(portable.voiceModelSettings, "voiceModelSettings");
  if (voice && voice.connected !== false) throw new Error("便携语音配置运行状态无效。");
  if (voice?.modelVersion !== undefined && !isPetVoiceModelVersion(voice.modelVersion)) throw new Error("便携语音模型版本无效。");
  for (const field of ["sovitsModel", "gptModel", "referenceAudio"] as const) {
    if (voice?.[field] !== undefined) {
      const resourcePath = normalizePetPackageEntryPath(voice[field]);
      if (!resourcePath.startsWith("voice/")) throw new Error("便携语音资源引用无效。");
      voice[field] = resourcePath;
    }
  }
  return portable as unknown as PortablePetDefinitionV1;
}

export function createPortablePetDefinition(pet: PetDefinition, live2dEntry: string, voicePaths?: { sovitsModel: string; gptModel: string; referenceAudio: string }): PortablePetDefinitionV1 {
  const { id: _id, modelPath: _modelPath, avatarImage: _avatarImage, memorySettings: _memory, voiceInputSettings: _voiceInput, isLocal: _local, ...rest } = pet;
  const uiSettings: PetDefinition["uiSettings"] = rest.uiSettings ? { ...rest.uiSettings } : undefined;
  if (uiSettings) delete uiSettings.desktopPosition;
  if (uiSettings && uiSettings.theme !== "custom") delete uiSettings.customTheme;
  const sourceVoice = rest.voiceModelSettings;
  delete (rest as Partial<PetDefinition>).voiceModelSettings;
  const voiceModelSettings = sourceVoice ? {
    enabled: sourceVoice.enabled,
    connected: false as const,
    modelVersion: sourceVoice.modelVersion,
    referenceText: sourceVoice.referenceText,
    referenceLanguage: sourceVoice.referenceLanguage,
    language: sourceVoice.language,
    playMode: sourceVoice.playMode,
    inferenceDevice: sourceVoice.inferenceDevice,
    halfPrecision: sourceVoice.halfPrecision,
    syncTextWithVoice: sourceVoice.syncTextWithVoice,
    ...voicePaths
  } : undefined;
  const avatarName = pet.avatarImage?.includes("/assets/") ? decodeURIComponent(pet.avatarImage.split("/").pop() ?? "") : "";
  const avatar = avatarName && !avatarName.includes("/") && !avatarName.includes("\\") ? `assets/${avatarName}` : undefined;
  return parsePortablePetDefinition({ ...rest, avatar, schemaVersion: 1, live2dEntry, uiSettings, voiceModelSettings });
}

export function createCanonicalPetId(name: string): string {
  const normalized = name.normalize("NFKC").trim().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, MAX_PET_ID_LENGTH);
  return isValidPetId(normalized) ? normalized : "pet";
}

export function allocateImportedPetId(originalId: string, name: string, occupied: ReadonlySet<string>): string {
  const base = isValidPetId(originalId) ? originalId : createCanonicalPetId(name);
  if (!occupied.has(base.toLocaleLowerCase("en-US"))) return base;
  for (let suffix = 2; suffix < 100_000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, MAX_PET_ID_LENGTH - tail.length)}${tail}`;
    if (!occupied.has(candidate.toLocaleLowerCase("en-US"))) return candidate;
  }
  throw new Error("无法分配桌宠 ID。");
}

export function sanitizePetPackageFileName(name: string): string {
  const safe = name.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/[. ]+$/g, "").trim().slice(0, 80) || "桌宠";
  return `桌面灵-${safe}.zmling`;
}
