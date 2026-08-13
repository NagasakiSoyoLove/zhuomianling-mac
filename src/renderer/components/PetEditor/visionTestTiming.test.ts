import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runWithMinimumVisionTestDuration,
  VISION_CAPABILITY_TEST_MIN_DURATION_MS
} from "./visionTestTiming";

describe("vision capability test timing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["allow-list success", "tested"],
    ["deny-list result", "unsupported"]
  ])("keeps the %s test state visible for two seconds", async (_label, state) => {
    let settled = false;
    const resultPromise = runWithMinimumVisionTestDuration(async () => state)
      .then((result) => {
        settled = true;
        return result;
      });

    await vi.advanceTimersByTimeAsync(VISION_CAPABILITY_TEST_MIN_DURATION_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(resultPromise).resolves.toBe(state);
    expect(settled).toBe(true);
  });
});
