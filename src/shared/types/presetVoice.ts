import type { PetMoodRangeId } from "../mood";
import type { PetPresetAudio, PetVoiceLanguage } from "./pet";

export type PresetVoiceTargetKind = "event-line" | "mood-enter-line";
export type PresetVoiceTargetStatus = "missing" | "ready" | "stale" | "invalid";

export interface PresetVoiceTarget {
  targetId: string;
  kind: PresetVoiceTargetKind;
  groupId: string;
  groupLabel: string;
  text: string;
  lineId?: string;
  event?: string;
  lineIndex?: number;
  moodRangeId?: PetMoodRangeId;
  audio?: PetPresetAudio;
  status: PresetVoiceTargetStatus;
}

export interface PresetVoiceSummary {
  total: number;
  ready: number;
  missing: number;
  stale: number;
  invalid: number;
  eventTotal: number;
  moodTotal: number;
}

export interface PresetVoiceOverview {
  petId: string;
  voiceConfigured: boolean;
  summary: PresetVoiceSummary;
  targets: PresetVoiceTarget[];
}

export type PresetVoiceGenerationScope = "missing" | "all";

export interface PresetVoiceGenerationRequest {
  petId: string;
  scope: PresetVoiceGenerationScope;
  /** Restricts the task to one line. Omitted for batch generation. */
  targetId?: string;
  translation: "source" | "translate";
  targetLanguage?: PetVoiceLanguage;
}

export type PresetVoiceTaskStatus = "running" | "completed" | "canceled" | "failed";

export interface PresetVoiceTaskFailure {
  targetId: string;
  message: string;
}

export interface PresetVoiceTaskSnapshot {
  taskId: string;
  petId: string;
  status: PresetVoiceTaskStatus;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentTargetId?: string;
  failures: PresetVoiceTaskFailure[];
  message?: string;
}

export interface PresetVoiceTaskStartResult {
  ok: boolean;
  message: string;
  task?: PresetVoiceTaskSnapshot;
}

export interface PresetVoiceTaskCancelRequest {
  petId: string;
  taskId: string;
}

export interface PresetVoiceTaskCancelResult {
  ok: boolean;
  message: string;
}

export interface PresetVoicePreviewRequest {
  petId: string;
  targetId: string;
}

export interface PresetVoicePreviewResult {
  ok: boolean;
  message: string;
  audioBase64?: string;
  mimeType?: string;
}

export interface PresetVoiceDeleteResult {
  ok: boolean;
  message: string;
  removed: number;
}

export interface PresetVoiceDeleteOneRequest {
  petId: string;
  targetId: string;
}
