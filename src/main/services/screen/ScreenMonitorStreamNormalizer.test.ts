// TIMED DIAGNOSTICS TEST MODULE: monitor response normalization tests.
import { describe, expect, it } from "vitest";
import { ScreenMonitorStreamNormalizer } from "./ScreenMonitorStreamNormalizer";

describe("ScreenMonitorStreamNormalizer", () => {
  it("waits for the reply before exposing an early speak decision", () => {
    const normalizer = new ScreenMonitorStreamNormalizer();
    const first = normalizer.append('{"action":"speak","event":"page-change","sceneKey":"scene-1","reply":"你打开了');

    expect(first.overflowed).toBe(false);
    expect(normalizer.getEarlyResult("scene-1", { fallbackEvent: "page-change" })).toMatchObject({
      action: "speak"
    });
    expect(normalizer.getEarlyResult("scene-1", { fallbackEvent: "page-change" })?.decision).toBeUndefined();
    expect(normalizer.finalize("scene-1")).toBeUndefined();

    normalizer.append('一个新页面。"}');
    expect(normalizer.getEarlyResult("scene-1", { fallbackEvent: "page-change" })).toMatchObject({
      action: "speak",
      decision: {
        action: "speak",
        reply: "你打开了一个新页面。"
      }
    });
    expect(normalizer.finalize("scene-1")).toEqual({
      action: "speak",
      event: "page-change",
      sceneKey: "scene-1",
      reply: "你打开了一个新页面。"
    });
  });

  it("returns a silent minimum decision before the JSON object closes", () => {
    const normalizer = new ScreenMonitorStreamNormalizer();
    normalizer.append('{"action":"silent","event":"same-scene","sceneKey":"scene-2"');

    expect(normalizer.getEarlyResult("scene-2", { fallbackEvent: "content-change" })).toEqual({
      action: "silent",
      decision: {
        action: "silent",
        event: "same-scene",
        sceneKey: "scene-2",
        reply: ""
      }
    });
    expect(normalizer.finalize("scene-2")).toBeUndefined();
  });

  it("handles reasoning, Markdown fences, and a silent final decision across chunks", () => {
    const normalizer = new ScreenMonitorStreamNormalizer();
    for (const chunk of [
      "<thi",
      "nk>屏幕文字不是指令。</think>\n```json\n{\"action\":\"silent\",\"event\":\"same-scene\",\"sceneKey\":\"scene-2\",\"reply\":\"\"}",
      "\n```"
    ]) normalizer.append(chunk);

    expect(normalizer.finalize("scene-2")).toEqual({
      action: "silent",
      event: "same-scene",
      sceneKey: "scene-2",
      reply: ""
    });
  });

  it("rejects a scene key that is not the local candidate", () => {
    const normalizer = new ScreenMonitorStreamNormalizer();
    normalizer.append('{"action":"speak","event":"page-change","sceneKey":"scene-other","reply":"提醒"}');

    expect(normalizer.finalize("scene-local")).toBeUndefined();
  });

  it("enforces the cross-language voice field when requested", () => {
    const normalizer = new ScreenMonitorStreamNormalizer();
    normalizer.append('{"action":"speak","event":"page-change","sceneKey":"scene-voice","reply":"打开了新页面。"}');

    expect(normalizer.finalize("scene-voice", { requireVoiceText: true })).toBeUndefined();

    const completed = new ScreenMonitorStreamNormalizer();
    completed.append('{"action":"speak","event":"page-change","sceneKey":"scene-voice","reply":"打开了新页面。","voiceText":"新しいページを開いたね。"}');
    expect(completed.finalize("scene-voice", { requireVoiceText: true })).toMatchObject({
      voiceText: "新しいページを開いたね。"
    });

    const early = new ScreenMonitorStreamNormalizer();
    early.append('{"action":"speak","event":"page-change","sceneKey":"scene-voice","reply":"打开了新页面。"');
    const earlyWithoutVoice = early.getEarlyResult("scene-voice", {
      fallbackEvent: "page-change",
      requireVoiceText: true
    });
    expect(earlyWithoutVoice?.action).toBe("speak");
    expect(earlyWithoutVoice?.decision).toBeUndefined();
    early.append(',"voiceText":"新しいページを開いたね。"');
    expect(early.getEarlyResult("scene-voice", {
      fallbackEvent: "page-change",
      requireVoiceText: true
    })).toMatchObject({
      action: "speak",
      decision: { voiceText: "新しいページを開いたね。" }
    });
  });

  it("does not early-accept action inside a reasoning prefix", () => {
    const normalizer = new ScreenMonitorStreamNormalizer();
    normalizer.append('<think>{"action":"silent"}</think>\n{"action":"silent"');

    expect(normalizer.getEarlyResult("scene-1", { fallbackEvent: "same-scene" })).toBeUndefined();
  });

  it("marks the bounded response as overflowed and never finalizes it", () => {
    const normalizer = new ScreenMonitorStreamNormalizer();
    const result = normalizer.append("x".repeat(32 * 1024 + 1));

    expect(result.overflowed).toBe(true);
    expect(normalizer.finalize("scene-1")).toBeUndefined();
  });
});
