/**
 * Unit tests for createSseTransport.
 *
 * EventSource is mocked globally so tests run in Node.js without a browser.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSseTransport } from "./sseTransport";
import type { OrderObservationEmitter } from "./orderEventStream";

// ── Mock EventSource ─────────────────────────────────────────────────────────

type Listener = (e: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Listener[]>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(listener);
  }

  close() {
    this.closed = true;
  }

  /** Test helper: simulate an event arriving */
  emit(type: string, data: unknown) {
    const evt = { data: JSON.stringify(data) } as MessageEvent;
    for (const l of this.listeners.get(type) ?? []) l(evt);
  }

  /** Test helper: simulate a stream error */
  triggerError() {
    this.onerror?.();
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as any).EventSource = MockEventSource;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEmitter() {
  return {
    snapshot: vi.fn(),
    update: vi.fn(),
    fail: vi.fn(),
  } satisfies OrderObservationEmitter;
}

const ORDER_ID = "wf_0x" + "a".repeat(64);
const BASE_URL = "http://localhost:3001";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createSseTransport — EventSource unavailable", () => {
  it("calls emitter.fail with retryable:false when EventSource is undefined", () => {
    delete (globalThis as any).EventSource;
    const emitter = makeEmitter();
    const transport = createSseTransport(ORDER_ID, BASE_URL);
    transport.start(emitter);
    expect(emitter.fail).toHaveBeenCalledWith(
      expect.objectContaining({ code: "network", retryable: false }),
    );
  });
});

describe("createSseTransport — emitter.update on named events", () => {
  it("calls emitter.update when OrderCreated fires", () => {
    const emitter = makeEmitter();
    const transport = createSseTransport(ORDER_ID, BASE_URL);
    transport.start(emitter);

    const es = MockEventSource.instances[0]!;
    es.emit("OrderCreated", {
      orderId: ORDER_ID,
      status: "src_locked",
      srcTxHash: "0xabc",
      timestamp: Date.now(),
    });

    expect(emitter.update).toHaveBeenCalledOnce();
    const payload = emitter.update.mock.calls[0][0];
    expect(payload.orderId).toBe(ORDER_ID);
    expect(payload.status).toBe("pending"); // src_locked maps to pending
    expect(payload.source).toBe("live");
  });

  it("calls emitter.update when OrderClaimed fires", () => {
    const emitter = makeEmitter();
    createSseTransport(ORDER_ID, BASE_URL).start(emitter);
    MockEventSource.instances[0]!.emit("OrderClaimed", {
      orderId: ORDER_ID,
      status: "dst_locked",
      timestamp: Date.now(),
    });
    expect(emitter.update).toHaveBeenCalledOnce();
    expect(emitter.update.mock.calls[0][0].status).toBe("confirmed");
  });

  it("calls emitter.update when OrderRefunded fires", () => {
    const emitter = makeEmitter();
    createSseTransport(ORDER_ID, BASE_URL).start(emitter);
    MockEventSource.instances[0]!.emit("OrderRefunded", {
      orderId: ORDER_ID,
      status: "refunded",
      timestamp: Date.now(),
    });
    expect(emitter.update).toHaveBeenCalledOnce();
    expect(emitter.update.mock.calls[0][0].status).toBe("refunded");
  });

  it("calls emitter.update when SecretRevealed fires", () => {
    const emitter = makeEmitter();
    createSseTransport(ORDER_ID, BASE_URL).start(emitter);
    MockEventSource.instances[0]!.emit("SecretRevealed", {
      orderId: ORDER_ID,
      preimage: "0xdeadbeef",
      timestamp: Date.now(),
    });
    expect(emitter.update).toHaveBeenCalledOnce();
  });

  it("calls emitter.update when StatusChanged fires", () => {
    const emitter = makeEmitter();
    createSseTransport(ORDER_ID, BASE_URL).start(emitter);
    MockEventSource.instances[0]!.emit("StatusChanged", {
      orderId: ORDER_ID,
      status: "completed",
      previousStatus: "secret_revealed",
      timestamp: Date.now(),
    });
    expect(emitter.update).toHaveBeenCalledOnce();
    expect(emitter.update.mock.calls[0][0].status).toBe("completed");
  });

  it("does not throw on malformed JSON in event data", () => {
    const emitter = makeEmitter();
    const transport = createSseTransport(ORDER_ID, BASE_URL);
    transport.start(emitter);
    const es = MockEventSource.instances[0]!;
    // Inject a raw malformed event bypassing the helper
    const fakeEvent = { data: "this is not json" } as MessageEvent;
    const listeners = (es as any).listeners.get("OrderCreated") ?? [];
    expect(() => {
      for (const l of listeners) l(fakeEvent);
    }).not.toThrow();
    expect(emitter.update).not.toHaveBeenCalled();
  });
});

describe("createSseTransport — emitter.fail on onerror", () => {
  it("calls emitter.fail with code:network when onerror fires while online", () => {
    // Simulate online
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    const emitter = makeEmitter();
    createSseTransport(ORDER_ID, BASE_URL).start(emitter);
    MockEventSource.instances[0]!.triggerError();
    expect(emitter.fail).toHaveBeenCalledWith(
      expect.objectContaining({ code: "network" }),
    );
  });

  it("sets retryable:true when navigator.onLine is false", () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const emitter = makeEmitter();
    createSseTransport(ORDER_ID, BASE_URL).start(emitter);
    MockEventSource.instances[0]!.triggerError();
    expect(emitter.fail).toHaveBeenCalledWith(
      expect.objectContaining({ retryable: true }),
    );
  });
});

describe("createSseTransport — teardown", () => {
  it("closes the EventSource when the teardown function is called", () => {
    const emitter = makeEmitter();
    const teardown = createSseTransport(ORDER_ID, BASE_URL).start(emitter);
    const es = MockEventSource.instances[0]!;
    expect(es.closed).toBe(false);
    teardown();
    expect(es.closed).toBe(true);
  });
});

describe("createSseTransport — URL construction", () => {
  it("builds the correct EventSource URL", () => {
    const emitter = makeEmitter();
    createSseTransport(ORDER_ID, BASE_URL).start(emitter);
    const es = MockEventSource.instances[0]!;
    expect(es.url).toBe(`${BASE_URL}/api/orders/${ORDER_ID}/events`);
  });

  it("strips trailing slash from apiBaseUrl", () => {
    const emitter = makeEmitter();
    createSseTransport(ORDER_ID, "http://localhost:3001/").start(emitter);
    expect(MockEventSource.instances[0]!.url).toContain("/api/orders/");
    expect(MockEventSource.instances[0]!.url).not.toContain("//api");
  });
});
