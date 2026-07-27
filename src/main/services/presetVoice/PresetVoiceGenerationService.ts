import { randomUUID } from "node:crypto";
import type { PetDefinition, PetPresetAudio, PetVoiceLanguage } from "../../../shared/types/pet";
import type {
  PresetVoiceGenerationRequest,
  PresetVoiceDeleteResult,
  PresetVoiceOverview,
  PresetVoicePreviewResult,
  PresetVoiceTarget,
  PresetVoiceTaskSnapshot,
  PresetVoiceTaskStartResult
} from "../../../shared/types/presetVoice";
import { assertValidPetId } from "../../../shared/validation/petId";
import {
  clearLocalPetPresetAudio,
  clearLocalPetPresetAudioTarget,
  commitLocalPetPresetAudio,
  getLocalPetDefinition
} from "../config/petConfigStore";
import { synthesizePresetText } from "../speech/textToSpeech";
import {
  createPresetVoiceFingerprint,
  hashPresetVoicePersona,
  hashPresetVoiceText
} from "./presetVoiceFingerprint";
import {
  readPresetVoiceAudio,
  removeAllPresetVoiceAudio,
  removePresetVoiceAudio,
  storePresetVoiceAudio
} from "./presetVoiceStorage";
import { collectPresetVoiceTargets, summarizePresetVoiceTargets } from "./presetVoiceTargets";
import { translatePresetVoiceText } from "./presetVoiceTranslation";

const maximumTargetsPerTask = 512;
const maximumFailureMessageChars = 400;

interface ActiveTask {
  controller: AbortController;
  request: PresetVoiceGenerationRequest;
  snapshot: PresetVoiceTaskSnapshot;
  run?: Promise<void>;
}

export type PresetVoiceProgressListener = (snapshot: PresetVoiceTaskSnapshot) => void;

function cloneSnapshot(snapshot: PresetVoiceTaskSnapshot): PresetVoiceTaskSnapshot {
  return { ...snapshot, failures: snapshot.failures.map((failure) => ({ ...failure })) };
}

function toFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "预设语音生成失败。";
  return message.replace(/[\r\n\t]+/g, " ").trim().slice(0, maximumFailureMessageChars) || "预设语音生成失败。";
}

function isVoiceConfigured(pet: PetDefinition): boolean {
  const settings = pet.voiceModelSettings;
  return Boolean(
    pet.capabilities.voiceOutput && settings?.enabled && settings.connected &&
    settings.referenceAudioPath && settings.referenceText.trim()
  );
}

function getReferenceDetails(
  pet: PetDefinition,
  target: PresetVoiceTarget,
  resolvedMoodRange?: PetPresetAudio["resolvedMoodRange"]
): { identity: string; text: string } {
  if (target.kind === "mood-enter-line" && resolvedMoodRange) {
    const override = pet.moodSettings?.ranges?.[resolvedMoodRange]?.voiceOverride;
    if (override) {
      return {
        identity: `mood:${resolvedMoodRange}:${override.referenceAudio}`,
        text: override.referenceText
      };
    }
  }
  const settings = pet.voiceModelSettings;
  return {
    identity: `default:${settings?.referenceAudioPath ?? ""}`,
    text: settings?.referenceText ?? ""
  };
}

export class PresetVoiceGenerationService {
  private readonly tasks = new Map<string, ActiveTask>();
  private readonly listeners = new Set<PresetVoiceProgressListener>();

  onProgress(listener: PresetVoiceProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(task: ActiveTask): void {
    const snapshot = cloneSnapshot(task.snapshot);
    for (const listener of this.listeners) listener(snapshot);
  }

  async getOverview(petId: string): Promise<PresetVoiceOverview> {
    const id = assertValidPetId(petId);
    const pet = await getLocalPetDefinition(id);
    if (!pet) throw new Error("当前桌宠配置不存在。");
    const targets = collectPresetVoiceTargets(pet);
    return {
      petId: id,
      voiceConfigured: isVoiceConfigured(pet),
      summary: summarizePresetVoiceTargets(targets),
      targets
    };
  }

  getTask(petId: string): PresetVoiceTaskSnapshot | undefined {
    const task = this.tasks.get(assertValidPetId(petId));
    return task ? cloneSnapshot(task.snapshot) : undefined;
  }

  async preview(petId: string, targetId: string): Promise<PresetVoicePreviewResult> {
    const id = assertValidPetId(petId);
    const pet = await getLocalPetDefinition(id);
    if (!pet) return { ok: false, message: "当前桌宠配置不存在。" };
    const target = collectPresetVoiceTargets(pet).find((item) => item.targetId === targetId);
    if (!target?.audio || target.status !== "ready") {
      return { ok: false, message: "这条台词没有可试听的有效预设语音。" };
    }
    try {
      const bytes = await readPresetVoiceAudio({
        petId: id,
        resourceId: target.audio.resourceId,
        mimeType: target.audio.mimeType
      });
      return {
        ok: true,
        message: "ok",
        audioBase64: bytes.toString("base64"),
        mimeType: target.audio.mimeType
      };
    } catch {
      return { ok: false, message: "预设语音文件不可用，请重新生成。" };
    }
  }

  async start(request: PresetVoiceGenerationRequest): Promise<PresetVoiceTaskStartResult> {
    const petId = assertValidPetId(request.petId);
    const existing = this.tasks.get(petId);
    if (existing?.snapshot.status === "running") {
      return { ok: false, message: "当前桌宠已有预设语音生成任务。", task: cloneSnapshot(existing.snapshot) };
    }
    const pet = await getLocalPetDefinition(petId);
    if (!pet) return { ok: false, message: "当前桌宠配置不存在。" };
    if (!isVoiceConfigured(pet)) return { ok: false, message: "请先保存并连接当前桌宠的声音模型。" };
    if (request.translation === "translate" && !request.targetLanguage) {
      return { ok: false, message: "使用 AI 翻译时必须选择目标语言。" };
    }
    const allTargets = collectPresetVoiceTargets(pet);
    const scopedTargets = request.targetId
      ? allTargets.filter((target) => target.targetId === request.targetId)
      : allTargets;
    if (request.targetId && !scopedTargets.length) {
      return { ok: false, message: "这条预设台词已不存在，请刷新后重试。" };
    }
    const targets = request.scope === "all"
      ? scopedTargets
      : scopedTargets.filter((target) => target.status !== "ready");
    if (targets.length > maximumTargetsPerTask) {
      return { ok: false, message: `单次最多生成 ${maximumTargetsPerTask} 条预设语音。` };
    }
    const task: ActiveTask = {
      controller: new AbortController(),
      request: { ...request, petId },
      snapshot: {
        taskId: randomUUID(),
        petId,
        status: "running",
        total: targets.length,
        completed: 0,
        succeeded: 0,
        failed: 0,
        failures: [],
        message: targets.length ? "正在生成预设语音。" : "没有需要生成的预设语音。"
      }
    };
    this.tasks.set(petId, task);
    if (!targets.length) {
      task.snapshot.status = "completed";
      this.emit(task);
      return { ok: true, message: task.snapshot.message!, task: cloneSnapshot(task.snapshot) };
    }
    this.emit(task);
    task.run = this.runTask(task, pet, targets);
    void task.run.catch(() => undefined);
    return { ok: true, message: "预设语音生成任务已开始。", task: cloneSnapshot(task.snapshot) };
  }

  cancel(petId: string, taskId: string): boolean {
    const task = this.tasks.get(assertValidPetId(petId));
    if (!task || task.snapshot.taskId !== taskId || task.snapshot.status !== "running") return false;
    task.controller.abort("renderer");
    return true;
  }

  async cancelAndWaitForPet(petId: string): Promise<void> {
    const id = assertValidPetId(petId);
    const task = this.tasks.get(id);
    if (task?.snapshot.status === "running") task.controller.abort("pet-deleted");
    await task?.run?.catch(() => undefined);
  }

  async deleteAll(petId: string): Promise<PresetVoiceDeleteResult & { pet?: PetDefinition }> {
    const id = assertValidPetId(petId);
    await this.cancelAndWaitForPet(id);
    const result = await clearLocalPetPresetAudio(id);
    try {
      await removeAllPresetVoiceAudio(id);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "预设语音文件清理失败，请重试。",
        removed: result.removed.length,
        pet: result.pet
      };
    }
    return {
      ok: true,
      message: `已删除 ${result.removed.length} 条预设台词语音。`,
      removed: result.removed.length,
      pet: result.pet
    };
  }

  async deleteOne(
    petId: string,
    targetId: string
  ): Promise<PresetVoiceDeleteResult & { pet?: PetDefinition }> {
    const id = assertValidPetId(petId);
    const active = this.tasks.get(id);
    if (active?.snapshot.status === "running") {
      return { ok: false, message: "预设语音任务运行期间不能删除单句语音。", removed: 0 };
    }
    const pet = await getLocalPetDefinition(id);
    if (!pet) return { ok: false, message: "当前桌宠配置不存在。", removed: 0 };
    const target = collectPresetVoiceTargets(pet).find((item) => item.targetId === targetId);
    if (!target) return { ok: false, message: "这条预设台词已不存在，请刷新后重试。", removed: 0 };
    if (!target.audio) return { ok: false, message: "这条台词没有可删除的预设语音。", removed: 0 };

    const result = await clearLocalPetPresetAudioTarget({ petId: id, target });
    if (!result.removed) {
      return { ok: false, message: "这条台词的语音绑定已变化，请刷新后重试。", removed: 0, pet: result.pet };
    }
    if (result.shouldDeleteFile) {
      try {
        await removePresetVoiceAudio({
          petId: id,
          resourceId: result.removed.resourceId,
          mimeType: result.removed.mimeType
        });
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "语音绑定已删除，但音频文件清理失败。",
          removed: 1,
          pet: result.pet
        };
      }
    }
    return { ok: true, message: "这条台词的预设语音已删除。", removed: 1, pet: result.pet };
  }

  async disposePet(petId: string): Promise<void> {
    const id = assertValidPetId(petId);
    await this.cancelAndWaitForPet(id);
    this.tasks.delete(id);
  }

  async shutdown(): Promise<void> {
    const running: Promise<void>[] = [];
    for (const task of this.tasks.values()) {
      if (task.snapshot.status === "running") task.controller.abort("app-exit");
      if (task.run) running.push(task.run.catch(() => undefined));
    }
    await Promise.all(running);
    this.tasks.clear();
  }

  private async runTask(task: ActiveTask, initialPet: PetDefinition, targets: PresetVoiceTarget[]): Promise<void> {
    let pet = initialPet;
    for (const target of targets) {
      if (task.controller.signal.aborted) break;
      task.snapshot.currentTargetId = target.targetId;
      this.emit(task);
      let stored: { resourceId: string; mimeType: string } | undefined;
      try {
        const settings = pet.voiceModelSettings;
        if (!settings) throw new Error("声音模型配置不存在。");
        const language: PetVoiceLanguage = task.request.translation === "translate"
          ? task.request.targetLanguage!
          : settings.language;
        const spokenText = task.request.translation === "translate"
          ? await translatePresetVoiceText({
              petId: pet.id,
              text: target.text,
              personaPrompt: pet.personaPrompt,
              targetLanguage: language,
              signal: task.controller.signal
            })
          : target.text;
        const personaFingerprint = task.request.translation === "translate"
          ? hashPresetVoicePersona(pet.personaPrompt)
          : undefined;
        const response = await synthesizePresetText({
          petId: pet.id,
          text: spokenText,
          requestId: `preset-${task.snapshot.taskId}-${task.snapshot.completed + 1}`
        }, {
          signal: task.controller.signal,
          language,
          ...(target.moodRangeId ? { moodRangeId: target.moodRangeId } : {})
        });
        if (!response.ok || !response.audioBase64) throw new Error(response.message);
        const bytes = Buffer.from(response.audioBase64, "base64");
        stored = await storePresetVoiceAudio({
          petId: pet.id,
          bytes,
          mimeType: response.mimeType ?? "audio/wav"
        });
        if (task.controller.signal.aborted) throw new Error("预设语音生成已取消。");
        const reference = getReferenceDetails(pet, target, response.resolvedMoodRange);
        const audio: PetPresetAudio = {
          schemaVersion: 1,
          resourceId: stored.resourceId,
          sourceTextHash: hashPresetVoiceText(target.text),
          spokenText,
          language,
          mimeType: stored.mimeType,
          voiceFingerprint: createPresetVoiceFingerprint({
            sourceText: target.text,
            spokenText,
            language,
            voiceSettings: settings,
            referenceIdentity: reference.identity,
            referenceText: reference.text,
            ...(personaFingerprint ? { personaFingerprint } : {}),
            ...(target.moodRangeId ? { requestedMoodRange: target.moodRangeId } : {}),
            ...(response.resolvedMoodRange ? { resolvedMoodRange: response.resolvedMoodRange } : {})
          }),
          ...(personaFingerprint ? { personaFingerprint } : {}),
          ...(target.moodRangeId ? { requestedMoodRange: target.moodRangeId } : {}),
          ...(response.resolvedMoodRange ? { resolvedMoodRange: response.resolvedMoodRange } : {}),
          generatedAt: Date.now()
        };
        const committed = await commitLocalPetPresetAudio({ petId: pet.id, target, audio });
        pet = committed.pet;
        if (committed.previousAudio && committed.previousAudio.resourceId !== stored.resourceId) {
          await removePresetVoiceAudio({
            petId: pet.id,
            resourceId: committed.previousAudio?.resourceId ?? "",
            mimeType: committed.previousAudio?.mimeType ?? ""
          });
        }
        stored = undefined;
        task.snapshot.succeeded += 1;
      } catch (error) {
        if (stored) {
          await removePresetVoiceAudio({ petId: pet.id, ...stored }).catch(() => undefined);
        }
        if (task.controller.signal.aborted) break;
        task.snapshot.failed += 1;
        task.snapshot.failures.push({ targetId: target.targetId, message: toFailureMessage(error) });
      } finally {
        if (!task.controller.signal.aborted) task.snapshot.completed += 1;
        this.emit(task);
      }
    }
    task.snapshot.currentTargetId = undefined;
    if (task.controller.signal.aborted) {
      task.snapshot.status = "canceled";
      task.snapshot.message = `已取消，成功保存 ${task.snapshot.succeeded} 条语音。`;
    } else if (task.snapshot.failed > 0 && task.snapshot.succeeded === 0) {
      task.snapshot.status = "failed";
      task.snapshot.message = "预设语音生成失败。";
    } else {
      task.snapshot.status = "completed";
      task.snapshot.message = task.snapshot.failed
        ? `生成完成，${task.snapshot.failed} 条失败。`
        : "所有预设语音生成完成。";
    }
    this.emit(task);
  }
}

export const presetVoiceGenerationService = new PresetVoiceGenerationService();
