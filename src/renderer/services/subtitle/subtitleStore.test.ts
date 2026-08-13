// TIMED DIAGNOSTICS TEST MODULE: automatic-event subtitle presentation coverage.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSubtitleStore } from "./subtitleStore";

const globalScope = globalThis as unknown as { window?: Window & typeof globalThis };
const originalWindow = globalScope.window;

beforeEach(() => {
  globalScope.window = globalThis as unknown as Window & typeof globalThis;
});

afterEach(() => {
  if (originalWindow) {
    globalScope.window = originalWindow;
  } else {
    delete globalScope.window;
  }
});

describe("subtitle presentation priority", () => {
  it("keeps ambient events from replacing an active conversation bubble", () => {
    const store = createSubtitleStore();

    expect(
      store.show({
        text: "这是聊天回复。",
        mode: "instant",
        holdMs: Number.POSITIVE_INFINITY,
        kind: "conversation"
      })
    ).toBe(true);

    expect(
      store.show({
        text: "我还在这里。",
        mode: "instant",
        holdMs: Number.POSITIVE_INFINITY
      })
    ).toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      visible: true,
      text: "这是聊天回复。",
      kind: "conversation"
    });
  });

  it("allows a new conversation or an explicit system notice to replace it", () => {
    const store = createSubtitleStore();

    store.show({
      text: "旧回复。",
      mode: "instant",
      holdMs: Number.POSITIVE_INFINITY,
      kind: "conversation"
    });
    expect(
      store.show({
        text: "新的视觉回复。",
        mode: "instant",
        holdMs: Number.POSITIVE_INFINITY,
        kind: "conversation"
      })
    ).toBe(true);
    expect(store.getSnapshot().text).toBe("新的视觉回复。");

    expect(
      store.show({
        text: "回复生成失败。",
        mode: "instant",
        holdMs: Number.POSITIVE_INFINITY,
        kind: "system"
      })
    ).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ text: "回复生成失败。", kind: "system" });
  });

  it("keeps the conversation protection through streaming progress", () => {
    const store = createSubtitleStore();

    store.showTypewriterProgress({
      text: "正在显示",
      fullText: "正在显示的回复。",
      kind: "conversation"
    });
    expect(store.isConversationBubbleActive()).toBe(true);
    expect(store.show({ text: "长时间无操作。", mode: "instant" })).toBe(false);

    store.finishTypewriterProgress(Number.POSITIVE_INFINITY);
    expect(store.isConversationBubbleActive()).toBe(true);
  });

  it("accepts an event after the protected conversation bubble has finished", () => {
    const store = createSubtitleStore();

    store.show({
      text: "聊天回复。",
      mode: "instant",
      holdMs: Number.POSITIVE_INFINITY,
      kind: "conversation"
    });
    expect(store.show({ text: "心情进入提示。", mode: "instant" })).toBe(false);

    store.hide();

    expect(store.show({ text: "心情进入提示。", mode: "instant" })).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      visible: true,
      text: "心情进入提示。",
      kind: "event"
    });
  });

  it("treats a fallback bubble as an active reply without treating it as a normal reply", () => {
    const store = createSubtitleStore();

    store.show({
      text: "这次没看清。",
      mode: "instant",
      holdMs: Number.POSITIVE_INFINITY,
      kind: "fallback"
    });

    expect(store.isConversationBubbleActive()).toBe(true);
    expect(store.show({ text: "环境提示。", mode: "instant" })).toBe(false);
    expect(store.show({
      text: "新的正常回复。",
      mode: "instant",
      holdMs: Number.POSITIVE_INFINITY,
      kind: "conversation"
    })).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      text: "新的正常回复。",
      kind: "conversation"
    });
  });
});
