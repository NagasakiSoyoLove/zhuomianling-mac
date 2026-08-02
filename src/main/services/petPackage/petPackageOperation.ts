import { randomUUID } from "node:crypto";
import type { PetPackageOperationKind, PetPackageProgress, PetPackageProgressStage } from "../../../shared/types/petPackage";

type Listener = (progress: PetPackageProgress) => void;
const listeners = new Set<Listener>();
const controllers = new Map<string, AbortController>();
const snapshots = new Map<string, PetPackageProgress>();

export function onPetPackageProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function beginPetPackageOperation(kind: PetPackageOperationKind): { operationId: string; signal: AbortSignal } {
  const operationId = randomUUID();
  const controller = new AbortController();
  controllers.set(operationId, controller);
  updatePetPackageProgress(operationId, kind, "inspect", 0, 0, true);
  return { operationId, signal: controller.signal };
}

export function updatePetPackageProgress(operationId: string, kind: PetPackageOperationKind, stage: PetPackageProgressStage, processedBytes: number, totalBytes: number, cancelable: boolean, status: PetPackageProgress["status"] = "running", errorCode?: string): void {
  const previous = snapshots.get(operationId);
  const safeTotal = Math.max(0, totalBytes);
  const safeProcessed = safeTotal > 0
    ? Math.min(Math.max(0, processedBytes), safeTotal)
    : Math.max(0, processedBytes);
  const percent = safeTotal > 0 ? Math.max(previous?.percent ?? 0, Math.min(1, safeProcessed / safeTotal)) : undefined;
  const snapshot: PetPackageProgress = { operationId, kind, stage, processedBytes: safeProcessed, totalBytes: safeTotal, ...(percent === undefined ? {} : { percent }), cancelable, status, ...(errorCode ? { errorCode } : {}) };
  snapshots.set(operationId, snapshot);
  for (const listener of listeners) listener(snapshot);
  if (status !== "running") controllers.delete(operationId);
}

export function cancelPetPackageOperation(operationId: string): boolean {
  const controller = controllers.get(operationId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function finishPetPackageOperation(operationId: string): void {
  controllers.delete(operationId);
  setTimeout(() => snapshots.delete(operationId), 30_000).unref();
}

export function cancelAllPetPackageOperations(): void {
  for (const controller of controllers.values()) controller.abort();
}
