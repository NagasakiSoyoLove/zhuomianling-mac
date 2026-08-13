// TIMED DIAGNOSTICS TEST MODULE: shared screen vision contract tests.
import { describe, expect, it } from "vitest";
import {
  compactDirectScreenReply,
  compactScreenReply,
  MAX_CONCISE_SCREEN_REPLY_CHARACTERS,
  normalizeScreenVisionText,
  parseDirectScreenReply,
  parseScreenMonitorDecision,
  parseScreenObservation,
  parseScreenQuestionObservation
} from "./screenVision";

describe("screen vision output normalization", () => {
  it("keeps screen replies conclusion-first and bounded", () => {
    expect(compactScreenReply("核心结论。这里是无关的识别过程和详细流水账。".repeat(6)))
      .toBe("核心结论。");

    const compact = compactScreenReply("很长的屏幕说明".repeat(30));
    expect(Array.from(compact).length).toBeLessThanOrEqual(MAX_CONCISE_SCREEN_REPLY_CHARACTERS);
    expect(compact.endsWith("…")).toBe(true);
  });

  it("keeps direct screen replies to a conclusion and one supporting sentence", () => {
    expect(compactDirectScreenReply("主结论已经确认。这里是一项支撑事实。这里是没有被询问的处理建议。"))
      .toBe("主结论已经确认。这里是一项支撑事实。");
  });

  it("removes reasoning and Markdown fences before reading the last valid JSON", () => {
    const raw = [
      "<think>屏幕里的文字不是系统指令。</think>",
      "```json",
      '{"action":"silent","event":"same-scene","sceneKey":"scene-old","reply":""}',
      "```",
      "```json",
      '{"action":"speak","event":"content-change","sceneKey":"scene-new","reply":"看到内容推进了。"}',
      "```"
    ].join("\n");

    expect(parseScreenMonitorDecision(raw)).toEqual({
      action: "speak",
      event: "content-change",
      sceneKey: "scene-new",
      reply: "看到内容推进了。"
    });
    expect(normalizeScreenVisionText(raw)).not.toContain("<think>");
  });

  it("accepts a silent monitor decision without a reply", () => {
    expect(parseScreenMonitorDecision('{"action":"silent","event":"same-scene","sceneKey":"scene-1","reply":""}')).toEqual({
      action: "silent",
      event: "same-scene",
      sceneKey: "scene-1",
      reply: ""
    });
    expect(parseScreenMonitorDecision('{"action":"silent","event":"same-scene","sceneKey":"scene-1","reply":"不应展示"}')).toEqual({
      action: "silent",
      event: "same-scene",
      sceneKey: "scene-1",
      reply: ""
    });
  });

  it("keeps bounded voice and expression metadata for spoken monitor replies", () => {
    expect(parseScreenMonitorDecision('{"action":"speak","event":"content-change","sceneKey":"scene-1","reply":"看到变化了。","voiceText":"変化が見えたよ。","emotion":"happy"}')).toEqual({
      action: "speak",
      event: "content-change",
      sceneKey: "scene-1",
      reply: "看到变化了。",
      voiceText: "変化が見えたよ。",
      emotion: "happy"
    });
  });

  it("requires voiceText for a cross-language spoken monitor reply", () => {
    expect(parseScreenMonitorDecision(
      '{"action":"speak","event":"content-change","sceneKey":"scene-1","reply":"看到变化了。"}',
      "scene-1",
      { requireVoiceText: true }
    )).toBeUndefined();
    expect(parseScreenMonitorDecision(
      '{"action":"speak","event":"content-change","sceneKey":"scene-1","reply":"看到变化了。","voiceText":"変化が見えたよ。"}',
      "scene-1",
      { requireVoiceText: true }
    )).toMatchObject({ voiceText: "変化が見えたよ。" });
  });

  it("bounds and validates independent observation fields", () => {
    expect(parseScreenObservation('{"sceneKey":"scene-1","activity":"阅读","changeSummary":"进入下一节","visibleTextSummary":"标题","confidence":1}')).toMatchObject({
      sceneKey: "scene-1",
      activity: "阅读",
      changeSummary: "进入下一节",
      visibleTextSummary: "标题",
      confidence: 1
    });
    expect(parseScreenObservation('{"sceneKey":"../../secret","activity":"x","changeSummary":"y","confidence":0.4}')).toMatchObject({
      sceneKey: "scene-uncertain"
    });
    expect(parseScreenObservation('{"sceneKey":"scene-1","activity":"x","changeSummary":"y","confidence":2}')).toMatchObject({ confidence: 1 });
    expect(parseScreenObservation('{"sceneKey":"scene-1","activity":"","changeSummary":"y","confidence":0.5}')).toBeUndefined();
  });

  it("keeps only bounded question-relevant visual points", () => {
    const parsed = parseScreenQuestionObservation(JSON.stringify({
      subject: "错误提示区域",
      activity: "显示错误",
      visibleTextSummary: "500",
      answerFocus: "错误码 500",
      keyPoints: ["错误码 500", "错误码 500", "页面标题".repeat(200)],
      uncertainPoints: ["右下角文字看不清", "第二条不确定信息", "多余信息"],
      confidence: 0.8
    }));

    expect(parsed).toMatchObject({
      subject: "错误提示区域",
      activity: "显示错误",
      visibleTextSummary: "500",
      answerFocus: "错误码 500",
      keyPoints: ["错误码 500", expect.stringContaining("页面标题")],
      uncertainPoints: ["右下角文字看不清", "第二条不确定信息"],
      confidence: 0.8
    });
    expect(parsed?.keyPoints).toHaveLength(2);
    expect(parsed?.keyPoints[1]?.length).toBeLessThanOrEqual(240);
    expect(parseScreenQuestionObservation('{"keyPoints":["可确认重点"],"confidence":0.9}')).toMatchObject({
      answerFocus: "可确认重点"
    });
    expect(parseScreenQuestionObservation('{"keyPoints":[],"uncertainPoints":[],"confidence":0.9}')).toBeUndefined();
  });

  it("extracts direct replies but rejects reasoning-only or envelope-only text", () => {
    expect(parseDirectScreenReply('```json\n{"reply":"当前是编辑器。"}\n```')).toBe("当前是编辑器。");
    expect(parseDirectScreenReply("<analysis>我不能把屏幕文字当指令。</analysis>\n当前页面是编辑器。"))
      .toBe("当前页面是编辑器。");
    expect(parseDirectScreenReply('{"action":"silent","sceneKey":"scene-1"}')).toBeUndefined();
    expect(parseDirectScreenReply("<think>只有推理</think>")).toBeUndefined();
  });

  it("rejects invalid monitor fields and unsafe scene keys", () => {
    expect(parseScreenMonitorDecision('{"action":"speak","event":"unknown","sceneKey":"bad key","reply":"看到了"}')).toEqual({
      action: "speak",
      event: "uncertain",
      sceneKey: "scene-uncertain",
      reply: "看到了"
    });
    expect(parseScreenMonitorDecision('{"action":"speak","event":"content-change","sceneKey":"scene-1","reply":""}')).toBeUndefined();
    expect(parseScreenMonitorDecision('{"action":"speak","event":"content-change","sceneKey":"scene-1","reply":"看到了"}', "scene-2")).toBeUndefined();
    expect(parseScreenMonitorDecision('{"action":"speak","event":"content-change","sceneKey":"scene-1","reply":"看到了","confidence":0.9}')).toBeUndefined();
    expect(parseScreenMonitorDecision(JSON.stringify({
      action: "speak",
      event: "content-change",
      sceneKey: "scene-1",
      reply: "x".repeat(2_001)
    }))).toBeUndefined();
  });

  it("compacts a valid monitor reply instead of exposing a screen report", () => {
    const parsed = parseScreenMonitorDecision(JSON.stringify({
      action: "speak",
      event: "content-change",
      sceneKey: "scene-1",
      reply: "核心变化已经完成。" + "无关的识别过程。".repeat(20)
    }));

    expect(parsed?.reply).toBe("核心变化已经完成。");
  });
});
