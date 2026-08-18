/**
 * Unit tests for SseBroker.
 *
 * Tests are fully synchronous — no HTTP server required. The broker only
 * needs SseResponseHandle-compatible objects, which are trivially mockable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SseBroker, MAX_SUBSCRIBERS, REPLAY_BUFFER_SIZE } from "../src/sse/sse-broker.js";
import {
  buildOrderCreatedPayload,
  buildOrderRefundedPayload,
  buildStatusChangedPayload,
  type SseResponseHandle,
} from "../src/sse/event-builders.js";

// ── Mock handle factory ──────────────────────────────────────────────────────

function makeHandle(overrides: Partial<SseResponseHandle> = {}): SseResponseHandle & {
  written: string[];
  closed: boolean;
  closeListeners: Array<() => void>;
} {
  const handle = {
    written: [] as string[],
    closed: false,
    closeListeners: [] as Array<() => void>,
    writableEnded: false,
    write(chunk: string) {
      this.written.push(chunk);
      return true;
    },
    end() {
      this.closed = true;
      this.writableEnded = true;
    },
    on(event: string, listener: () => void) {
      if (event === "close") this.closeListeners.push(listener);
      return this;
    },
    simulateDisconnect() {
      this.writableEnded = true;
      for (const l of this.closeListeners) l();
    },
    ...overrides,
  };
  return handle as unknown as SseResponseHandle & {
    written: string[];
    closed: boolean;
    closeListeners: Array<() => void>;
  };
}

const ORDER_ID = "wf_0x" + "a".repeat(64);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SseBroker — subscriber receives broadcast", () => {
  let broker: SseBroker;

  beforeEach(() => {
    vi.useFakeTimers();
    broker = new SseBroker({ keepAliveIntervalMs: 30_000 });
  });

  afterEach(() => {
    broker.shutdown();
    vi.useRealTimers();
  });

  it("delivers a broadcast frame to a registered subscriber", () => {
    const handle = makeHandle();
    broker.subscribe(ORDER_ID, handle);
    broker.broadcast(ORDER_ID, buildOrderCreatedPayload({
      publicId: ORDER_ID,
      srcChain: "ethereum",
      srcLockTx: "0xabc",
      srcLockBlock: 100,
      srcTimelock: 9999999,
    }));
    expect(handle.written.length).toBeGreaterThan(0);
    expect(handle.written[0]).toContain("OrderCreated");
    expect(handle.written[0]).toContain("id: 1");
  });

  it("delivers to multiple subscribers for the same order", () => {
    const h1 = makeHandle();
    const h2 = makeHandle();
    broker.subscribe(ORDER_ID, h1);
    broker.subscribe(ORDER_ID, h2);
    broker.broadcast(ORDER_ID, buildStatusChangedPayload(ORDER_ID, "completed", "secret_revealed"));
    expect(h1.written.length).toBe(1);
    expect(h2.written.length).toBe(1);
  });

  it("does not deliver to subscribers of a different order", () => {
    const OTHER = "wf_0x" + "b".repeat(64);
    const h1 = makeHandle();
    const h2 = makeHandle();
    broker.subscribe(ORDER_ID, h1);
    broker.subscribe(OTHER, h2);
    broker.broadcast(ORDER_ID, buildStatusChangedPayload(ORDER_ID, "completed", "secret_revealed"));
    expect(h1.written.length).toBe(1);
    expect(h2.written.length).toBe(0);
  });
});

describe("SseBroker — replay buffer", () => {
  let broker: SseBroker;

  beforeEach(() => {
    vi.useFakeTimers();
    broker = new SseBroker({ keepAliveIntervalMs: 30_000 });
  });

  afterEach(() => {
    broker.shutdown();
    vi.useRealTimers();
  });

  it("stores broadcast events in the replay buffer", () => {
    broker.subscribe(ORDER_ID, makeHandle());
    broker.broadcast(ORDER_ID, buildStatusChangedPayload(ORDER_ID, "src_locked", "announced"));
    expect(broker.getReplayBuffer(ORDER_ID).length).toBe(1);
  });

  it("caps replay buffer at REPLAY_BUFFER_SIZE (50)", () => {
    broker.subscribe(ORDER_ID, makeHandle());
    for (let i = 0; i < REPLAY_BUFFER_SIZE + 10; i++) {
      broker.broadcast(ORDER_ID, buildStatusChangedPayload(ORDER_ID, "src_locked", "announced"));
    }
    expect(broker.getReplayBuffer(ORDER_ID).length).toBe(REPLAY_BUFFER_SIZE);
  });

  it("replays missed events when Last-Event-ID is provided on subscribe", () => {
    // Pre-broadcast 3 events (no subscriber yet to receive them)
    const dummy = makeHandle();
    broker.subscribe(ORDER_ID, dummy);
    broker.broadcast(ORDER_ID, buildStatusChangedPayload(ORDER_ID, "src_locked", "announced"));
    broker.broadcast(ORDER_ID, buildStatusChangedPayload(ORDER_ID, "dst_locked", "src_locked"));
    broker.broadcast(ORDER_ID, buildStatusChangedPayload(ORDER_ID, "secret_revealed", "dst_locked"));
    broker.subscribe(ORDER_ID, dummy); // disconnect dummy so replay doesn't go to it
    const { written } = dummy;
    const beforeCount = written.length;

    // New subscriber reconnecting after event id=1
    const reconnect = makeHandle();
    broker.subscribe(ORDER_ID, reconnect, 1);
    // Should have replayed events id=2 and id=3
    expect(reconnect.written.length).toBe(2);
  });

  it("emits replay-gap when Last-Event-ID is older than oldest buffered event", () => {
    const h = makeHandle();
    broker.subscribe(ORDER_ID, h);
    // Send 50 events to fill the buffer
    for (let i = 0; i < REPLAY_BUFFER_SIZE + 5; i++) {
      broker.broadcast(ORDER_ID, buildStatusChangedPayload(ORDER_ID, "src_locked", "announced"));
    }
    const reconnect = makeHandle();
    // lastEventId=1 is older than the oldest buffered event
    broker.subscribe(ORDER_ID, reconnect, 1);
    expect(reconnect.written.some((f) => f.includes("replay-gap"))).toBe(true);
  });
});

describe("SseBroker — keep-alive ping", () => {
  it("emits a ping comment after the keep-alive interval", () => {
    vi.useFakeTimers();
    const broker = new SseBroker({ keepAliveIntervalMs: 30_000 });
    const handle = makeHandle();
    broker.subscribe(ORDER_ID, handle);
    vi.advanceTimersByTime(30_001);
    expect(handle.written.some((f) => f === ": ping\n\n")).toBe(true);
    broker.shutdown();
    vi.useRealTimers();
  });

  it("ping frame does not contain event: or data: fields", () => {
    vi.useFakeTimers();
    const broker = new SseBroker({ keepAliveIntervalMs: 30_000 });
    const handle = makeHandle();
    broker.subscribe(ORDER_ID, handle);
    vi.advanceTimersByTime(30_001);
    const ping = handle.written.find((f) => f.includes("ping"));
    expect(ping).toBeDefined();
    expect(ping).not.toContain("event:");
    expect(ping).not.toContain("data:");
    broker.shutdown();
    vi.useRealTimers();
  });
});

describe("SseBroker — subscriber cap", () => {
  it("returns false when MAX_SUBSCRIBERS is reached", () => {
    vi.useFakeTimers();
    const broker = new SseBroker({ keepAliveIntervalMs: 30_000 });

    // Fill up to the cap using different order IDs
    for (let i = 0; i < MAX_SUBSCRIBERS; i++) {
      const orderId = `wf_0x${"a".repeat(63)}${i.toString(16).slice(-1)}`;
      broker.subscribe(orderId.padEnd(70, "0").slice(0, 70), makeHandle());
    }

    const result = broker.subscribe(ORDER_ID, makeHandle());
    expect(result).toBe(false);
    broker.shutdown();
    vi.useRealTimers();
  });

  it("subscriberCount reflects active connections", () => {
    vi.useFakeTimers();
    const broker = new SseBroker({ keepAliveIntervalMs: 30_000 });
    const h1 = makeHandle();
    const h2 = makeHandle();
    broker.subscribe(ORDER_ID, h1);
    broker.subscribe(ORDER_ID, h2);
    expect(broker.subscriberCount).toBe(2);
    (h1 as any).simulateDisconnect();
    expect(broker.subscriberCount).toBe(1);
    broker.shutdown();
    vi.useRealTimers();
  });
});

describe("SseBroker — terminal broadcast closes stream", () => {
  it("calls end() on the response handle after a terminal event", () => {
    vi.useFakeTimers();
    const broker = new SseBroker({ keepAliveIntervalMs: 30_000 });
    const handle = makeHandle();
    broker.subscribe(ORDER_ID, handle);
    broker.broadcast(ORDER_ID, buildOrderRefundedPayload(ORDER_ID));
    expect(handle.closed).toBe(true);
    broker.shutdown();
    vi.useRealTimers();
  });

  it("removes subscriber after terminal broadcast", () => {
    vi.useFakeTimers();
    const broker = new SseBroker({ keepAliveIntervalMs: 30_000 });
    const handle = makeHandle();
    broker.subscribe(ORDER_ID, handle);
    expect(broker.subscriberCount).toBe(1);
    broker.broadcast(ORDER_ID, buildOrderRefundedPayload(ORDER_ID));
    expect(broker.subscriberCount).toBe(0);
    broker.shutdown();
    vi.useRealTimers();
  });

  it("removes subscriber when StatusChanged carries a terminal status", () => {
    vi.useFakeTimers();
    const broker = new SseBroker({ keepAliveIntervalMs: 30_000 });
    const handle = makeHandle();
    broker.subscribe(ORDER_ID, handle);
    broker.broadcast(ORDER_ID, buildStatusChangedPayload(ORDER_ID, "completed", "secret_revealed"));
    expect(handle.closed).toBe(true);
    expect(broker.subscriberCount).toBe(0);
    broker.shutdown();
    vi.useRealTimers();
  });
});

describe("SseBroker — disconnected subscriber cleanup", () => {
  it("removes a subscriber that disconnects on the close event", () => {
    vi.useFakeTimers();
    const broker = new SseBroker({ keepAliveIntervalMs: 30_000 });
    const handle = makeHandle();
    broker.subscribe(ORDER_ID, handle);
    expect(broker.subscriberCount).toBe(1);
    (handle as any).simulateDisconnect();
    expect(broker.subscriberCount).toBe(0);
    broker.shutdown();
    vi.useRealTimers();
  });

  it("silently skips a writableEnded handle on next broadcast without throwing", () => {
    vi.useFakeTimers();
    const broker = new SseBroker({ keepAliveIntervalMs: 30_000 });
    const handle = makeHandle();
    broker.subscribe(ORDER_ID, handle);
    handle.writableEnded = true; // simulate socket gone without close event
    expect(() =>
      broker.broadcast(ORDER_ID, buildStatusChangedPayload(ORDER_ID, "src_locked", "announced"))
    ).not.toThrow();
    broker.shutdown();
    vi.useRealTimers();
  });
});

describe("SseBroker — shutdown", () => {
  it("sends shutdown frames to all open streams", () => {
    vi.useFakeTimers();
    const broker = new SseBroker({ keepAliveIntervalMs: 30_000 });
    const h1 = makeHandle();
    const h2 = makeHandle();
    broker.subscribe(ORDER_ID, h1);
    broker.subscribe("wf_0x" + "c".repeat(64), h2);
    broker.shutdown();
    expect(h1.written.some((f) => f.includes("shutdown"))).toBe(true);
    expect(h2.written.some((f) => f.includes("shutdown"))).toBe(true);
    expect(broker.subscriberCount).toBe(0);
    vi.useRealTimers();
  });

  it("is idempotent — calling shutdown twice does not throw", () => {
    vi.useFakeTimers();
    const broker = new SseBroker({ keepAliveIntervalMs: 30_000 });
    broker.subscribe(ORDER_ID, makeHandle());
    expect(() => { broker.shutdown(); broker.shutdown(); }).not.toThrow();
    vi.useRealTimers();
  });
});
