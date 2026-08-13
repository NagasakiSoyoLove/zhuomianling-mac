// TIMED DIAGNOSTICS TEST MODULE: local screen-change detector tests.
import { describe, expect, it } from "vitest";
import { screenChangeSignatureByteLength, screenChangeSignatureChannels } from "../../../shared/screenChangeSignature";
import {
  ScreenChangeDetector,
  calculateScreenChangeRatio,
  type ScreenDetectorFrame
} from "./ScreenChangeDetector";

function frame(value: number, capturedAt: number, sourceKey = "screen:desktop"): ScreenDetectorFrame {
  return {
    signature: new Uint8Array(screenChangeSignatureByteLength).fill(value),
    capturedAt,
    sourceKey
  };
}

function changedCellsFrame(
  changedCellCount: number,
  capturedAt: number,
  sourceKey = "screen:desktop"
): ScreenDetectorFrame {
  const signature = new Uint8Array(screenChangeSignatureByteLength);
  for (let cell = 0; cell < changedCellCount; cell += 1) {
    const start = cell * screenChangeSignatureChannels;
    signature[start] = 255;
    signature[start + 1] = 255;
    signature[start + 2] = 255;
  }
  return { signature, capturedAt, sourceKey };
}

describe("ScreenChangeDetector", () => {
  it("establishes a baseline and ignores an unchanged static frame", () => {
    const detector = new ScreenChangeDetector({ stableWaitMs: 500 });

    expect(detector.observe(frame(0, 0))).toEqual({ kind: "baseline" });
    expect(detector.observe(frame(0, 1_000))).toMatchObject({ kind: "noise", changeRatio: 0 });
    expect(detector.observe(frame(0, 2_000))).toMatchObject({ kind: "noise", changeRatio: 0 });
  });

  it("treats a small byte-level perturbation as noise", () => {
    const detector = new ScreenChangeDetector({ stableWaitMs: 500 });
    detector.observe(frame(0, 0));

    const slightlyDifferent = frame(0, 100);
    slightlyDifferent.signature[0] = 4;
    expect(detector.observe(slightlyDifferent)).toMatchObject({ kind: "noise" });
    expect(calculateScreenChangeRatio(frame(0, 0).signature, slightlyDifferent.signature)).toBeLessThan(0.035);
  });

  it("waits for a stable large change before producing a page candidate", () => {
    const detector = new ScreenChangeDetector({ stableWaitMs: 500 });
    detector.observe(frame(0, 0));

    expect(detector.observe(frame(255, 100))).toMatchObject({ kind: "noise", changeRatio: 1 });
    const result = detector.observe(frame(255, 600));

    expect(result.kind).toBe("candidate");
    expect(result.candidate).toMatchObject({
      event: "page-change",
      stableForMs: 500,
      changeRatio: 1
    });
    expect(result.candidate?.sceneKey).toMatch(/^scene-[a-f0-9]{24}$/);
  });

  it("keeps a stable candidate during a gate and cancels it when the screen returns", () => {
    const detector = new ScreenChangeDetector({ stableWaitMs: 500 });
    detector.observe(frame(0, 0));
    detector.observe(frame(255, 100));

    const first = detector.observe(frame(255, 600));
    expect(first.kind).toBe("candidate");
    expect(detector.observe(frame(255, 700))).toMatchObject({
      kind: "candidate",
      candidate: { sceneKey: first.candidate?.sceneKey }
    });

    expect(detector.observe(frame(0, 800))).toMatchObject({ kind: "noise", changeRatio: 0 });
    expect(detector.observe(frame(255, 900))).toMatchObject({ kind: "noise" });
    expect(detector.observe(frame(255, 1_400))).toMatchObject({
      kind: "candidate",
      candidate: { stableForMs: 500 }
    });
  });

  it("compares gradual changes with the last replied frame instead of the last sample", () => {
    const detector = new ScreenChangeDetector({ stableWaitMs: 500, candidateThreshold: 0.15 });
    const repliedFrame = frame(0, 0);
    expect(detector.observe(repliedFrame)).toEqual({ kind: "baseline" });
    detector.commitReplyReference(repliedFrame);

    // Each adjacent step is below the candidate threshold, but the second
    // step is large enough when measured from the last successfully replied
    // frame (0 -> 40).
    expect(detector.observe(frame(20, 100))).toMatchObject({ kind: "noise" });
    expect(detector.observe(frame(40, 200))).toMatchObject({ kind: "noise", changeRatio: expect.any(Number) });
    const result = detector.observe(frame(40, 700));
    expect(result).toMatchObject({ kind: "candidate", candidate: { stableForMs: 500 } });
    expect(result.candidate?.changeRatio).toBeGreaterThan(0.15);
  });

  it("does not reset a large candidate while a game or video keeps animating", () => {
    const detector = new ScreenChangeDetector({ stableWaitMs: 500, candidateThreshold: 0.09 });
    detector.observe(frame(0, 0));

    expect(detector.observe(frame(255, 100))).toMatchObject({ kind: "noise", changeRatio: 1 });
    // The current frame is still far from the last replied frame, even though
    // it is also far from the first pending animation frame.
    expect(detector.observe(frame(128, 200))).toMatchObject({ kind: "noise", changeRatio: 1 });
    const result = detector.observe(frame(64, 700));

    expect(result).toMatchObject({
      kind: "candidate",
      candidate: { event: "page-change", stableForMs: 600 }
    });
  });

  it("waits for a sustained large change through transition frames", () => {
    const detector = new ScreenChangeDetector({ stableWaitMs: 500 });
    detector.observe(frame(0, 0));

    expect(detector.observe(frame(255, 100))).toMatchObject({ kind: "noise" });
    expect(detector.observe(frame(128, 200))).toMatchObject({ kind: "noise" });

    const result = detector.observe(frame(128, 700));
    expect(result).toMatchObject({
      kind: "candidate",
      candidate: {
        event: "page-change",
        stableForMs: 600
      }
    });
  });

  it("detects a stable medium-sized region change from RGB cells", () => {
    const detector = new ScreenChangeDetector({ stableWaitMs: 500 });
    detector.observe(frame(0, 0));

    expect(detector.observe(changedCellsFrame(48, 100))).toMatchObject({ kind: "noise" });
    const result = detector.observe(changedCellsFrame(48, 600));

    expect(result).toMatchObject({
      kind: "candidate",
      candidate: {
        event: "content-change",
        stableForMs: 500
      }
    });
    expect(result.candidate?.changeRatio).toBeGreaterThanOrEqual(0.08);
  });

  it("keeps a 12.5 percent change quiet but observes it in companion mode", () => {
    const quiet = new ScreenChangeDetector({ stableWaitMs: 500, candidateThreshold: 0.15 });
    quiet.observe(frame(0, 0));
    expect(quiet.observe(changedCellsFrame(72, 100))).toMatchObject({ kind: "noise" });
    expect(quiet.observe(changedCellsFrame(72, 600))).toMatchObject({ kind: "noise" });

    const companion = new ScreenChangeDetector({ stableWaitMs: 500, candidateThreshold: 0.09 });
    companion.observe(frame(0, 0));
    expect(companion.observe(changedCellsFrame(72, 100))).toMatchObject({ kind: "noise" });
    expect(companion.observe(changedCellsFrame(72, 600))).toMatchObject({
      kind: "candidate",
      candidate: { event: "content-change" }
    });
  });

  it("classifies a source switch separately from content changes", () => {
    const detector = new ScreenChangeDetector({ stableWaitMs: 500 });
    detector.observe(frame(0, 0, "screen:desktop"));
    detector.observe(frame(0, 100, "window:editor"));

    const result = detector.observe(frame(0, 600, "window:editor"));
    expect(result.kind).toBe("candidate");
    expect(result.candidate?.event).toBe("app-switch");
  });

  it("uses the stable candidate signature for the scene key", () => {
    const detector = new ScreenChangeDetector({ stableWaitMs: 100 });
    detector.observe(frame(0, 0));
    detector.observe(frame(255, 100));
    const first = detector.observe(frame(255, 200));

    detector.observe(frame(0, 300));
    detector.observe(frame(255, 400));
    const second = detector.observe(frame(255, 500));

    expect(first.candidate?.sceneKey).toBe(second.candidate?.sceneKey);
  });
});
