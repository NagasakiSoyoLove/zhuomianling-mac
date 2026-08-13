export const VISION_CAPABILITY_TEST_MIN_DURATION_MS = 2_000;

/**
 * Keep the configuration page's testing state visible for a meaningful amount
 * of time even when the main process can answer from the model allow/deny list.
 * Real provider probes are not delayed beyond this minimum.
 */
export async function runWithMinimumVisionTestDuration<T>(
  task: () => Promise<T | undefined> | undefined
): Promise<T | undefined> {
  const startedAt = Date.now();

  try {
    return await task();
  } finally {
    const remaining = VISION_CAPABILITY_TEST_MIN_DURATION_MS - (Date.now() - startedAt);
    if (remaining > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    }
  }
}
