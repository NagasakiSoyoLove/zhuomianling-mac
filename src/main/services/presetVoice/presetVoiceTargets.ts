import { createHash } from "node:crypto";
import { moodVoiceFallbackChains, petMoodRanges, type PetMoodRangeId } from "../../../shared/mood";
import type {
  PetDefinition,
  PetLine,
  PetPresetLine,
  PetVoiceLanguage
} from "../../../shared/types/pet";
import type {
  PresetVoiceSummary,
  PresetVoiceTarget,
  PresetVoiceTargetKind,
  PresetVoiceTargetStatus
} from "../../../shared/types/presetVoice";
import { hashPresetVoiceText } from "./presetVoiceFingerprint";

export interface PresetMoodVoiceSelection {
  requestedRangeId: PetMoodRangeId;
  resolvedRangeId?: PetMoodRangeId;
  kind: "mood-override" | "default" | "unavailable";
  referenceIdentity?: string;
  referenceText?: string;
}

function getLine(line: PetLine): PetPresetLine {
  return typeof line === "string" ? { text: line } : line;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 20);
}

function getStatus(line: PetPresetLine): PresetVoiceTargetStatus {
  const audio = line.presetAudio;
  if (!audio) return "missing";
  if (audio.schemaVersion !== 1 || !audio.resourceId || !audio.voiceFingerprint) return "invalid";
  return audio.sourceTextHash === hashPresetVoiceText(line.text) ? "ready" : "stale";
}

function createLegacyTargetId(kind: PresetVoiceTargetKind, groupId: string, text: string, occurrence: number): string {
  return `legacy-${kind}-${shortHash(`${groupId}\u0000${text}\u0000${occurrence}`)}`;
}

export function resolvePresetMoodVoiceSelection(
  pet: PetDefinition,
  requestedRangeId: PetMoodRangeId
): PresetMoodVoiceSelection {
  for (const candidate of moodVoiceFallbackChains[requestedRangeId]) {
    const override = pet.moodSettings?.ranges?.[candidate]?.voiceOverride;
    if (override?.referenceAudio && override.referenceText.trim()) {
      return {
        requestedRangeId,
        resolvedRangeId: candidate,
        kind: "mood-override",
        referenceIdentity: `mood:${candidate}:${override.referenceAudio}`,
        referenceText: override.referenceText.trim()
      };
    }
  }

  const settings = pet.voiceModelSettings;
  if (settings?.referenceAudioPath && settings.referenceText.trim()) {
    return {
      requestedRangeId,
      kind: "default",
      referenceIdentity: "default",
      referenceText: settings.referenceText.trim()
    };
  }

  return { requestedRangeId, kind: "unavailable" };
}

export function collectPresetVoiceTargets(pet: PetDefinition): PresetVoiceTarget[] {
  const targets: PresetVoiceTarget[] = [];

  for (const [event, rawLines] of Object.entries(pet.lines ?? {})) {
    const occurrences = new Map<string, number>();
    for (const [lineIndex, rawLine] of (rawLines ?? []).entries()) {
      const line = getLine(rawLine);
      const text = line.text.trim();
      if (!text) continue;
      const occurrence = occurrences.get(text) ?? 0;
      occurrences.set(text, occurrence + 1);
      targets.push({
        targetId: line.id ?? createLegacyTargetId("event-line", event, text, occurrence),
        kind: "event-line",
        groupId: event,
        groupLabel: event,
        text,
        ...(line.id ? { lineId: line.id } : {}),
        event,
        lineIndex,
        ...(line.presetAudio ? { audio: line.presetAudio } : {}),
        status: getStatus(line)
      });
    }
  }

  for (const range of petMoodRanges) {
    const rawLine = pet.moodSettings?.ranges?.[range.id]?.enterLine;
    if (!rawLine) continue;
    const line = getLine(rawLine);
    const text = line.text.trim();
    if (!text) continue;
    targets.push({
      targetId: line.id ?? createLegacyTargetId("mood-enter-line", range.id, text, 0),
      kind: "mood-enter-line",
      groupId: range.id,
      groupLabel: range.label,
      text,
      ...(line.id ? { lineId: line.id } : {}),
      moodRangeId: range.id,
      ...(line.presetAudio ? { audio: line.presetAudio } : {}),
      status: getStatus(line)
    });
  }

  return targets;
}

export function summarizePresetVoiceTargets(targets: readonly PresetVoiceTarget[]): PresetVoiceSummary {
  return {
    total: targets.length,
    ready: targets.filter((target) => target.status === "ready").length,
    missing: targets.filter((target) => target.status === "missing").length,
    stale: targets.filter((target) => target.status === "stale").length,
    invalid: targets.filter((target) => target.status === "invalid").length,
    eventTotal: targets.filter((target) => target.kind === "event-line").length,
    moodTotal: targets.filter((target) => target.kind === "mood-enter-line").length
  };
}

export function getPresetVoiceLanguage(pet: PetDefinition): PetVoiceLanguage {
  return pet.voiceModelSettings?.language ?? "zh";
}
