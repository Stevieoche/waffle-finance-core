import { describe, it, expect, vi, afterEach } from "vitest";
import {
  calculateBackoff,
  normalizeRetryOptions,
  withRetry,
  type RetryOptions,
} from "../src/retry.js";

// ── normalizeRetryOptions ─────────────────────────────────────────────────────

describe("normalizeRetryOptions — negative delay / jitter rejection", () => {
  it("throws RangeError for negative baseDelayMs", () => {
    expect(() => normalizeRetryOptions({ baseDelayMs: -1 })).toThrow(RangeError);
    expect(() => normalizeRetryOptions({ baseDelayMs: -1 })).toThrow(/baseDelayMs/);
  });

  it("throws RangeError for negative jitterFactor", () => {
    expect(() => normalizeRetryOptions({ jitterFactor: -0.1 })).toThrow(RangeError);
    expect(() => normalizeRetryOptions({ jitterFactor: -0.1 })).toThrow(/jitterFactor/);
  });

  it("accepts zero baseDelayMs (no delay is valid — e.g. tests)", () => {
    const opts = normalizeRetryOptions({ baseDelayMs: 0 });
    expect(opts.baseDelayMs).toBe(0);
  });

  it("accepts zero jitterFactor (deterministic backoff is valid)", () => {
    const opts = normalizeRetryOptions({ jitterFactor: 0 });
    expect(opts.jitterFactor).toBe(0);
  });

  it("passes through valid positive values unchanged", () => {
    const opts = normalizeRetryOptions({ baseDelayMs: 500, jitterFactor: 0.3, maxAttempts: 4 });
    expect(opts.baseDelayMs).toBe(500);
    expect(opts.jitterFactor).toBe(0.3);
    expect(opts.maxAttempts).toBe(4);
  });
});

describe("normalizeRetryOptions — zero / low maxAttempts normalisation", () => {
  it("normalizes maxAttempts=0 to 1 (run at least once)", () => {
    const opts = normalizeRetryOptions({ maxAttempts: 0 });
    expect(opts.maxAttempts).toBe(1);
  });

  it("normalizes maxAttempts=-5 to 1", () => {
    const opts = normalizeRetryOptions({ maxAttempts: -5 });
    expect(opts.maxAttempts).toBe(1);
  });

  it("leaves maxAttempts=1 unchanged", () => {
    expect(normalizeRetryOptions({ maxAttempts: 1 }).maxAttempts).toBe(1);
  });

  it("leaves maxAttempts=3 unchanged", () => {
    expect(normalizeRetryOptions({ maxAttempts: 3 }).maxAttempts).toBe(3);
  });
});

// ── withRetry — negative config rejects at call-site ─────────────────────────

describe("withRetry — negative configuration is rejected before any attempt", () => {
  it("throws synchronously (before invoking fn) when baseDelayMs is negative", async () => {
    const fn = vi.fn();
    await expect(withRetry(fn, { baseDelayMs: -100 })).rejects.toThrow(RangeError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("throws synchronously (before invoking fn) when jitterFactor is negative", async () => {
    const fn = vi.fn();
    await expect(withRetry(fn, { jitterFactor: -0.5 })).rejects.toThrow(RangeError);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ── withRetry — maxAttempts=0 is deterministic ────────────────────────────────

describe("withRetry — maxAttempts=0 executes exactly once", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls fn exactly once when maxAttempts=0 and fn succeeds", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxAttempts: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toBe("ok");
  });

  it("throws after exactly one attempt when maxAttempts=0 and fn always fails", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(withRetry(fn, { maxAttempts: 0 })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ── withRetry — timer behavior with fake timers ───────────────────────────────

describe("withRetry — no negative timeout is ever scheduled", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("all scheduled timeouts are ≥ 0 ms with valid options", async () => {
    vi.useFakeTimers();

    const scheduledDelays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (typeof ms === "number") scheduledDelays.push(ms);
        return origSetTimeout(fn as (...args: unknown[]) => void, ms, ...args);
      });

    let attempt = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt < 3) throw new Error("transient");
      return "done";
    });

    const promise = withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 100,
      jitterFactor: 0.5,
      maxDelayMs: 5000,
    });

    // Drain all pending timers until the promise settles.
    await vi.runAllTimersAsync();
    await promise;

    setTimeoutSpy.mockRestore();

    // Every timeout that withRetry scheduled must be non-negative.
    const retryDelays = scheduledDelays.filter((ms) => ms >= 0);
    expect(retryDelays.length).toBe(scheduledDelays.length);
    for (const ms of scheduledDelays) {
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── calculateBackoff — sanity checks ─────────────────────────────────────────

describe("calculateBackoff", () => {
  it("returns 0 when baseDelayMs is 0", () => {
    // With no base delay and no jitter there is no delay.
    expect(calculateBackoff(0, 0, 30000, 0)).toBe(0);
  });

  it("caps at maxDelayMs", () => {
    const result = calculateBackoff(20, 1000, 5000, 0);
    expect(result).toBeLessThanOrEqual(5000);
  });

  it("never returns a negative value regardless of jitter direction", () => {
    // Run many iterations to cover both signs of Math.random() - 0.5.
    for (let i = 0; i < 200; i++) {
      const delay = calculateBackoff(0, 100, 30000, 2.0 /* extreme jitter */);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  it("grows with the attempt number (exponential backoff)", () => {
    // With jitter=0 the result is deterministic.
    const d0 = calculateBackoff(0, 100, 100_000, 0);
    const d1 = calculateBackoff(1, 100, 100_000, 0);
    const d2 = calculateBackoff(2, 100, 100_000, 0);
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
  });
});
