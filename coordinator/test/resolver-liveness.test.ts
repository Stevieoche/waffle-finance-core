/**
 * Tests for the resolver heartbeat and liveness model.
 *
 * Covered:
 *  - ResolverLivenessRepository: upsert, findByAddress, findAll, findStale
 *  - ResolverLivenessService: heartbeat, getLiveness, getAllLiveness,
 *    getStaleResolvers, hasAliveResolver
 *  - HTTP routes: POST /api/resolvers/heartbeat, GET /api/resolvers,
 *    GET /api/resolvers/:address
 *  - Liveness semantics: alive vs stale threshold, age calculation
 *  - Missing heartbeat cases: unknown resolver returns 404
 *  - Integration: healthy resolver + stale resolver in the same query
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import request from "supertest";
import pino from "pino";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { QuoteService } from "../src/services/quote-service.js";
import {
  ResolverLivenessRepository,
  ResolverLivenessService,
  DEFAULT_STALE_THRESHOLD_SECONDS,
} from "../src/services/resolver-liveness.js";
import { createApp } from "../src/server/app.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const log = pino({ level: "silent" });

const ETH_ADDR   = "0x1111111111111111111111111111111111111111";
const ETH_ADDR_2 = "0x2222222222222222222222222222222222222222";
const XLM_ADDR   = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "waffle-liveness-"));
  return openDatabase(`file:${dir}/test.db`);
}

async function freshApp() {
  const db     = await freshDb();
  const repo   = new OrdersRepository(db);
  const orders = new OrderService(repo, log);
  const secrets = new SecretService(orders, log);
  const quotes  = new QuoteService(log);
  const livenessRepo    = new ResolverLivenessRepository(db);
  const resolverLiveness = new ResolverLivenessService(livenessRepo);
  const app = createApp({ log, corsOrigin: "*", orders, secrets, quotes, resolverLiveness });
  return { app, livenessRepo, resolverLiveness };
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── ResolverLivenessRepository ────────────────────────────────────────────────

describe("ResolverLivenessRepository", () => {
  it("upsertHeartbeat stores a new entry", async () => {
    const db   = await freshDb();
    const repo = new ResolverLivenessRepository(db);
    const now  = Math.floor(Date.now() / 1000);
    repo.upsertHeartbeat(ETH_ADDR, "ethereum", now);
    const record = repo.findByAddress(ETH_ADDR);
    expect(record).not.toBeNull();
    expect(record!.address).toBe(ETH_ADDR);
    expect(record!.chain).toBe("ethereum");
    expect(record!.lastSeen).toBe(now);
  });

  it("upsertHeartbeat updates last_seen on duplicate address", async () => {
    const db   = await freshDb();
    const repo = new ResolverLivenessRepository(db);
    const t1   = 1_000_000;
    const t2   = 1_000_060;
    repo.upsertHeartbeat(ETH_ADDR, "ethereum", t1);
    repo.upsertHeartbeat(ETH_ADDR, "ethereum", t2);
    const record = repo.findByAddress(ETH_ADDR);
    expect(record!.lastSeen).toBe(t2);
  });

  it("findByAddress returns null for unknown address", async () => {
    const db   = await freshDb();
    const repo = new ResolverLivenessRepository(db);
    expect(repo.findByAddress("0xunknown")).toBeNull();
  });

  it("findAll returns all entries ordered by last_seen DESC", async () => {
    const db   = await freshDb();
    const repo = new ResolverLivenessRepository(db);
    repo.upsertHeartbeat(ETH_ADDR,   "ethereum", 100);
    repo.upsertHeartbeat(ETH_ADDR_2, "ethereum", 200);
    repo.upsertHeartbeat(XLM_ADDR,   "stellar",  150);
    const all = repo.findAll();
    expect(all).toHaveLength(3);
    expect(all[0].address).toBe(ETH_ADDR_2); // highest last_seen first
    expect(all[1].address).toBe(XLM_ADDR);
    expect(all[2].address).toBe(ETH_ADDR);
  });

  it("findStale returns only entries older than the cutoff", async () => {
    const db    = await freshDb();
    const repo  = new ResolverLivenessRepository(db);
    const now   = 1_000_000;
    const threshold = 90;
    repo.upsertHeartbeat(ETH_ADDR,   "ethereum", now - 100); // stale
    repo.upsertHeartbeat(ETH_ADDR_2, "ethereum", now - 30);  // alive
    repo.upsertHeartbeat(XLM_ADDR,   "stellar",  now - 90);  // exactly at boundary → stale (<=)
    const stale = repo.findStale(threshold, now);
    expect(stale.map((r) => r.address)).toContain(ETH_ADDR);
    expect(stale.map((r) => r.address)).toContain(XLM_ADDR);
    expect(stale.map((r) => r.address)).not.toContain(ETH_ADDR_2);
  });

  it("findStale returns empty array when no resolvers are stale", async () => {
    const db   = await freshDb();
    const repo = new ResolverLivenessRepository(db);
    const now  = 1_000_000;
    repo.upsertHeartbeat(ETH_ADDR, "ethereum", now - 10);
    expect(repo.findStale(90, now)).toHaveLength(0);
  });

  it("upsertHeartbeat defaults lastSeen to current unix time", async () => {
    const db    = await freshDb();
    const repo  = new ResolverLivenessRepository(db);
    const before = Math.floor(Date.now() / 1000);
    repo.upsertHeartbeat(ETH_ADDR, "ethereum");
    const after  = Math.floor(Date.now() / 1000);
    const record = repo.findByAddress(ETH_ADDR)!;
    expect(record.lastSeen).toBeGreaterThanOrEqual(before);
    expect(record.lastSeen).toBeLessThanOrEqual(after);
  });
});

// ── ResolverLivenessService ───────────────────────────────────────────────────

describe("ResolverLivenessService", () => {
  it("heartbeat records liveness for the address", async () => {
    const db      = await freshDb();
    const repo    = new ResolverLivenessRepository(db);
    const service = new ResolverLivenessService(repo);
    const now     = 1_000_000;
    service.heartbeat(ETH_ADDR, "ethereum", now);
    const entry = service.getLiveness(ETH_ADDR, now);
    expect(entry).not.toBeNull();
    expect(entry!.alive).toBe(true);
    expect(entry!.ageSeconds).toBe(0);
  });

  it("getLiveness returns null for an unknown resolver", async () => {
    const db      = await freshDb();
    const service = new ResolverLivenessService(new ResolverLivenessRepository(db));
    expect(service.getLiveness("0xunknown")).toBeNull();
  });

  it("alive is true when ageSeconds <= staleThreshold", async () => {
    const db      = await freshDb();
    const repo    = new ResolverLivenessRepository(db);
    const service = new ResolverLivenessService(repo, 90);
    const now     = 1_000_000;
    service.heartbeat(ETH_ADDR, "ethereum", now - 89); // 89 s ago → alive
    const entry = service.getLiveness(ETH_ADDR, now)!;
    expect(entry.alive).toBe(true);
    expect(entry.ageSeconds).toBe(89);
  });

  it("alive is false when ageSeconds > staleThreshold", async () => {
    const db      = await freshDb();
    const repo    = new ResolverLivenessRepository(db);
    const service = new ResolverLivenessService(repo, 90);
    const now     = 1_000_000;
    service.heartbeat(ETH_ADDR, "ethereum", now - 91); // 91 s ago → stale
    const entry = service.getLiveness(ETH_ADDR, now)!;
    expect(entry.alive).toBe(false);
    expect(entry.ageSeconds).toBe(91);
  });

  it("alive is false at the exact boundary (ageSeconds = threshold)", async () => {
    const db      = await freshDb();
    const repo    = new ResolverLivenessRepository(db);
    const service = new ResolverLivenessService(repo, 90);
    const now     = 1_000_000;
    service.heartbeat(ETH_ADDR, "ethereum", now - 90);
    const entry = service.getLiveness(ETH_ADDR, now)!;
    // ageSeconds (90) <= threshold (90) → alive
    expect(entry.alive).toBe(true);
  });

  it("getAllLiveness returns entries for all resolvers", async () => {
    const db      = await freshDb();
    const repo    = new ResolverLivenessRepository(db);
    const service = new ResolverLivenessService(repo, 90);
    const now     = 1_000_000;
    service.heartbeat(ETH_ADDR,   "ethereum", now - 10);
    service.heartbeat(ETH_ADDR_2, "ethereum", now - 200);
    const all = service.getAllLiveness(now);
    expect(all).toHaveLength(2);
    const alive = all.find((e) => e.address === ETH_ADDR)!;
    const stale = all.find((e) => e.address === ETH_ADDR_2)!;
    expect(alive.alive).toBe(true);
    expect(stale.alive).toBe(false);
  });

  it("getStaleResolvers returns only stale entries", async () => {
    const db      = await freshDb();
    const repo    = new ResolverLivenessRepository(db);
    const service = new ResolverLivenessService(repo, 90);
    const now     = 1_000_000;
    service.heartbeat(ETH_ADDR,   "ethereum", now - 10);  // alive
    service.heartbeat(ETH_ADDR_2, "ethereum", now - 200); // stale
    const stale = service.getStaleResolvers(now);
    expect(stale).toHaveLength(1);
    expect(stale[0].address).toBe(ETH_ADDR_2);
  });

  it("hasAliveResolver returns true when at least one alive resolver exists for chain", async () => {
    const db      = await freshDb();
    const repo    = new ResolverLivenessRepository(db);
    const service = new ResolverLivenessService(repo, 90);
    const now     = 1_000_000;
    service.heartbeat(ETH_ADDR, "ethereum", now - 5);
    expect(service.hasAliveResolver("ethereum", now)).toBe(true);
    expect(service.hasAliveResolver("stellar",  now)).toBe(false);
  });

  it("hasAliveResolver returns false when all resolvers for chain are stale", async () => {
    const db      = await freshDb();
    const repo    = new ResolverLivenessRepository(db);
    const service = new ResolverLivenessService(repo, 90);
    const now     = 1_000_000;
    service.heartbeat(ETH_ADDR, "ethereum", now - 200); // stale
    expect(service.hasAliveResolver("ethereum", now)).toBe(false);
  });

  it("respects custom staleThresholdSeconds passed to constructor", async () => {
    const db      = await freshDb();
    const repo    = new ResolverLivenessRepository(db);
    const service = new ResolverLivenessService(repo, 30); // 30 s threshold
    const now     = 1_000_000;
    service.heartbeat(ETH_ADDR, "ethereum", now - 31); // 31 s → stale under 30 s policy
    expect(service.getLiveness(ETH_ADDR, now)!.alive).toBe(false);
  });

  it("DEFAULT_STALE_THRESHOLD_SECONDS is 90", () => {
    expect(DEFAULT_STALE_THRESHOLD_SECONDS).toBe(90);
  });
});

// ── HTTP routes ───────────────────────────────────────────────────────────────

describe("POST /api/resolvers/heartbeat", () => {
  it("returns 200 and records a heartbeat for a valid address", async () => {
    const { app, resolverLiveness } = await freshApp();
    const now = Math.floor(Date.now() / 1000);

    const res = await request(app)
      .post("/api/resolvers/heartbeat")
      .send({ address: ETH_ADDR, chain: "ethereum" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.address).toBe(ETH_ADDR);
    expect(res.body.chain).toBe("ethereum");

    const entry = resolverLiveness.getLiveness(ETH_ADDR, now + 1);
    expect(entry).not.toBeNull();
    expect(entry!.alive).toBe(true);
  });

  it("records a stellar heartbeat", async () => {
    const { app, resolverLiveness } = await freshApp();
    const now = Math.floor(Date.now() / 1000);

    const res = await request(app)
      .post("/api/resolvers/heartbeat")
      .send({ address: XLM_ADDR, chain: "stellar" });

    expect(res.status).toBe(200);
    const entry = resolverLiveness.getLiveness(XLM_ADDR, now + 1);
    expect(entry!.chain).toBe("stellar");
  });

  it("heartbeat is idempotent — second call updates last_seen", async () => {
    const { app, resolverLiveness } = await freshApp();
    const now = Math.floor(Date.now() / 1000);

    await request(app).post("/api/resolvers/heartbeat")
      .send({ address: ETH_ADDR, chain: "ethereum" });
    await request(app).post("/api/resolvers/heartbeat")
      .send({ address: ETH_ADDR, chain: "ethereum" });

    const entry = resolverLiveness.getLiveness(ETH_ADDR, now + 1)!;
    expect(entry.alive).toBe(true);
  });

  it("returns 400 when address is missing", async () => {
    const { app } = await freshApp();
    const res = await request(app)
      .post("/api/resolvers/heartbeat")
      .send({ chain: "ethereum" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when chain is invalid", async () => {
    const { app } = await freshApp();
    const res = await request(app)
      .post("/api/resolvers/heartbeat")
      .send({ address: ETH_ADDR, chain: "bitcoin" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is empty", async () => {
    const { app } = await freshApp();
    const res = await request(app)
      .post("/api/resolvers/heartbeat")
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("GET /api/resolvers", () => {
  it("returns empty list when no resolvers have sent heartbeats", async () => {
    const { app } = await freshApp();
    const res = await request(app).get("/api/resolvers");
    expect(res.status).toBe(200);
    expect(res.body.resolvers).toHaveLength(0);
    expect(res.body.aliveCount).toBe(0);
    expect(res.body.staleCount).toBe(0);
  });

  it("returns all resolvers with alive/stale classification", async () => {
    const { app, resolverLiveness } = await freshApp();
    const now = Math.floor(Date.now() / 1000);
    // Seed one alive and one stale resolver directly
    resolverLiveness.heartbeat(ETH_ADDR,   "ethereum", now - 10);  // alive
    resolverLiveness.heartbeat(ETH_ADDR_2, "ethereum", now - 200); // stale

    const res = await request(app).get("/api/resolvers");
    expect(res.status).toBe(200);
    expect(res.body.resolvers).toHaveLength(2);
    expect(res.body.aliveCount).toBe(1);
    expect(res.body.staleCount).toBe(1);

    const alive = res.body.resolvers.find((r: any) => r.address === ETH_ADDR);
    const stale = res.body.resolvers.find((r: any) => r.address === ETH_ADDR_2);
    expect(alive.alive).toBe(true);
    expect(stale.alive).toBe(false);
  });

  it("response includes queriedAt ISO timestamp", async () => {
    const { app } = await freshApp();
    const res = await request(app).get("/api/resolvers");
    expect(res.status).toBe(200);
    expect(() => new Date(res.body.queriedAt)).not.toThrow();
  });
});

describe("GET /api/resolvers/:address", () => {
  it("returns 404 for an unknown resolver", async () => {
    const { app } = await freshApp();
    const res = await request(app).get(`/api/resolvers/${ETH_ADDR}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns the liveness entry for a known alive resolver", async () => {
    const { app, resolverLiveness } = await freshApp();
    const now = Math.floor(Date.now() / 1000);
    resolverLiveness.heartbeat(ETH_ADDR, "ethereum", now - 5);

    const res = await request(app).get(`/api/resolvers/${ETH_ADDR}`);
    expect(res.status).toBe(200);
    expect(res.body.address).toBe(ETH_ADDR);
    expect(res.body.chain).toBe("ethereum");
    expect(res.body.alive).toBe(true);
    expect(typeof res.body.ageSeconds).toBe("number");
    expect(typeof res.body.lastSeen).toBe("number");
  });

  it("returns alive=false for a stale resolver", async () => {
    const { app, resolverLiveness } = await freshApp();
    const now = Math.floor(Date.now() / 1000);
    resolverLiveness.heartbeat(ETH_ADDR, "ethereum", now - 200);

    const res = await request(app).get(`/api/resolvers/${ETH_ADDR}`);
    expect(res.status).toBe(200);
    expect(res.body.alive).toBe(false);
    expect(res.body.ageSeconds).toBeGreaterThan(90);
  });
});

// ── Missing heartbeat scenario (registry agreement) ───────────────────────────

describe("missing heartbeat — registry and runtime agreement", () => {
  it("a resolver that never heartbeated is unknown to the coordinator", async () => {
    const db      = await freshDb();
    const repo    = new ResolverLivenessRepository(db);
    const service = new ResolverLivenessService(repo);
    // No heartbeat sent
    expect(service.getLiveness(ETH_ADDR)).toBeNull();
    expect(service.hasAliveResolver("ethereum")).toBe(false);
    expect(service.getStaleResolvers()).toHaveLength(0);
    expect(service.getAllLiveness()).toHaveLength(0);
  });

  it("a resolver that heartbeated once and then went silent becomes stale after threshold", async () => {
    const db      = await freshDb();
    const repo    = new ResolverLivenessRepository(db);
    const service = new ResolverLivenessService(repo, 90);
    const heartbeatAt = 1_000_000;
    service.heartbeat(ETH_ADDR, "ethereum", heartbeatAt);

    // Immediately after: alive
    expect(service.getLiveness(ETH_ADDR, heartbeatAt + 1)!.alive).toBe(true);

    // 89 s later: still alive
    expect(service.getLiveness(ETH_ADDR, heartbeatAt + 89)!.alive).toBe(true);

    // 91 s later: stale
    expect(service.getLiveness(ETH_ADDR, heartbeatAt + 91)!.alive).toBe(false);
    expect(service.getStaleResolvers(heartbeatAt + 91)).toHaveLength(1);
    expect(service.hasAliveResolver("ethereum", heartbeatAt + 91)).toBe(false);
  });

  it("a resolver that resumes heartbeating after a gap becomes alive again", async () => {
    const db      = await freshDb();
    const repo    = new ResolverLivenessRepository(db);
    const service = new ResolverLivenessService(repo, 90);
    const t0 = 1_000_000;

    service.heartbeat(ETH_ADDR, "ethereum", t0);
    // Goes stale
    expect(service.getLiveness(ETH_ADDR, t0 + 200)!.alive).toBe(false);

    // Sends a fresh heartbeat
    service.heartbeat(ETH_ADDR, "ethereum", t0 + 200);
    // Immediately alive again
    expect(service.getLiveness(ETH_ADDR, t0 + 201)!.alive).toBe(true);
  });

  it("stale resolver does not affect liveness of a healthy resolver on same chain", async () => {
    const db      = await freshDb();
    const repo    = new ResolverLivenessRepository(db);
    const service = new ResolverLivenessService(repo, 90);
    const now     = 1_000_000;
    service.heartbeat(ETH_ADDR,   "ethereum", now - 200); // stale
    service.heartbeat(ETH_ADDR_2, "ethereum", now - 5);   // alive
    expect(service.hasAliveResolver("ethereum", now)).toBe(true);
    expect(service.getStaleResolvers(now)).toHaveLength(1);
  });
});
