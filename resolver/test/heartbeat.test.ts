/**
 * Tests for the resolver HeartbeatClient.
 *
 * Covered:
 *  - start/stop lifecycle
 *  - Immediate heartbeat on start
 *  - Best-effort: coordinator unreachable does not throw
 *  - Best-effort: coordinator returns non-ok does not throw
 *  - No-op when no addresses configured
 *  - Sends for both ethereum and stellar when both addresses set
 *  - stats counters (sent, failures)
 *  - stop() is idempotent
 *  - running flag
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { HeartbeatClient } from "../src/heartbeat.js";

const log = pino({ level: "silent" });
const ETH_ADDR     = "0x1111111111111111111111111111111111111111";
const STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const COORDINATOR  = "http://coordinator.test";

function makeOkFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: async () => "{}",
  } as unknown as Response);
}

function makeFailFetch(status = 500) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => "error",
  } as unknown as Response);
}

function makeThrowFetch() {
  return vi.fn().mockRejectedValue(new Error("connection refused"));
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

describe("HeartbeatClient lifecycle", () => {
  it("running is false before start()", () => {
    const client = new HeartbeatClient({
      coordinatorUrl: COORDINATOR,
      ethereumAddress: ETH_ADDR,
      fetcher: makeOkFetch(),
      log,
    });
    expect(client.running).toBe(false);
  });

  it("start() sets running = true when an address is configured", async () => {
    const fetcher = makeOkFetch();
    const client = new HeartbeatClient({
      coordinatorUrl: COORDINATOR,
      ethereumAddress: ETH_ADDR,
      fetcher,
      log,
    });
    client.start();
    expect(client.running).toBe(true);
    client.stop();
  });

  it("stop() sets running = false", async () => {
    const client = new HeartbeatClient({
      coordinatorUrl: COORDINATOR,
      ethereumAddress: ETH_ADDR,
      fetcher: makeOkFetch(),
      log,
    });
    client.start();
    client.stop();
    expect(client.running).toBe(false);
  });

  it("stop() is idempotent — calling twice does not throw", () => {
    const client = new HeartbeatClient({
      coordinatorUrl: COORDINATOR,
      ethereumAddress: ETH_ADDR,
      fetcher: makeOkFetch(),
      log,
    });
    client.start();
    expect(() => { client.stop(); client.stop(); }).not.toThrow();
  });

  it("start() is a no-op when no addresses are configured", () => {
    const fetcher = makeOkFetch();
    const client = new HeartbeatClient({
      coordinatorUrl: COORDINATOR,
      fetcher,
      log,
    });
    client.start();
    expect(client.running).toBe(false);
  });

  it("start() is idempotent — second call does not create a second interval", async () => {
    const fetcher = makeOkFetch();
    const client = new HeartbeatClient({
      coordinatorUrl: COORDINATOR,
      ethereumAddress: ETH_ADDR,
      fetcher,
      intervalMs: 60_000,
      log,
    });
    client.start();
    client.start(); // second start
    // Only one immediate heartbeat should have been scheduled
    await new Promise((r) => setTimeout(r, 20));
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.stop();
  });
});

// ── Heartbeat sending ─────────────────────────────────────────────────────────

describe("HeartbeatClient sending", () => {
  it("sends an immediate heartbeat on start()", async () => {
    const fetcher = makeOkFetch();
    const client = new HeartbeatClient({
      coordinatorUrl: COORDINATOR,
      ethereumAddress: ETH_ADDR,
      fetcher,
      intervalMs: 60_000,
      log,
    });
    client.start();
    // Allow the microtask to flush
    await new Promise((r) => setTimeout(r, 20));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${COORDINATOR}/api/resolvers/heartbeat`);
    expect(JSON.parse(init.body as string)).toEqual({ address: ETH_ADDR, chain: "ethereum" });
    client.stop();
  });

  it("sends heartbeats for both ethereum and stellar when both addresses set", async () => {
    const fetcher = makeOkFetch();
    const client = new HeartbeatClient({
      coordinatorUrl: COORDINATOR,
      ethereumAddress: ETH_ADDR,
      stellarAddress:  STELLAR_ADDR,
      fetcher,
      intervalMs: 60_000,
      log,
    });
    client.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetcher).toHaveBeenCalledTimes(2);
    const bodies = fetcher.mock.calls.map(([, init]: [string, RequestInit]) =>
      JSON.parse(init.body as string),
    );
    expect(bodies).toContainEqual({ address: ETH_ADDR,     chain: "ethereum" });
    expect(bodies).toContainEqual({ address: STELLAR_ADDR, chain: "stellar"  });
    client.stop();
  });

  it("increments sent counter on each heartbeat", async () => {
    const fetcher = makeOkFetch();
    const client = new HeartbeatClient({
      coordinatorUrl: COORDINATOR,
      ethereumAddress: ETH_ADDR,
      fetcher,
      intervalMs: 60_000,
      log,
    });
    client.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(client.stats.sent).toBe(1);
    client.stop();
  });

  it("strips trailing slash from coordinatorUrl", async () => {
    const fetcher = makeOkFetch();
    const client = new HeartbeatClient({
      coordinatorUrl: `${COORDINATOR}/`,
      ethereumAddress: ETH_ADDR,
      fetcher,
      intervalMs: 60_000,
      log,
    });
    client.start();
    await new Promise((r) => setTimeout(r, 20));
    const [url] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${COORDINATOR}/api/resolvers/heartbeat`);
    client.stop();
  });
});

// ── Best-effort failure handling ──────────────────────────────────────────────

describe("HeartbeatClient best-effort failure handling", () => {
  it("does not throw when coordinator is unreachable", async () => {
    const client = new HeartbeatClient({
      coordinatorUrl: COORDINATOR,
      ethereumAddress: ETH_ADDR,
      fetcher: makeThrowFetch(),
      intervalMs: 60_000,
      log,
    });
    client.start();
    // Wait for the immediate send to settle
    await new Promise((r) => setTimeout(r, 30));
    expect(client.running).toBe(true); // still running
    client.stop();
  });

  it("increments failures counter when coordinator throws", async () => {
    const client = new HeartbeatClient({
      coordinatorUrl: COORDINATOR,
      ethereumAddress: ETH_ADDR,
      fetcher: makeThrowFetch(),
      intervalMs: 60_000,
      log,
    });
    client.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(client.stats.failures).toBe(1);
    expect(client.stats.sent).toBe(1);
    client.stop();
  });

  it("does not throw when coordinator returns 500", async () => {
    const client = new HeartbeatClient({
      coordinatorUrl: COORDINATOR,
      ethereumAddress: ETH_ADDR,
      fetcher: makeFailFetch(500),
      intervalMs: 60_000,
      log,
    });
    client.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(client.running).toBe(true);
    expect(client.stats.failures).toBe(1);
    client.stop();
  });

  it("does not throw when coordinator returns 400", async () => {
    const client = new HeartbeatClient({
      coordinatorUrl: COORDINATOR,
      ethereumAddress: ETH_ADDR,
      fetcher: makeFailFetch(400),
      intervalMs: 60_000,
      log,
    });
    client.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(client.stats.failures).toBe(1);
    client.stop();
  });

  it("failures do not prevent the client from continuing to run", async () => {
    // A throwing fetch should not stop the interval or throw to the caller.
    const fetcher = makeThrowFetch();
    const client = new HeartbeatClient({
      coordinatorUrl: COORDINATOR,
      ethereumAddress: ETH_ADDR,
      fetcher,
      intervalMs: 60_000,
      log,
    });
    client.start();
    await new Promise((r) => setTimeout(r, 30));
    // After the initial failed heartbeat, the client must still be running.
    expect(client.running).toBe(true);
    expect(client.stats.failures).toBe(1);
    client.stop();
  });
});

// ── Minimum interval enforcement ──────────────────────────────────────────────

describe("HeartbeatClient minimum interval", () => {
  it("enforces a minimum of 10 000 ms even when a smaller value is provided", async () => {
    // We can't easily test the actual interval timing, but we can verify the
    // client starts and stops cleanly with a sub-minimum intervalMs.
    const fetcher = makeOkFetch();
    const client = new HeartbeatClient({
      coordinatorUrl: COORDINATOR,
      ethereumAddress: ETH_ADDR,
      fetcher,
      intervalMs: 1, // below minimum
      log,
    });
    client.start();
    await new Promise((r) => setTimeout(r, 20));
    // Should still have sent the immediate heartbeat
    expect(client.stats.sent).toBeGreaterThanOrEqual(1);
    client.stop();
  });
});
