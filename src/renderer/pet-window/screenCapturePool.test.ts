// TIMED DIAGNOSTICS TEST MODULE: shared capture pool tests.
import { describe, expect, it, vi } from "vitest";
import { SharedCapturePool } from "./screenCapturePool";

describe("SharedCapturePool", () => {
  it("reuses one resource and disposes it after the last lease", async () => {
    const resource = { id: "screen:1" };
    const create = vi.fn(async () => resource);
    const dispose = vi.fn();
    const pool = new SharedCapturePool(dispose);

    const first = await pool.acquire("screen:1", create);
    const second = await pool.acquire("screen:1", create);

    expect(create).toHaveBeenCalledTimes(1);
    expect(first.resource).toBe(resource);
    expect(second.resource).toBe(resource);
    expect(pool.getReferenceCount("screen:1")).toBe(2);

    first.release();
    expect(dispose).not.toHaveBeenCalled();
    expect(pool.getReferenceCount("screen:1")).toBe(1);

    second.release();
    second.release();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(pool.getReferenceCount("screen:1")).toBe(0);
  });

  it("coalesces concurrent creation for the same source", async () => {
    const resource = { id: "screen:1" };
    let resolveCreate: ((value: typeof resource) => void) | undefined;
    const create = vi.fn(() => new Promise<typeof resource>((resolve) => {
      resolveCreate = resolve;
    }));
    const pool = new SharedCapturePool(vi.fn());

    const firstPromise = pool.acquire("screen:1", create);
    const secondPromise = pool.acquire("screen:1", create);
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1);

    resolveCreate?.(resource);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.resource).toBe(second.resource);
    expect(pool.getReferenceCount("screen:1")).toBe(2);
  });

  it("keeps different sources independent", async () => {
    const dispose = vi.fn();
    const pool = new SharedCapturePool(dispose);
    const screen = await pool.acquire("screen:1", async () => ({ id: "screen:1" }));
    const otherScreen = await pool.acquire("screen:2", async () => ({ id: "screen:2" }));

    expect(screen.resource).not.toBe(otherScreen.resource);
    screen.release();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(pool.getReferenceCount("screen:2")).toBe(1);
    otherScreen.release();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("invalidates an ended resource without waiting for stale leases", async () => {
    const resource = { id: "screen:1" };
    const dispose = vi.fn();
    const pool = new SharedCapturePool(dispose);
    const lease = await pool.acquire("screen:1", async () => resource);

    expect(pool.invalidate("screen:1", resource)).toBe(true);
    expect(pool.invalidate("screen:1", resource)).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    lease.release();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
