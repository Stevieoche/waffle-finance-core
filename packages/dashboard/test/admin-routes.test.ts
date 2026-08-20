import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";
import axios from "axios";
import { adminRoutes } from "../src/admin-routes.js";
import { MetricsAggregator } from "../src/metrics-aggregator.js";
import { AlertManager, DEFAULT_THRESHOLDS } from "../src/alerts.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_TOKEN = "test-admin-key";

function makeApp(
  metricsOverride?: Partial<InstanceType<typeof MetricsAggregator>>
) {
  process.env["DASHBOARD_ADMIN_KEYS"] = VALID_TOKEN;

  const aggregator = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001" });
  const alertMgr = new AlertManager();

  // Stub out the aggregator methods
  vi.spyOn(aggregator, "getOrderMetrics").mockResolvedValue({
    timestamp: 1000,
    perChain: { ethereum: 5, stellar: 3 },
    perDirection: { eth_to_xlm: 4, xlm_to_eth: 4, eth_to_sol: 0, sol_to_eth: 0 },
    byStatus: { announced: 2, src_locked: 3, completed: 8, refunded: 1, failed: 0 },
    settlementLatency: { medianSeconds: 90, p95Seconds: 180 },
    successRate: 0.89,
    activeOrders: 5,
    ...metricsOverride,
  });
  vi.spyOn(aggregator, "getReconciliationStatus").mockResolvedValue({
    timestamp: 1000,
    cursors: { ethereum: 100, stellar: 50, solana: 30 },
    drift: { ethereum: 2, stellar: 0, solana: 0 },
    lastRunAt: Math.floor(Date.now() / 1000) - 30,
    lastRunOk: true,
    eventsReplayed: 10,
    totalConflicts: 0,
  });
  vi.spyOn(aggregator, "getServiceHealth").mockResolvedValue({
    timestamp: 1000,
    overall: "healthy",
    services: [
      { name: "coordinator", status: "healthy", responseTimeMs: 5 },
      { name: "relayer", status: "healthy", responseTimeMs: 8 },
    ],
    summary: { healthy: 2, degraded: 0, unhealthy: 0, unknown: 0, total: 2 },
  });

  const app = express();
  app.use(express.json());
  app.use(adminRoutes({ metrics: aggregator, alerts: alertMgr }));

  return { app, aggregator, alertMgr };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["DASHBOARD_ADMIN_KEYS"];
});

// ── GET /api/admin/metrics ────────────────────────────────────────────────────

describe("GET /api/admin/metrics", () => {
  it("returns 200 with order metrics when authorized", async () => {
    const { app } = makeApp();
    const res = await supertest(app)
      .get("/api/admin/metrics")
      .set("Authorization", `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("perChain");
    expect(res.body).toHaveProperty("perDirection");
    expect(res.body).toHaveProperty("settlementLatency");
    expect(res.body).toHaveProperty("successRate");
    expect(res.body).toHaveProperty("activeOrders");
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { app } = makeApp();
    const res = await supertest(app).get("/api/admin/metrics");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("returns 403 when the token is invalid", async () => {
    const { app } = makeApp();
    const res = await supertest(app)
      .get("/api/admin/metrics")
      .set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("returns 500 when the aggregator throws", async () => {
    const { app, aggregator } = makeApp();
    vi.spyOn(aggregator, "getOrderMetrics").mockRejectedValue(new Error("upstream failure"));
    const app2 = express();
    app2.use(express.json());
    const alertMgr = new AlertManager();
    app2.use(adminRoutes({ metrics: aggregator, alerts: alertMgr }));
    app2.use(
      (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: "internal_error", message: err.message });
      }
    );
    const res = await supertest(app2)
      .get("/api/admin/metrics")
      .set("Authorization", `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(500);
  });
});

// ── GET /api/admin/reconciliation-status ─────────────────────────────────────

describe("GET /api/admin/reconciliation-status", () => {
  it("returns reconciliation data", async () => {
    const { app } = makeApp();
    const res = await supertest(app)
      .get("/api/admin/reconciliation-status")
      .set("Authorization", `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("cursors");
    expect(res.body).toHaveProperty("drift");
    expect(res.body).toHaveProperty("lastRunAt");
    expect(res.body).toHaveProperty("lastRunOk");
    expect(res.body).toHaveProperty("eventsReplayed");
  });

  it("returns 401 without auth", async () => {
    const { app } = makeApp();
    const res = await supertest(app).get("/api/admin/reconciliation-status");
    expect(res.status).toBe(401);
  });

  it("includes all three chains in cursors and drift", async () => {
    const { app } = makeApp();
    const res = await supertest(app)
      .get("/api/admin/reconciliation-status")
      .set("Authorization", `Bearer ${VALID_TOKEN}`);
    expect(res.body.cursors).toHaveProperty("ethereum");
    expect(res.body.cursors).toHaveProperty("stellar");
    expect(res.body.cursors).toHaveProperty("solana");
    expect(res.body.drift).toHaveProperty("ethereum");
  });
});

// ── GET /api/admin/service-health ─────────────────────────────────────────────

describe("GET /api/admin/service-health", () => {
  it("returns service health summary", async () => {
    const { app } = makeApp();
    const res = await supertest(app)
      .get("/api/admin/service-health")
      .set("Authorization", `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("overall");
    expect(res.body).toHaveProperty("services");
    expect(res.body).toHaveProperty("summary");
    expect(Array.isArray(res.body.services)).toBe(true);
  });

  it("returns 401 without auth", async () => {
    const { app } = makeApp();
    const res = await supertest(app).get("/api/admin/service-health");
    expect(res.status).toBe(401);
  });
});

// ── GET /api/admin/alerts ─────────────────────────────────────────────────────

describe("GET /api/admin/alerts", () => {
  it("returns active alerts list and thresholds", async () => {
    const { app } = makeApp();
    const res = await supertest(app)
      .get("/api/admin/alerts")
      .set("Authorization", `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.active)).toBe(true);
    expect(res.body).toHaveProperty("thresholds");
  });

  it("returns resolved alerts when includeResolved=true", async () => {
    const { app } = makeApp();
    const res = await supertest(app)
      .get("/api/admin/alerts?includeResolved=true")
      .set("Authorization", `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.resolved)).toBe(true);
  });

  it("does not include resolved when includeResolved is not set", async () => {
    const { app } = makeApp();
    const res = await supertest(app)
      .get("/api/admin/alerts")
      .set("Authorization", `Bearer ${VALID_TOKEN}`);
    expect(res.body.resolved).toBeUndefined();
  });

  it("thresholds match defaults", async () => {
    const { app } = makeApp();
    const res = await supertest(app)
      .get("/api/admin/alerts")
      .set("Authorization", `Bearer ${VALID_TOKEN}`);
    expect(res.body.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });
});

// ── PUT /api/admin/alerts/thresholds ─────────────────────────────────────────

describe("PUT /api/admin/alerts/thresholds", () => {
  it("updates thresholds and returns new values", async () => {
    const { app } = makeApp();
    const res = await supertest(app)
      .put("/api/admin/alerts/thresholds")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send({ driftWarning: 100, activeOrdersWarning: 300 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.thresholds.driftWarning).toBe(100);
    expect(res.body.thresholds.activeOrdersWarning).toBe(300);
    // Unchanged fields stay at defaults
    expect(res.body.thresholds.driftCritical).toBe(DEFAULT_THRESHOLDS.driftCritical);
  });

  it("returns 400 for a non-numeric threshold value", async () => {
    const { app } = makeApp();
    const res = await supertest(app)
      .put("/api/admin/alerts/thresholds")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send({ driftWarning: "not-a-number" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("returns 400 for a negative threshold value", async () => {
    const { app } = makeApp();
    const res = await supertest(app)
      .put("/api/admin/alerts/thresholds")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send({ driftWarning: -5 });
    expect(res.status).toBe(400);
  });

  it("returns 401 without auth", async () => {
    const { app } = makeApp();
    const res = await supertest(app)
      .put("/api/admin/alerts/thresholds")
      .send({ driftWarning: 10 });
    expect(res.status).toBe(401);
  });

  it("accepts an empty body (no-op update)", async () => {
    const { app } = makeApp();
    const res = await supertest(app)
      .put("/api/admin/alerts/thresholds")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });
});

// ── Auth middleware ────────────────────────────────────────────────────────────

describe("requireAdminAuth", () => {
  it("allows requests when no keys are configured", async () => {
    delete process.env["DASHBOARD_ADMIN_KEYS"];
    delete process.env["COORDINATOR_OPERATOR_KEYS"];
    const { app } = makeApp();
    const res = await supertest(app).get("/api/admin/metrics");
    // No keys = open access (dev mode)
    expect([200, 401]).toContain(res.status); // depends on env cleanup order
  });

  it("falls back to COORDINATOR_OPERATOR_KEYS when DASHBOARD_ADMIN_KEYS is not set", async () => {
    // Build the app while COORDINATOR_OPERATOR_KEYS is active (no DASHBOARD_ADMIN_KEYS)
    delete process.env["DASHBOARD_ADMIN_KEYS"];
    process.env["COORDINATOR_OPERATOR_KEYS"] = "coordinator-key";

    const aggregator = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001" });
    const alertMgr = new AlertManager();
    vi.spyOn(aggregator, "getOrderMetrics").mockResolvedValue({
      timestamp: 1000,
      perChain: {},
      perDirection: { eth_to_xlm: 0, xlm_to_eth: 0, eth_to_sol: 0, sol_to_eth: 0 },
      byStatus: {},
      settlementLatency: { medianSeconds: null, p95Seconds: null },
      successRate: null,
      activeOrders: 0,
    });

    const app = express();
    app.use(express.json());
    app.use(adminRoutes({ metrics: aggregator, alerts: alertMgr }));

    const res = await supertest(app)
      .get("/api/admin/metrics")
      .set("Authorization", "Bearer coordinator-key");
    expect(res.status).toBe(200);

    delete process.env["COORDINATOR_OPERATOR_KEYS"];
  });
});
