import { createHash } from "node:crypto";
import {
  screenChangeSignatureByteLength,
  screenChangeSignatureChannels
} from "../../../shared/screenChangeSignature";
import type { ScreenMonitorEvent } from "../../../shared/types/screen";

export interface ScreenDetectorFrame {
  /** RGB feature sampled from the decoded Canvas frame, never the JPEG bytes. */
  signature: Uint8Array;
  sourceKey: string;
  capturedAt: number;
}

export interface ScreenDetectorCandidate {
  sceneKey: string;
  event: ScreenMonitorEvent;
  changeRatio: number;
  stableForMs: number;
}

export interface ScreenDetectorResult {
  kind: "baseline" | "noise" | "candidate";
  changeRatio?: number;
  candidate?: ScreenDetectorCandidate;
}

export interface ScreenChangeDetectorOptions {
  stableWaitMs?: number;
  noiseThreshold?: number;
  candidateThreshold?: number;
}

/** A single RGB cell must move this far to count as a changed cell. */
const changedCellThreshold = 0.12;

function differenceRatio(left: Uint8Array, right: Uint8Array): number {
  if (
    left.length !== screenChangeSignatureByteLength
    || right.length !== screenChangeSignatureByteLength
    || left.length !== right.length
  ) return 1;

  const cellCount = left.length / screenChangeSignatureChannels;
  let total = 0;
  let changedCells = 0;
  for (let index = 0; index < left.length; index += screenChangeSignatureChannels) {
    const cellDifference = (
      Math.abs(left[index]! - right[index]!)
      + Math.abs(left[index + 1]! - right[index + 1]!)
      + Math.abs(left[index + 2]! - right[index + 2]!)
    ) / (screenChangeSignatureChannels * 255);
    total += cellDifference;
    if (cellDifference >= changedCellThreshold) changedCells += 1;
  }

  // Mean RGB difference catches broad subtle changes; changed-cell ratio
  // catches a distinct modal, panel, or card occupying a smaller area.
  return Math.max(total / cellCount, changedCells / cellCount);
}

function makeSceneKey(sourceKey: string, signature: Uint8Array): string {
  const hash = createHash("sha256").update(sourceKey).update(signature).digest("hex").slice(0, 24);
  return `scene-${hash}`;
}

function normalizeSourceKey(sourceKey: string): string {
  return sourceKey.replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 96) || "source";
}

/**
 * Keeps only a compact decoded-pixel signature. Screenshot bytes never
 * survive a call. JPEG bytes are intentionally excluded because compressed
 * byte positions do not correspond to screen pixels.
 *
 * Small animated regions are treated as noise until a stable change is
 * observed. A large change that remains present relative to the last replied
 * frame is allowed to keep accumulating even when its pixels continue to
 * animate; otherwise games and videos could reset the stability timer on
 * every sample. The mode-specific response policy lives in
 * ScreenMonitorService; this class only decides whether a bounded local
 * candidate exists.
 */
export class ScreenChangeDetector {
  private readonly stableWaitMs: number;
  private readonly noiseThreshold: number;
  private readonly candidateThreshold: number;
  /**
   * The last frame that was used as the reference for a delivered monitor
   * reply. It is intentionally not advanced for every sampled frame.
   */
  private comparisonSignature?: Uint8Array;
  private comparisonSourceKey?: string;
  private pending?: {
    signature: Uint8Array;
    sourceKey: string;
    since: number;
    event: ScreenMonitorEvent;
    changeRatio: number;
    ready: boolean;
  };

  public constructor(options: ScreenChangeDetectorOptions = {}) {
    this.stableWaitMs = options.stableWaitMs ?? 1_800;
    this.noiseThreshold = options.noiseThreshold ?? 0.02;
    this.candidateThreshold = options.candidateThreshold ?? 0.075;
  }

  public reset(): void {
    this.comparisonSignature = undefined;
    this.comparisonSourceKey = undefined;
    this.pending = undefined;
  }

  /**
   * Commits the screenshot that actually produced a visible monitor reply.
   * Silent/failed analyses must not call this method, otherwise the detector
   * would lose the user's last successfully acknowledged scene.
   */
  public commitReplyReference(frame: ScreenDetectorFrame, preservePendingSceneKey?: string): void {
    if (frame.signature.length !== screenChangeSignatureByteLength) return;
    this.comparisonSignature = frame.signature.slice();
    this.comparisonSourceKey = normalizeSourceKey(frame.sourceKey);
    const pendingSceneKey = this.pending
      ? makeSceneKey(this.pending.sourceKey, this.pending.signature)
      : undefined;
    if (!preservePendingSceneKey || pendingSceneKey === preservePendingSceneKey) {
      this.pending = undefined;
    }
  }

  /**
   * Discards a candidate after the monitor gate or model has made a final
   * decision. A candidate blocked only by a retryable gate remains pending so
   * a later frame can be analyzed without restarting stability timing.
   */
  public discardCandidate(sceneKey?: string): void {
    if (!sceneKey || !this.pending) {
      this.pending = undefined;
      return;
    }
    if (makeSceneKey(this.pending.sourceKey, this.pending.signature) === sceneKey) {
      this.pending = undefined;
    }
  }

  private candidateFromPending(
    pending: NonNullable<ScreenChangeDetector["pending"]>,
    stableForMs: number
  ): ScreenDetectorCandidate {
    return {
      sceneKey: makeSceneKey(pending.sourceKey, pending.signature),
      event: pending.event,
      changeRatio: pending.changeRatio,
      stableForMs
    };
  }

  public observe(frame: ScreenDetectorFrame): ScreenDetectorResult {
    if (frame.signature.length !== screenChangeSignatureByteLength) return { kind: "noise" };
    const signature = frame.signature.slice();
    const sourceKey = normalizeSourceKey(frame.sourceKey);

    if (!this.comparisonSignature) {
      this.comparisonSignature = signature;
      this.comparisonSourceKey = sourceKey;
      return { kind: "baseline" };
    }

    const sourceChanged = sourceKey !== this.comparisonSourceKey;
    const ratio = sourceChanged ? 1 : differenceRatio(this.comparisonSignature, signature);

    if (this.pending?.ready) {
      if (sourceChanged) {
        this.pending = {
          signature,
          sourceKey,
          since: frame.capturedAt,
          event: "app-switch",
          changeRatio: ratio,
          ready: false
        };
        return { kind: "noise", changeRatio: ratio };
      }
      if (ratio <= this.noiseThreshold) {
        this.pending = undefined;
        return { kind: "noise", changeRatio: ratio };
      }
      const pendingDifference = differenceRatio(this.pending.signature, signature);
      if (ratio < this.candidateThreshold && pendingDifference > this.noiseThreshold) {
        this.pending = undefined;
        return { kind: "noise", changeRatio: ratio };
      }
      return {
        kind: "candidate",
        candidate: this.candidateFromPending(
          this.pending,
          Math.max(0, frame.capturedAt - this.pending.since)
        )
      };
    }

    // Returning to the last successfully replied scene cancels an unfinished
    // transition instead of treating the reference scene as a new candidate.
    if (ratio <= this.noiseThreshold && this.pending) {
      this.pending = undefined;
      return { kind: "noise", changeRatio: ratio };
    }

    if (ratio <= this.noiseThreshold && !this.pending) {
      return { kind: "noise", changeRatio: ratio };
    }

    // For a large, continuously changing scene (for example a game or video),
    // compare persistence against the committed reply reference rather than
    // requiring every animated frame to match the first pending frame. This
    // still requires the full stableWaitMs, so a one-frame flash is not enough
    // to create a candidate.
    if (
      this.pending
      && !sourceChanged
      && this.pending.sourceKey === sourceKey
      && ratio >= this.candidateThreshold
    ) {
      const stableForMs = Math.max(0, frame.capturedAt - this.pending.since);
      if (stableForMs >= this.stableWaitMs) {
        this.pending.ready = true;
        return {
          kind: "candidate",
          candidate: this.candidateFromPending(this.pending, stableForMs)
        };
      }
      return { kind: "noise", changeRatio: ratio };
    }

    if (ratio < this.candidateThreshold && !sourceChanged) {
      if (this.pending) {
        const pendingDifference = differenceRatio(this.pending.signature, signature);
        if (pendingDifference <= this.noiseThreshold) {
          const stableForMs = Math.max(0, frame.capturedAt - this.pending.since);
          if (stableForMs >= this.stableWaitMs) {
            this.pending.ready = true;
            return {
              kind: "candidate",
              candidate: this.candidateFromPending(this.pending, stableForMs)
            };
          }
        } else {
          // A transition frame can be close to the immediately previous frame
          // while still being far from the first pending frame. Move the
          // stability anchor forward so a new scene cannot remain stuck as noise.
          this.pending = {
            signature,
            sourceKey,
            since: frame.capturedAt,
            event: this.pending.event,
            changeRatio: this.pending.changeRatio,
            ready: false
          };
        }
      }
      return { kind: "noise", changeRatio: ratio };
    }

    const event: ScreenMonitorEvent = sourceChanged
      ? "app-switch"
      : ratio >= Math.min(1, this.candidateThreshold * 2)
        ? "page-change"
        : "content-change";
    if (
      !this.pending
      || this.pending.sourceKey !== sourceKey
      || differenceRatio(this.pending.signature, signature) > this.noiseThreshold
    ) {
      this.pending = { signature, sourceKey, since: frame.capturedAt, event, changeRatio: ratio, ready: false };
      return { kind: "noise", changeRatio: ratio };
    }

    const stableForMs = Math.max(0, frame.capturedAt - this.pending.since);
    if (stableForMs < this.stableWaitMs) return { kind: "noise", changeRatio: ratio };

    this.pending.ready = true;
    return {
      kind: "candidate",
      candidate: this.candidateFromPending(this.pending, stableForMs)
    };
  }
}

export function calculateScreenChangeRatio(left: Uint8Array, right: Uint8Array): number {
  return differenceRatio(left, right);
}
