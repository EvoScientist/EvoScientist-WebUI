/** Wait `ms`; false when `signal` aborts first (or already has). */
export function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => resolve(true), ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { once: true }
    );
  });
}

const FIRST_RETRY_MS = 700;

/**
 * Run `attempt` until it succeeds, backing off from 700 ms to `maxMs`
 * between failures and reporting each to `onError`; null once `signal`
 * aborts. `onError` returning false stops retrying (a final failure).
 */
export async function retryWithBackoff<T>(
  attempt: () => Promise<T>,
  signal: AbortSignal,
  maxMs: number,
  onError?: (error: unknown) => boolean | void
): Promise<T | null> {
  for (
    let delay = FIRST_RETRY_MS;
    !signal.aborted;
    delay = Math.min(delay * 2, maxMs)
  ) {
    try {
      return await attempt();
    } catch (error) {
      if (signal.aborted) break;
      if (onError?.(error) === false) break;
      if (!(await sleep(delay, signal))) break;
    }
  }
  return null;
}
