// TIMED DIAGNOSTICS TEST MODULE: automatic monitor decision and timeout tests.
import { describe, expect, it } from "vitest";
import { ScreenMonitorService, isScreenMonitorReplySimilar } from "./ScreenMonitorService";

function candidate(sceneKey: string, event: "app-switch" | "page-change" | "content-change" | "same-scene" = "app-switch") {
  return {
    sceneKey,
    event,
    changeRatio: 0.8,
    stableForMs: 2_000
  } as const;
}

type MonitorAnalyze = Parameters<ScreenMonitorService["processCandidate"]>[2];

async function processAndPlay(
  service: ScreenMonitorService,
  sessionId: string,
  nextCandidate: ReturnType<typeof candidate>,
  analyze: MonitorAnalyze,
  options?: { initialObservation?: boolean }
) {
  const result = await service.processCandidate(sessionId, nextCandidate, analyze, options);
  if (result.replyId) {
    service.updateReplyDelivery(sessionId, result.replyId, "accepted");
    service.updateReplyDelivery(sessionId, result.replyId, "played");
  }
  return result;
}

describe("ScreenMonitorService", () => {
  it("limits the same scene and enforces the minimum analysis interval", async () => {
    let now = 0;
    const analyze = async () => ({
      action: "speak" as const,
      event: "app-switch" as const,
      sceneKey: "ignored",
      reply: "我看到你切换了窗口。",
      voiceText: "I saw you switch windows.",
      emotion: "focus"
    });
    const service = new ScreenMonitorService({ now: () => now, minimumAnalysisIntervalMs: 1_000, sameSceneCooldownMs: 5_000 });
    service.start("session-a", "companion");

    const first = await processAndPlay(service, "session-a", candidate("scene-a"), analyze);
    expect(first).toMatchObject({
      action: "speak",
      state: "watching",
      voiceText: "I saw you switch windows.",
      emotion: "focus",
      diagnostic: {
        stage: "model",
        reason: "model-replied",
        event: "app-switch",
        changeRatio: 0.8,
        stableForMs: 2_000
      }
    });

    now = 500;
    const differentDuringInterval = await service.processCandidate("session-a", candidate("scene-b"), analyze);
    expect(differentDuringInterval).toMatchObject({
      state: "silent",
      diagnostic: { stage: "gate", reason: "analysis-cooldown", event: "app-switch" }
    });

    now = 1_001;
    const sameScene = await service.processCandidate("session-a", candidate("scene-a"), analyze);
    expect(sameScene).toMatchObject({
      sceneKey: "scene-a",
      diagnostic: { stage: "gate", reason: "same-scene-cooldown", event: "app-switch" }
    });
  });

  it("suppresses similar replies and caps automatic replies per window", async () => {
    let now = 0;
    let calls = 0;
    const service = new ScreenMonitorService({
      now: () => now,
      minimumAnalysisIntervalMs: 10,
      sameSceneCooldownMs: 0,
      maxRepliesPerWindow: 3,
      replyWindowMs: 10_000
    });
    service.start("session-b", "companion");

    const speak = async () => {
      calls += 1;
      return {
        action: "speak" as const,
        event: "content-change" as const,
        sceneKey: "model-scene",
        reply: calls === 1 ? "这页已经准备好了。" : `新的提醒 ${calls}`
      };
    };

    expect((await processAndPlay(service, "session-b", candidate("scene-1", "content-change"), speak)).action).toBe("speak");
    now = 20;
    expect((await service.processCandidate("session-b", candidate("scene-2", "content-change"), async () => ({
      action: "speak" as const,
      event: "content-change" as const,
      sceneKey: "model-scene",
      reply: "这页已经准备好了。"
    }))).action).toBe("silent");

    now = 40;
    expect((await processAndPlay(service, "session-b", candidate("scene-3"), speak)).action).toBe("speak");
    now = 60;
    expect((await processAndPlay(service, "session-b", candidate("scene-4"), speak)).action).toBe("speak");
    now = 80;
    const capped = await service.processCandidate("session-b", candidate("scene-5"), speak);
    expect(capped).toMatchObject({
      state: "silent",
      diagnostic: { stage: "gate", reason: "reply-budget", event: "app-switch" }
    });
    expect(capped.action).toBeUndefined();
    expect(calls).toBe(3);
  });

  it("lets the model decide content changes and observes the first frame in both modes", async () => {
    let calls = 0;
    const service = new ScreenMonitorService({ minimumAnalysisIntervalMs: 0, sameSceneCooldownMs: 0 });
    service.start("quiet", "quiet");
    const analyze = async () => {
      calls += 1;
      return { action: "speak" as const, event: "content-change" as const, sceneKey: "x", reply: "有一点变化。" };
    };

    const quietInitial = await processAndPlay(
      service,
      "quiet",
      candidate("quiet-initial", "same-scene"),
      analyze,
      { initialObservation: true }
    );
    expect(quietInitial.action).toBe("speak");
    expect(calls).toBe(1);

    const quiet = await processAndPlay(service, "quiet", candidate("quiet-scene", "content-change"), analyze);
    expect(quiet.action).toBe("speak");
    expect(calls).toBe(2);

    service.start("companion", "companion");
    const companionInitial = await processAndPlay(
      service,
      "companion",
      candidate("scene-initial", "same-scene"),
      analyze,
      { initialObservation: true }
    );
    expect(companionInitial.action).toBe("speak");
    expect(calls).toBe(3);

    const companion = await processAndPlay(service, "companion", candidate("companion-scene", "content-change"), analyze);
    expect(companion.action).toBe("speak");
    expect(calls).toBe(4);
  });

  it("keeps an explicit silent decision silent during the initial observation", async () => {
    const service = new ScreenMonitorService({ minimumAnalysisIntervalMs: 0, sameSceneCooldownMs: 0 });
    service.start("initial-silent", "quiet");

    const result = await service.processCandidate(
      "initial-silent",
      candidate("scene-initial", "same-scene"),
      async () => ({
        action: "silent" as const,
        event: "same-scene" as const,
        sceneKey: "scene-initial",
        reply: ""
      }),
      { initialObservation: true }
    );

    expect(result).toMatchObject({ action: "silent", state: "silent" });
    expect(result.reply).toBeUndefined();
    expect(result.presentationKind).toBeUndefined();
  });

  it("does not let the first observation consume the normal reply budget", async () => {
    let calls = 0;
    const service = new ScreenMonitorService({
      now: () => 0,
      minimumAnalysisIntervalMs: 10_000,
      sameSceneCooldownMs: 10_000,
      maxRepliesPerWindow: 1
    });
    service.start("initial-budget", "companion");
    const analyze = async () => {
      calls += 1;
      return { action: "speak" as const, event: "same-scene" as const, sceneKey: "ignored", reply: `观察 ${calls}` };
    };

    const initial = await processAndPlay(
      service,
      "initial-budget",
      candidate("scene-initial", "same-scene"),
      analyze,
      { initialObservation: true }
    );
    const next = await processAndPlay(service, "initial-budget", candidate("scene-next", "page-change"), analyze);

    expect(initial.action).toBe("speak");
    expect(next.action).toBe("speak");
    expect(calls).toBe(2);
  });

  it("does not cap companion replies in five minutes and uses a 30 second scene cooldown", async () => {
    let now = 0;
    let calls = 0;
    const service = new ScreenMonitorService({ now: () => now, minimumAnalysisIntervalMs: 0 });
    service.start("companion-unlimited", "companion");

    const analyze = async () => {
      calls += 1;
      return {
        action: "speak" as const,
        event: "content-change" as const,
        sceneKey: `model-scene-${calls}`,
        reply: `提醒 ${calls}`
      };
    };

    const first = await processAndPlay(service, "companion-unlimited", candidate("same-scene", "content-change"), analyze);
    expect(first.action).toBe("speak");

    now = 29_999;
    const cooling = await service.processCandidate("companion-unlimited", candidate("same-scene", "content-change"), analyze);
    expect(cooling).toMatchObject({
      state: "silent",
      diagnostic: { stage: "gate", reason: "same-scene-cooldown" }
    });

    now = 30_000;
    expect((await processAndPlay(service, "companion-unlimited", candidate("same-scene", "content-change"), analyze)).action).toBe("speak");

    for (let index = 0; index < 6; index += 1) {
      now += 1_000;
      expect((await processAndPlay(
        service,
        "companion-unlimited",
        candidate(`scene-${index}`, "content-change"),
        analyze
      )).action).toBe("speak");
    }

    expect(calls).toBe(8);
  });

  it("discards a late analysis result after the session is stopped", async () => {
    let resolveAnalysis!: (value: { action: "speak"; event: "app-switch"; sceneKey: string; reply: string }) => void;
    const analysis = new Promise<{ action: "speak"; event: "app-switch"; sceneKey: string; reply: string }>((resolve) => {
      resolveAnalysis = resolve;
    });
    const service = new ScreenMonitorService({ minimumAnalysisIntervalMs: 0 });
    service.start("session-c", "companion");

    const pending = service.processCandidate("session-c", candidate("scene-c"), () => analysis);
    service.stop("session-c");
    resolveAnalysis({ action: "speak", event: "app-switch", sceneKey: "scene-c", reply: "迟到的回复" });

    await expect(pending).resolves.toMatchObject({ ok: false, state: "error" });
  });

  it("reports a provider failure without exposing model output", async () => {
    const service = new ScreenMonitorService({ minimumAnalysisIntervalMs: 0 });
    service.start("provider-error", "quiet");

    const failed = await service.processCandidate("provider-error", candidate("scene-error"), async () => {
      throw new Error("provider detail must not leave the service");
    });

    expect(failed).toMatchObject({
      ok: false,
      state: "error",
      diagnostic: {
        stage: "model",
        reason: "provider-error",
        event: "app-switch",
        changeRatio: 0.8,
        stableForMs: 2_000
      }
    });
    expect(JSON.stringify(failed)).not.toContain("provider detail");
  });

  it("keeps consecutive timeouts out of reply budget and only shows a network notice on the third", async () => {
    let now = 0;
    let calls = 0;
    const service = new ScreenMonitorService({
      now: () => now,
      minimumAnalysisIntervalMs: 0,
      sameSceneCooldownMs: 0,
      maxRepliesPerWindow: 1
    });
    service.start("timeout-streak", "quiet");

    const timeout = async () => ({
      action: "speak" as const,
      event: "page-change" as const,
      sceneKey: `timeout-scene-${++calls}`,
      reply: "我刚开始观察，但暂时没看清当前画面。",
      presentationKind: "fallback" as const,
      analysisFailure: "timeout" as const
    });

    const initial = await service.processCandidate(
      "timeout-streak",
      candidate("timeout-scene-initial", "same-scene"),
      timeout,
      { initialObservation: true }
    );
    expect(initial).toMatchObject({
      action: "speak",
      reply: "我刚开始观察，但暂时没看清当前画面。",
      presentationKind: "fallback",
      diagnostic: { reason: "provider-timeout" }
    });

    now = 1;
    const second = await service.processCandidate("timeout-streak", candidate("timeout-scene-2", "page-change"), timeout);
    expect(second).toMatchObject({ action: "silent", state: "silent", diagnostic: { reason: "provider-timeout" } });
    expect(second.reply).toBeUndefined();

    now = 2;
    const third = await service.processCandidate("timeout-streak", candidate("timeout-scene-3", "page-change"), timeout);
    expect(third).toMatchObject({
      action: "speak",
      reply: "视觉检测连续超时，请检查网络连接。",
      presentationKind: "fallback",
      diagnostic: { reason: "provider-timeout" }
    });

    now = 3;
    const fourth = await service.processCandidate("timeout-streak", candidate("timeout-scene-4", "page-change"), timeout);
    expect(fourth).toMatchObject({ action: "silent", state: "silent", diagnostic: { reason: "provider-timeout" } });
    expect(fourth.reply).toBeUndefined();

    now = 4;
    const successful = await service.processCandidate(
      "timeout-streak",
      candidate("timeout-scene-success", "content-change"),
      async () => ({
        action: "speak" as const,
        event: "content-change" as const,
        sceneKey: "timeout-scene-success",
        reply: "这次看清了。"
      })
    );
    expect(successful.action).toBe("speak");
  });

  it("does not commit cooldown, duplicate history, or budget until the reply is played", async () => {
    let now = 0;
    let calls = 0;
    const service = new ScreenMonitorService({
      now: () => now,
      minimumAnalysisIntervalMs: 0,
      sameSceneCooldownMs: 10_000,
      maxRepliesPerWindow: 1
    });
    service.start("delivery-state", "quiet");
    const analyze = async () => ({
      action: "speak" as const,
      event: "content-change" as const,
      sceneKey: "model-scene",
      reply: `提醒 ${++calls}`
    });

    const analyzed = await service.processCandidate("delivery-state", candidate("scene-a", "content-change"), analyze);
    expect(analyzed.replyId).toBeTruthy();
    expect(
      (await service.processCandidate("delivery-state", candidate("scene-a", "content-change"), analyze)).diagnostic
    ).toMatchObject({ stage: "gate", reason: "reply-pending" });

    service.updateReplyDelivery("delivery-state", analyzed.replyId!, "accepted");
    service.updateReplyDelivery("delivery-state", analyzed.replyId!, "dropped");
    const retried = await service.processCandidate("delivery-state", candidate("scene-a", "content-change"), analyze);
    expect(retried.action).toBe("speak");

    service.updateReplyDelivery("delivery-state", retried.replyId!, "accepted");
    service.updateReplyDelivery("delivery-state", retried.replyId!, "played");
    now = 1;
    const capped = await service.processCandidate("delivery-state", candidate("scene-b", "content-change"), analyze);
    expect(capped).toMatchObject({
      state: "silent",
      diagnostic: { stage: "gate", reason: "reply-budget" }
    });
  });

  it("only suppresses normalized exact duplicates, not merely overlapping replies", () => {
    expect(isScreenMonitorReplySimilar("  已经准备好了！ ", "已经准备好了")).toBe(true);
    expect(isScreenMonitorReplySimilar("我看到了变化", "我看到了页面变化")).toBe(false);
    expect(isScreenMonitorReplySimilar("打开了编辑器", "现在是天气预报")).toBe(false);
  });
});
