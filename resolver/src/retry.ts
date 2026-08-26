export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterFactor?: number;
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

const DEFAULTS: Required<Omit<RetryOptions, 'logger'>> & { onRetry: NonNullable<RetryOptions['onRetry']> } = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterFactor: 0.2,
  onRetry: () => {},
};

/**
 * Normalize raw RetryOptions into a validated, fully-resolved set of options.
 *
 * Invariants enforced here:
 *  - `maxAttempts` must be at least 1. Zero is ambiguous (does it mean "run
 *    once with no retries" or "never run"?), so we treat it the same as 1 —
 *    one attempt, no retries. This matches the principle of least surprise
 *    for callers who pass 0 thinking they want a single attempt.
 *  - `baseDelayMs` must be ≥ 0. A negative base delay would produce a
 *    negative timeout argument passed to setTimeout, which Node.js converts
 *    to 0 — creating an unintended busy-retry loop during an outage that
 *    obscures the original failure and hammers downstream RPC endpoints.
 *  - `jitterFactor` must be ≥ 0. A negative jitter value inverts the sign
 *    of the jitter term, which can also produce a negative (or zero) delay
 *    for the same reason.
 */
export function normalizeRetryOptions(
  opts: RetryOptions
): Required<Omit<RetryOptions, 'logger'>> & { onRetry: NonNullable<RetryOptions['onRetry']> } {
  const merged = { ...DEFAULTS, ...opts };

  if (merged.maxAttempts < 1) {
    merged.maxAttempts = 1;
  }

  if (merged.baseDelayMs < 0) {
    throw new RangeError(
      `RetryOptions.baseDelayMs must be ≥ 0 (got ${merged.baseDelayMs})`
    );
  }

  if (merged.jitterFactor < 0) {
    throw new RangeError(
      `RetryOptions.jitterFactor must be ≥ 0 (got ${merged.jitterFactor})`
    );
  }

  return merged;
}

export class TransientError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "TransientError";
  }
}

export function calculateBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterFactor: number
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  const jitter = jitterFactor * exponential * (Math.random() - 0.5);
  return Math.max(0, Math.round(exponential + jitter));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, jitterFactor, onRetry } =
    normalizeRetryOptions(opts);

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const delay = calculateBackoff(attempt, baseDelayMs, maxDelayMs, jitterFactor);
      onRetry(attempt + 1, delay, lastError);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError!;
}

export async function retryRpcCall<T>(
  fn: () => Promise<T>,
  opts?: Partial<RetryOptions>
): Promise<T> {
  const { logger, ...rest } = opts ?? {};
  return withRetry(fn, {
    maxAttempts: 5,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    jitterFactor: 0.2,
    onRetry: (attempt, delayMs, error) => {
      logger?.warn(
        `RPC call failed (attempt ${attempt}), retrying in ${delayMs}ms: ${error.message}`
      );
    },
    ...rest,
  });
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}