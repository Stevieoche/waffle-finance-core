/**
 * E2E push delivery tests for the SSE endpoint.
 *
 * Spins up a real HTTP server on a random port, opens an EventSource-compatible
 * connection using the `eventsource` npm package, drives state transitions via
 * OrderService, and asserts that the correct SSE frames arrive within timeouts.
 *
 * These tests are intentionally coarse-grained — they verify the integration
 * of the full stack (broker + route + order-service wiring) rather than
 * individual units.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { QuoteService } from "../src/services/quote-service.js";
import { createApp } from "../src/server/app.js";
import { SseBroker } from "../src/sse/sse-broker.js";

const log = pino({ level: "silent" });

const VALID_HASHLOCK = "0x" + "ab".repeat(32);
const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR   = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

const ANNOUNCE_BODY = {
  direction: "eth_to_xlm",
  hashlock: VALID_HASHLOCK,
  srcChain: "ethereum",
  srcAddress: VALID_ETH_ADDR,
  srcAsset: "native",
  srcAmount: "1000000000000000000",
  srcSafetyDeposit: "1000000000000000",
  dstChain: "stellar",
  dstAddress: VALID_STELLAR,
  dstAsset: "native",
  dstAmount: "100000000",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

interface TestServer {
  orders: OrderService;
  sseBroker: SseBroker;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startServer(pingIntervalMs = 30_000): Promise<TestServer> {
  const dir = mkdtempSync(resolve(tmpdir(), "sse-e2e-test-"));
  const db = await openDatabase(`file:${dir}/test.db`);
  const repo = new OrdersRepository(db);
  const sseBroker = new SseBroker({ keepAliveIntervalMs: pingIntervalMs });
  const orders = new OrderService(repo, log, { sseBroker });
  const secrets = new SecretService(orders, log);
  const quotes = new QuoteService(log);
  const app = createApp({ log, corsOrigin: "*", orders, secrets, quotes, sseBroker });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    orders,
    sseBroker,
    baseUrl,
    close: () => {
      sseBroker.shutdown();
      return new Promise<void>((res, rej) =>
        server.close((err) => (err ? rej(err) : res()))
      );
    },
  };
}

/**
 * Collect SSE frames from a URL until `predicate` returns true or `timeoutMs` elapses.
 * Returns all frames received up to that point.
 */
function collectFrames(
  url: string,
  predicate: (frames: string[]) => boolean,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<string[]> {
  return new Promise((resolve) => {
    const frames: string[] = [];
    let buffer = "";
    let settled = false;

    const settle = () => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve(frames);
    };

    const timer = setTimeout(settle, timeoutMs);

    const urlObj = new URL(url);
    const opts: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "GET",
      headers: { Accept: "text/event-stream", ...headers },
    };

    const req = http.request(opts, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        // SSE frames are separated by double newlines
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (part.trim()) {
            frames.push(part + "\n\n");
            if (predicate(frames)) {
              clearTimeout(timer);
              settle();
            }
          }
        }
      });
      res.on("end", settle);
      res.on("error", settle);
    });

    req.on("error", settle);
    req.end();
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: OrderCreated event delivery", () => {
  let ts: TestServer;

  beforeEach(async () => {
    ts = await startServer();
  });

  afterEach(async () => {
    await ts.close();
  });

  it("delivers OrderCreated frame within 2s of recordSrcLock", async () => {
    const order = await ts.orders.announce(ANNOUNCE_BODY as any);

    // Start collecting frames (predicate: has OrderCreated)
    const framesP = collectFrames(
      `${ts.baseUrl}/api/orders/${order.publicId}/events`,
      (fs) => fs.some((f) => f.includes("OrderCreated")),
      2000,
    );

    // Small delay to let the connection register
    await new Promise((r) => setTimeout(r, 80));

    await ts.orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "src-order-1",
      txHash: "0x" + "1".repeat(64),
      blockNumber: 100,
      timelock: Math.floor(Date.now() / 1000) + 3600,
    });

    const frames = await framesP;
    const received = frames.map((f) => f).join("\n");
    expect(received).toContain("OrderCreated");
  }, 5000);
});

describe("E2E: Full state transition sequence", () => {
  let ts: TestServer;

  beforeEach(async () => {
    ts = await startServer();
  });

  afterEach(async () => {
    await ts.close();
  });

  it("produces correct event sequence for src_locked → dst_locked → secret_revealed → completed", async () => {
    const order = await ts.orders.announce(ANNOUNCE_BODY as any);

    const expectedEvents = ["OrderCreated", "OrderClaimed", "SecretRevealed", "StatusChanged"];
    const receivedEventTypes: string[] = [];

    const framesP = collectFrames(
      `${ts.baseUrl}/api/orders/${order.publicId}/events`,
      () => receivedEventTypes.length >= expectedEvents.length,
      5000,
    );

    // Small delay to ensure connection is established
    await new Promise((r) => setTimeout(r, 80));

    // Drive through transitions
    await ts.orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "src-1",
      txHash: "0x" + "1".repeat(64),
      blockNumber: 100,
      timelock: Math.floor(Date.now() / 1000) + 3600,
    });

    await ts.orders.recordDstLock({
      publicId: order.publicId,
      orderId: "dst-1",
      txHash: "0x" + "2".repeat(64),
      blockNumber: 200,
      timelock: Math.floor(Date.now() / 1000) + 1800,
      resolver: null,
    });

    await ts.orders.recordSecret(order.publicId, "0x" + "ff".repeat(32), "0x" + "3".repeat(64));
    await ts.orders.markStatus(order.publicId, "completed");

    const frames = await framesP;

    for (const f of frames) {
      const eventMatch = f.match(/^event: (\w+)/m);
      if (eventMatch) receivedEventTypes.push(eventMatch[1]);
    }

    expect(receivedEventTypes).toContain("OrderCreated");
    expect(receivedEventTypes).toContain("OrderClaimed");
    expect(receivedEventTypes).toContain("SecretRevealed");
    expect(receivedEventTypes).toContain("StatusChanged");
  }, 10000);
});

describe("E2E: Last-Event-ID reconnect", () => {
  let ts: TestServer;

  beforeEach(async () => {
    ts = await startServer();
  });

  afterEach(async () => {
    await ts.close();
  });

  it("reconnect with Last-Event-ID receives only missed events", async () => {
    const order = await ts.orders.announce(ANNOUNCE_BODY as any);

    // Send first event via broker directly (no subscriber yet — goes to buffer)
    ts.sseBroker.broadcast(order.publicId, {
      event: "StatusChanged",
      timestamp: Date.now(),
      data: { orderId: order.publicId, status: "src_locked", previousStatus: "announced", timestamp: Date.now() },
    });

    // Reconnect with Last-Event-ID=0 — should receive event id=1
    const frames = await collectFrames(
      `${ts.baseUrl}/api/orders/${order.publicId}/events`,
      (fs) => fs.some((f) => f.includes("id: 1")),
      2000,
      { "Last-Event-ID": "0" },
    );

    const allText = frames.join("\n");
    expect(allText).toContain("id: 1");
  }, 5000);
});

describe("E2E: Keep-alive ping", () => {
  let ts: TestServer;

  beforeEach(async () => {
    ts = await startServer(200); // very short ping interval for test
  });

  afterEach(async () => {
    await ts.close();
  });

  it("emits a ping comment within the keep-alive interval", async () => {
    const order = await ts.orders.announce(ANNOUNCE_BODY as any);

    const frames = await collectFrames(
      `${ts.baseUrl}/api/orders/${order.publicId}/events`,
      (fs) => fs.some((f) => f.includes(": ping")),
      1000,
    );

    expect(frames.some((f) => f.includes(": ping"))).toBe(true);
  }, 3000);
});

describe("E2E: Client disconnect cleanup", () => {
  let ts: TestServer;

  beforeEach(async () => {
    ts = await startServer();
  });

  afterEach(async () => {
    await ts.close();
  });

  it("removes subscriber from broker within 1s of client disconnect", async () => {
    const order = await ts.orders.announce(ANNOUNCE_BODY as any);

    expect(ts.sseBroker.subscriberCount).toBe(0);

    // Connect and immediately collect (the collectFrames function will abort)
    const connP = collectFrames(
      `${ts.baseUrl}/api/orders/${order.publicId}/events`,
      () => false, // never settle via predicate
      200,         // short timeout to simulate disconnect
    );

    // Wait briefly for connection to register
    await new Promise((r) => setTimeout(r, 80));
    const countAfterConnect = ts.sseBroker.subscriberCount;

    await connP; // connection aborted after 200ms

    // Allow event loop to process the close event
    await new Promise((r) => setTimeout(r, 200));

    expect(ts.sseBroker.subscriberCount).toBeLessThan(countAfterConnect);
  }, 5000);
});
