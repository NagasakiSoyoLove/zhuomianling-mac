// TIMED DIAGNOSTICS TEST MODULE: session-only visual history tests.
import { describe, expect, it } from "vitest";
import type { ScreenFrame, ScreenMonitorDecision } from "../../../shared/types/screen";
import {
  appendScreenVisualContext,
  createScreenVisualContextEntry,
  SCREEN_VISUAL_CONTEXT_LIMIT,
  selectPlayedScreenVisualContext
} from "./ScreenVisualContext";

function frame(seed: number): ScreenFrame {
  return {
    data: new Uint8Array([seed, seed + 1, seed + 2]),
    mimeType: "image/jpeg",
    width: 10,
    height: 10,
    capturedAt: seed
  };
}

function decision(sceneKey: string): ScreenMonitorDecision {
  return {
    action: "speak",
    event: "content-change",
    sceneKey,
    reply: `第 ${sceneKey} 条`
  };
}

describe("screen visual context", () => {
  it("keeps a fixed six-record session history and drops the oldest record", () => {
    const history = [] as ReturnType<typeof createScreenVisualContextEntry>[];
    for (let index = 0; index < SCREEN_VISUAL_CONTEXT_LIMIT + 2; index += 1) {
      const sceneKey = `scene-${index}`;
      appendScreenVisualContext(
        history,
        createScreenVisualContextEntry(
          frame(index),
          "companion",
          { event: "content-change", sceneKey },
          decision(sceneKey)
        )
      );
    }

    expect(history).toHaveLength(6);
    expect(history.map((entry) => entry.sceneKey)).toEqual([
      "scene-2",
      "scene-3",
      "scene-4",
      "scene-5",
      "scene-6",
      "scene-7"
    ]);
  });

  it("copies frame bytes so transient IPC frame buffers are not reused", () => {
    const source = frame(1);
    const entry = createScreenVisualContextEntry(
      source,
      "quiet",
      { event: "same-scene", sceneKey: "scene-copy" },
      { ...decision("scene-copy"), event: "same-scene" }
    );

    expect(entry.delivery).toBe("played");
    source.data[0] = 99;
    expect(entry.frame.data[0]).toBe(1);
  });

  it("selects only played entries for the next monitor analysis", () => {
    const played = createScreenVisualContextEntry(
      frame(1),
      "quiet",
      { event: "content-change", sceneKey: "played-scene" },
      decision("played-scene")
    );
    const dropped = {
      ...played,
      sceneKey: "dropped-scene",
      delivery: "dropped"
    } as unknown as typeof played;

    expect(selectPlayedScreenVisualContext([dropped, played])).toEqual([played]);
  });
});
