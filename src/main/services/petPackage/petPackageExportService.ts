import path from "node:path";
import fs from "node:fs/promises";
import { app } from "electron";
import type { PetDefinition, PetLine, PetPresetAudio } from "../../../shared/types/pet";
import { PET_PACKAGE_FORMAT_VERSION, PET_PACKAGE_KIND, type PetPackageExportInspection, type PetPackageExportResult, type PetPackageManifestV1 } from "../../../shared/types/petPackage";
import { createPortablePetDefinition } from "../../../shared/validation/petPackage";
import { getAiConnectionSummary } from "../ai/aiSettings";
import { getLocalPetDefinition, validateReferenceAudioDuration } from "../config/petConfigStore";
import { assertExistingLocalPetDirectoryContained } from "../config/petConfigPersistence";
import { validateLive2DFolder } from "../config/live2dImportService";
import { validateReadableVoiceFile } from "../speech/voiceResourceValidation";
import { hashFile, writePetPackageArchive } from "./petPackageArchive";
import { enumerateRegularFiles, assertRegularContainedFile, type PackageSourceFile } from "./petPackagePaths";
import { beginPetPackageOperation, finishPetPackageOperation, updatePetPackageProgress } from "./petPackageOperation";
import { selectLive2DDependencyFiles } from "./petPackageLive2d";

const mimeExtension: Record<string, string> = { "audio/wav": ".wav", "audio/wave": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/ogg": ".ogg", "audio/aac": ".aac" };

function hasConfiguredVoiceResources(pet: PetDefinition): boolean {
  const voice = pet.voiceModelSettings;
  return Boolean(
    voice?.sovitsModelPath?.trim() &&
    voice.gptModelPath?.trim() &&
    voice.referenceAudioPath?.trim()
  );
}

function presetReferences(pet: PetDefinition): PetPresetAudio[] {
  const found = new Map<string, PetPresetAudio>();
  const add = (line?: PetLine): void => { if (line && typeof line !== "string" && line.presetAudio) found.set(`${line.presetAudio.resourceId}:${line.presetAudio.mimeType}`, line.presetAudio); };
  Object.values(pet.lines ?? {}).forEach((lines) => lines?.forEach(add));
  Object.values(pet.moodSettings?.ranges ?? {}).forEach((range) => add(range?.enterLine));
  return [...found.values()];
}

async function collectOptionalPetResources(pet: PetDefinition, petDirectory: string, signal: AbortSignal): Promise<PackageSourceFile[]> {
  const files: PackageSourceFile[] = [];
  if (pet.avatarImage?.startsWith(`pet-resource://local/${encodeURIComponent(pet.id)}/assets/`) || pet.avatarImage?.includes("/assets/")) {
    const avatarName = decodeURIComponent(pet.avatarImage.split("/").pop() ?? "");
    if (avatarName && path.basename(avatarName) === avatarName) {
      const sourcePath = path.join(petDirectory, "assets", avatarName);
      const stat = await assertRegularContainedFile(path.join(petDirectory, "assets"), sourcePath);
      files.push({ sourcePath, archivePath: `assets/${avatarName}`, size: stat.size });
    }
  }
  for (const [rangeId, range] of Object.entries(pet.moodSettings?.ranges ?? {})) {
    const name = range?.voiceOverride?.referenceAudio;
    if (!name || path.basename(name) !== name) continue;
    const sourcePath = path.join(petDirectory, "voice", "mood", rangeId, name);
    const stat = await assertRegularContainedFile(path.join(petDirectory, "voice"), sourcePath);
    files.push({ sourcePath, archivePath: `voice/mood/${rangeId}/${name}`, size: stat.size });
  }
  for (const audio of presetReferences(pet)) {
    const extension = mimeExtension[audio.mimeType.split(";", 1)[0].toLowerCase()];
    if (!extension) throw new Error("预设语音格式不支持导出。");
    const name = `${audio.resourceId}${extension}`;
    const sourcePath = path.join(petDirectory, "voice", "presets", name);
    const stat = await assertRegularContainedFile(path.join(petDirectory, "voice"), sourcePath);
    files.push({ sourcePath, archivePath: `voice/presets/${name}`, size: stat.size });
  }
  signal.throwIfAborted();
  return files;
}

export async function exportPetPackage(petId: string, destinationPath: string): Promise<PetPackageExportResult> {
  const operation = beginPetPackageOperation("export");
  let processed = 0;
  try {
    const pet = await getLocalPetDefinition(petId);
    if (!pet) throw new Error("桌宠不存在。");
    const petDirectory = await assertExistingLocalPetDirectoryContained(pet.id);
    const live2dRoot = path.join(petDirectory, "live2d");
    const scan = await validateLive2DFolder(live2dRoot);
    if (!scan.ok || !scan.entryRelativePath) throw new Error(scan.message || "Live2D 资源不完整。");
    const allLive2dFiles = await enumerateRegularFiles(live2dRoot, "live2d", operation.signal);
    let files = await selectLive2DDependencyFiles({
      rootPath: live2dRoot,
      entryRelativePath: scan.entryRelativePath,
      allFiles: allLive2dFiles,
      fallbackRelativePaths: scan.checks.flatMap((check) => check.files)
    });
    files.push(...await collectOptionalPetResources(pet, petDirectory, operation.signal));
    const ai = await getAiConnectionSummary(pet.id);
    const requirements = { ai: Boolean(ai?.baseUrl && ai.model && ai.hasApiKey), gptSoVits: hasConfiguredVoiceResources(pet) };
    let voicePaths: { sovitsModel: string; gptModel: string; referenceAudio: string } | undefined;
    if (requirements.gptSoVits) {
      const voice = pet.voiceModelSettings;
      if (!voice?.referenceText.trim()) throw new Error("语音参考文本不能为空。");
      await validateReadableVoiceFile(voice.sovitsModelPath ?? "", "sovits");
      await validateReadableVoiceFile(voice.gptModelPath ?? "", "gpt");
      await validateReadableVoiceFile(voice.referenceAudioPath ?? "", "referenceAudio");
      await validateReferenceAudioDuration(voice.referenceAudioPath!);
      voicePaths = {
        sovitsModel: `voice/models/sovits/${path.basename(voice.sovitsModelPath!)}`,
        gptModel: `voice/models/gpt/${path.basename(voice.gptModelPath!)}`,
        referenceAudio: `voice/reference/${path.basename(voice.referenceAudioPath!)}`
      };
      for (const [sourcePath, archivePath] of [[voice.sovitsModelPath!, voicePaths.sovitsModel], [voice.gptModelPath!, voicePaths.gptModel], [voice.referenceAudioPath!, voicePaths.referenceAudio]] as const) {
        const stat = await fs.stat(sourcePath);
        files.push({ sourcePath, archivePath, size: stat.size });
      }
    }
    const portable = createPortablePetDefinition(pet, `live2d/${scan.entryRelativePath.split(path.sep).join("/")}`, voicePaths);
    const petBytes = Buffer.byteLength(`${JSON.stringify(portable, null, 2)}\n`);
    const payloadBytes = files.reduce((sum, file) => sum + file.size, petBytes);
    const totalBytes = payloadBytes * 2;
    updatePetPackageProgress(operation.operationId, "export", "archive", 0, totalBytes, true);
    for (const file of files) {
      file.sha256 = await hashFile(file, operation.signal, (count) => {
        processed += count;
        updatePetPackageProgress(operation.operationId, "export", "archive", processed, totalBytes, true);
      });
    }
    const petHash = (await import("node:crypto")).createHash("sha256").update(`${JSON.stringify(portable, null, 2)}\n`).digest("hex");
    const manifest: PetPackageManifestV1 = {
      kind: PET_PACKAGE_KIND, formatVersion: PET_PACKAGE_FORMAT_VERSION, exportedAt: new Date().toISOString(), appVersion: app.getVersion(),
      pet: { originalPetId: pet.id, name: pet.name }, requirements,
      entries: [{ path: "pet.json", size: petBytes, sha256: petHash }, ...files.map((file) => ({ path: file.archivePath, size: file.size, sha256: file.sha256! }))]
    };
    const size = await writePetPackageArchive({ destinationPath, manifest, portablePet: portable, files, signal: operation.signal, onCompressedBytes: (count) => {
      processed = Math.min(totalBytes, processed + count);
      updatePetPackageProgress(operation.operationId, "export", "save", processed, totalBytes, true);
    }});
    updatePetPackageProgress(operation.operationId, "export", "complete", totalBytes, totalBytes, false, "success");
    return { ok: true, message: "桌宠包已安全保存。", fileName: path.basename(destinationPath), size, requirements };
  } catch (error) {
    const canceled = operation.signal.aborted || (error as Error).name === "AbortError";
    updatePetPackageProgress(operation.operationId, "export", canceled ? "canceled" : "failed", processed, Math.max(processed, 1), false, canceled ? "canceled" : "failed", canceled ? "CANCELED" : "EXPORT_FAILED");
    return { ok: false, canceled, message: canceled ? "已取消导出。" : error instanceof Error ? error.message : "导出失败。" };
  } finally { finishPetPackageOperation(operation.operationId); }
}

export async function inspectPetPackageExport(petId: string): Promise<PetPackageExportInspection> {
  try {
    const pet = await getLocalPetDefinition(petId);
    if (!pet) return { ok: false, message: "桌宠不存在。" };
    const petDirectory = await assertExistingLocalPetDirectoryContained(pet.id);
    const live2dRoot = path.join(petDirectory, "live2d");
    const scan = await validateLive2DFolder(live2dRoot);
    if (!scan.ok || !scan.entryRelativePath) return { ok: false, message: scan.message || "请先导入 Live2D 模型。" };
    const signal = new AbortController().signal;
    const allLive2dFiles = await enumerateRegularFiles(live2dRoot, "live2d", signal);
    const files = await selectLive2DDependencyFiles({ rootPath: live2dRoot, entryRelativePath: scan.entryRelativePath, allFiles: allLive2dFiles, fallbackRelativePaths: scan.checks.flatMap((check) => check.files) });
    files.push(...await collectOptionalPetResources(pet, petDirectory, signal));
    const ai = await getAiConnectionSummary(pet.id);
    const requirements = { ai: Boolean(ai?.baseUrl && ai.model && ai.hasApiKey), gptSoVits: hasConfiguredVoiceResources(pet) };
    if (requirements.gptSoVits) {
      const voice = pet.voiceModelSettings;
      await validateReadableVoiceFile(voice?.sovitsModelPath ?? "", "sovits");
      await validateReadableVoiceFile(voice?.gptModelPath ?? "", "gpt");
      await validateReadableVoiceFile(voice?.referenceAudioPath ?? "", "referenceAudio");
      await validateReferenceAudioDuration(voice!.referenceAudioPath!);
      for (const filePath of [voice!.sovitsModelPath!, voice!.gptModelPath!, voice!.referenceAudioPath!]) files.push({ sourcePath: filePath, archivePath: "voice/inspection", size: (await fs.stat(filePath)).size });
    }
    return { ok: true, message: "资源检查完成。", estimatedBytes: files.reduce((sum, file) => sum + file.size, 0), requirements };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "资源检查失败。" };
  }
}
