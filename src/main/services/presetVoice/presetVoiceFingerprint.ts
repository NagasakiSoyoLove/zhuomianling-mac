import { createHash } from "node:crypto";
import type { PetMoodRangeId } from "../../../shared/mood";
import type { PetVoiceLanguage, PetVoiceModelSettings } from "../../../shared/types/pet";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashPresetVoiceText(text: string): string {
  return sha256(text.trim().normalize("NFC"));
}

export function hashPresetVoicePersona(personaPrompt: string): string {
  return sha256(personaPrompt.trim().normalize("NFC"));
}

export interface PresetVoiceFingerprintInput {
  sourceText: string;
  spokenText: string;
  language: PetVoiceLanguage;
  voiceSettings: PetVoiceModelSettings;
  referenceIdentity: string;
  referenceText: string;
  personaFingerprint?: string;
  requestedMoodRange?: PetMoodRangeId;
  resolvedMoodRange?: PetMoodRangeId;
}

export function createPresetVoiceFingerprint(input: PresetVoiceFingerprintInput): string {
  const settings = input.voiceSettings;
  return sha256(JSON.stringify({
    schemaVersion: 1,
    sourceText: input.sourceText.trim().normalize("NFC"),
    spokenText: input.spokenText.trim().normalize("NFC"),
    language: input.language,
    modelVersion: settings.modelVersion,
    gptSoVitsRootPath: settings.gptSoVitsRootPath ?? "",
    sovitsModelPath: settings.sovitsModelPath ?? "",
    gptModelPath: settings.gptModelPath ?? "",
    inferenceDevice: settings.inferenceDevice ?? "auto",
    halfPrecision: settings.halfPrecision ?? true,
    referenceIdentity: input.referenceIdentity,
    referenceText: input.referenceText.trim().normalize("NFC"),
    requestedMoodRange: input.requestedMoodRange ?? null,
    resolvedMoodRange: input.resolvedMoodRange ?? null,
    ...(input.personaFingerprint ? { personaFingerprint: input.personaFingerprint } : {})
  }));
}
