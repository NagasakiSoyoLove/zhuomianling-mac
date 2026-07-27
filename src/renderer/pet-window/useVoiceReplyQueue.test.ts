import { describe, expect, it } from "vitest";
import {
  createVoiceReplyAudioSafely,
  getVoiceAudioPayloadError,
  getVoicePlaybackErrorMessage,
  normalizeVoiceReplyText,
  shouldCompleteVoiceReply
} from "./useVoiceReplyQueue";

describe("voice reply final-text reconciliation", () => {
  it("turns malformed synthesis payload conversion into a retryable miss", () => {
    expect(
      createVoiceReplyAudioSafely(
        "invalid",
        "audio/wav",
        () => {
          throw new Error("invalid base64");
        },
        () => "unused"
      )
    ).toBeUndefined();

    expect(
      createVoiceReplyAudioSafely(
        "valid",
        "audio/wav",
        () => new Blob(),
        () => {
          throw new Error("object URL unavailable");
        }
      )
    ).toBeUndefined();
  });

  it("normalizes whitespace before comparing streamed and final text", () => {
    expect(normalizeVoiceReplyText("  第一段\n  第二段  ")).toBe("第一段 第二段");
  });

  it("distinguishes valid audio headers from invalid or mismatched payloads", () => {
    const decode = (value: string): string => value;
    expect(getVoiceAudioPayloadError("RIFF1234WAVEdata", "audio/wav", decode)).toBeUndefined();
    expect(getVoiceAudioPayloadError("<html>error</html>", "audio/wav", decode)).toContain(
      "不是有效"
    );
    expect(getVoiceAudioPayloadError("ID3audio", "audio/wav", decode)).toContain("不一致");
    expect(getVoiceAudioPayloadError("RIFF1234WAVEdata", "application/octet-stream", decode))
      .toBeUndefined();
    expect(getVoiceAudioPayloadError("", "audio/wav", decode)).toContain("没有返回");
  });

  it("provides specific browser playback failure messages", () => {
    expect(getVoicePlaybackErrorMessage(3)).toContain("无法解码");
    expect(getVoicePlaybackErrorMessage(4)).toContain("不支持");
    expect(getVoicePlaybackErrorMessage()).toContain("未能启动");
  });

  it("does not report playback drained before the AI reply is finalized", () => {
    expect(
      shouldCompleteVoiceReply({
        currentRequest: true,
        finalized: false,
        notified: false,
        playing: false,
        queuedItems: 0
      })
    ).toBe(false);
    expect(
      shouldCompleteVoiceReply({
        currentRequest: true,
        finalized: true,
        notified: false,
        playing: false,
        queuedItems: 0
      })
    ).toBe(true);
  });

  it("only reports completion once and never while audio remains", () => {
    expect(
      shouldCompleteVoiceReply({
        currentRequest: true,
        finalized: true,
        notified: false,
        playing: true,
        queuedItems: 0
      })
    ).toBe(false);
    expect(
      shouldCompleteVoiceReply({
        currentRequest: true,
        finalized: true,
        notified: true,
        playing: false,
        queuedItems: 0
      })
    ).toBe(false);
  });
});
