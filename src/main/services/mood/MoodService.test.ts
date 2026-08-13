import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let root = "";
vi.mock("electron", () => ({ app: { getPath: () => root } }));

async function writeMoodState(petId: string, baseValue: number, baseChangedAt: number): Promise<void> {
  const statePath = path.join(root, "pets", petId, "mood", "state.json");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    baseValue,
    baseChangedAt
  }));
}

describe("MoodService", () => {
  beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "zhuomianling-mood-")); });
  afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("persists isolated event mutations and cooldowns", async () => {
    const { MoodService } = await import("./MoodService");
    const service = new MoodService(); const now = 1_800_000_000_000;
    expect((await service.getDisplayState("pet-a", now)).value).toBe(0);
    expect((await service.applySystemEvent("pet-a", "click", now)).state.value).toBe(2);
    expect((await service.applySystemEvent("pet-a", "click", now + 1_000)).changed).toBe(false);
    expect((await service.getDisplayState("pet-b", now)).value).toBe(0);
  });

  it("applies AI deltas once and clamps each round", async () => {
    const { MoodService } = await import("./MoodService");
    const service = new MoodService(); const now = 1_800_100_000_000;
    expect((await service.applyAiDelta("pet-c", "request-1", 99, now)).state.value).toBe(12);
    expect((await service.applyAiDelta("pet-c", "request-1", 12, now)).changed).toBe(false);
    expect((await service.applyAiDelta("pet-c", "request-2", -12, now)).state.value).toBe(0);
  });

  it("freezes decay during a session and resumes without charging paused time", async () => {
    const { MoodService } = await import("./MoodService");
    const service = new MoodService();
    const baseAt = 1_800_500_000_000;
    const pauseAt = baseAt + 15 * 60_000;
    const resumedAt = pauseAt + 30 * 60_000;
    await writeMoodState("pet-decay-pause-freeze", 10, baseAt);

    service.pauseDecay("pet-decay-pause-freeze", "monitor-session-1", pauseAt);
    expect((await service.getDisplayState("pet-decay-pause-freeze", resumedAt)).value).toBe(9);

    await service.resumeDecay("pet-decay-pause-freeze", "monitor-session-1", resumedAt);
    expect((await service.getDisplayState("pet-decay-pause-freeze", resumedAt)).value).toBe(9);
    expect((await service.getDisplayState("pet-decay-pause-freeze", resumedAt + 5 * 60_000)).value).toBe(8);

    const persisted = JSON.parse(
      await fs.readFile(path.join(root, "pets", "pet-decay-pause-freeze", "mood", "state.json"), "utf8")
    ) as { baseChangedAt: number };
    expect(persisted.baseChangedAt).toBe(baseAt + 30 * 60_000);
  });

  it("keeps decay paused until the final session lease is released", async () => {
    const { MoodService } = await import("./MoodService");
    const service = new MoodService();
    const baseAt = 1_800_600_000_000;
    const pauseAt = baseAt + 15 * 60_000;
    const firstReleaseAt = pauseAt + 30 * 60_000;
    const finalReleaseAt = firstReleaseAt + 30 * 60_000;
    await writeMoodState("pet-decay-pause-leases", 10, baseAt);

    service.pauseDecay("pet-decay-pause-leases", "monitor-session-1", pauseAt);
    service.pauseDecay("pet-decay-pause-leases", "monitor-session-2", pauseAt + 1_000);
    await service.resumeDecay("pet-decay-pause-leases", "monitor-session-1", firstReleaseAt);
    expect((await service.getDisplayState("pet-decay-pause-leases", finalReleaseAt)).value).toBe(9);

    await service.resumeDecay("pet-decay-pause-leases", "monitor-session-2", finalReleaseAt);
    expect((await service.getDisplayState("pet-decay-pause-leases", finalReleaseAt)).value).toBe(9);
  });

  it("keeps ordinary mood mutations effective while decay is paused", async () => {
    const { MoodService } = await import("./MoodService");
    const service = new MoodService();
    const baseAt = 1_800_700_000_000;
    const pauseAt = baseAt + 15 * 60_000;
    const resumedAt = pauseAt + 30 * 60_000;
    await writeMoodState("pet-decay-pause-mutation", 10, baseAt);

    service.pauseDecay("pet-decay-pause-mutation", "monitor-session-1", pauseAt);
    expect((await service.applySystemEvent("pet-decay-pause-mutation", "click", pauseAt + 1_000)).state.value).toBe(11);
    await service.resumeDecay("pet-decay-pause-mutation", "monitor-session-1", resumedAt);

    expect((await service.getDisplayState("pet-decay-pause-mutation", resumedAt)).value).toBe(11);
    expect((await service.getDisplayState("pet-decay-pause-mutation", resumedAt + 10 * 60_000)).value).toBe(11);
    expect((await service.getDisplayState("pet-decay-pause-mutation", resumedAt + 15 * 60_000)).value).toBe(10);
  });

  it("does not silently replace corrupt state", async () => {
    const { MoodService } = await import("./MoodService");
    await fs.mkdir(path.join(root,"pets","pet-d","mood"), { recursive: true });
    await fs.writeFile(path.join(root,"pets","pet-d","mood","state.json"), "{broken");
    await expect(new MoodService().getDisplayState("pet-d")).rejects.toThrow("MOOD_STATE_CORRUPTED");
  });

  it("normalizes the legacy drag cooldown without writing during a read", async () => {
    const { MoodService } = await import("./MoodService");
    const statePath = path.join(root, "pets", "pet-legacy", "mood", "state.json");
    const now = 1_800_200_000_000;
    const legacyState = JSON.stringify({
      schemaVersion: 1,
      baseValue: 10,
      baseChangedAt: now,
      eventCooldowns: { drag: now + 1_000 }
    });
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, legacyState);

    expect((await new MoodService().getDisplayState("pet-legacy", now)).value).toBe(10);
    expect(await fs.readFile(statePath, "utf8")).toBe(legacyState);
  });

  it("persists a normalized legacy cooldown on the next mutation", async () => {
    const { MoodService } = await import("./MoodService");
    const statePath = path.join(root, "pets", "pet-legacy-write", "mood", "state.json");
    const now = 1_800_300_000_000;
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({
      schemaVersion: 1,
      baseValue: 10,
      baseChangedAt: now,
      eventCooldowns: { drag: now + 1_000 }
    }));

    expect((await new MoodService().applySystemEvent("pet-legacy-write", "click", now)).changed).toBe(true);
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8")) as { eventCooldowns: Record<string, number> };
    expect(persisted.eventCooldowns.drag).toBeUndefined();
    expect(persisted.eventCooldowns.dragCompleted).toBe(now + 1_000);
  });

  it("still rejects unknown cooldown keys", async () => {
    const { MoodService } = await import("./MoodService");
    const statePath = path.join(root, "pets", "pet-unknown-event", "mood", "state.json");
    const now = 1_800_400_000_000;
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({
      schemaVersion: 1,
      baseValue: 0,
      baseChangedAt: now,
      eventCooldowns: { unknownEvent: now }
    }));

    await expect(new MoodService().getDisplayState("pet-unknown-event", now)).rejects.toThrow("MOOD_STATE_CORRUPTED");
  });
});
