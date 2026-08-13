import type { AiConnectionDraft, AiModelListResult } from "./ai";
import type { PetDefinition, PetVoiceModelSettings } from "./pet";

export const PET_PACKAGE_KIND = "zhuomianling-pet-package" as const;
export const PET_PACKAGE_FORMAT_VERSION = 1 as const;

export interface PetPackageEntryV1 {
  path: string;
  size: number;
  sha256: string;
}

export interface PetPackageManifestV1 {
  kind: typeof PET_PACKAGE_KIND;
  formatVersion: typeof PET_PACKAGE_FORMAT_VERSION;
  exportedAt: string;
  appVersion: string;
  pet: { originalPetId: string; name: string };
  requirements: { ai: boolean; gptSoVits: boolean };
  entries: PetPackageEntryV1[];
}

export type PortablePetDefinitionV1 = Omit<
  PetDefinition,
  "id" | "modelPath" | "avatarImage" | "memorySettings" | "voiceInputSettings" | "screenAwarenessSettings" | "isLocal" | "voiceModelSettings"
> & {
  schemaVersion: 1;
  live2dEntry: string;
  avatar?: string;
  voiceModelSettings?: Omit<
    PetVoiceModelSettings,
    "connected" | "gptSoVitsRootPath" | "sovitsModelPath" | "gptModelPath" | "referenceAudioPath"
  > & {
    connected: false;
    sovitsModel?: string;
    gptModel?: string;
    referenceAudio?: string;
  };
};

export type PetPackageOperationKind = "export" | "import";
export type PetPackageProgressStage =
  | "inspect"
  | "archive"
  | "save"
  | "extract"
  | "validate"
  | "test-ai"
  | "test-voice"
  | "commit"
  | "complete"
  | "canceled"
  | "failed";

export interface PetPackageProgress {
  operationId: string;
  kind: PetPackageOperationKind;
  stage: PetPackageProgressStage;
  processedBytes: number;
  totalBytes: number;
  percent?: number;
  cancelable: boolean;
  status: "running" | "success" | "failed" | "canceled";
  errorCode?: string;
}

export interface PetPackageExportRequest { petId: string }
export interface PetPackageExportInspection {
  ok: boolean;
  message: string;
  estimatedBytes?: number;
  requirements?: PetPackageManifestV1["requirements"];
}
export interface PetPackageExportResult {
  ok: boolean;
  canceled?: boolean;
  message: string;
  fileName?: string;
  size?: number;
  requirements?: PetPackageManifestV1["requirements"];
}

export interface PetPackageImportBeginResult {
  ok: boolean;
  canceled?: boolean;
  message: string;
  sessionId?: string;
  packageName?: string;
  petName?: string;
  avatarDataUrl?: string;
  requirements?: PetPackageManifestV1["requirements"];
  contents?: { live2d: boolean; avatar: boolean; voice: boolean; customTheme: boolean };
}

export interface PetPackageImportAiModelsRequest {
  sessionId: string;
  baseUrl: string;
  apiKey: string;
}
export interface PetPackageImportAiModelsResult extends AiModelListResult {
  providerName: string;
}
export interface PetPackageImportAiRequest {
  sessionId: string;
  draft: Pick<AiConnectionDraft, "baseUrl" | "apiKey" | "model">;
}
export interface PetPackageImportVoiceRequest { sessionId: string; gptSoVitsRootPath: string }
export interface PetPackageDirectoryPickResult { ok: boolean; canceled?: boolean; message: string; directoryPath?: string }
export interface PetPackageImportCommitRequest { sessionId: string }
export interface PetPackageImportCancelRequest { sessionId?: string; operationId?: string }
export interface PetPackageImportStepResult { ok: boolean; message: string }
export interface PetPackageImportCommitResult extends PetPackageImportStepResult {
  pet?: PetDefinition;
}
