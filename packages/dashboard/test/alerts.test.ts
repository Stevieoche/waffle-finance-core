import { describe, it, expect, beforeEach } from "vitest";
import { AlertManager, DEFAULT_THRESHOLDS } from "../src/alerts.js";
import type { OrderMetrics, ReconciliationStatus, ServiceHealthSummary } from "../src/metrics-aggregator.js";

function makeMetrics(overrides: Partial<OrderMetrics> = {}): OrderMetrics {
  return {
    timestamp: Date.now(),
    perChain: { ethereum: 10, stellar: 5 },
    perDirection: { eth_to_xlm: 8, xlm_to_eth: 7, eth_to_sol: 0, sol_to_eth: 0 },
    byStatus: { announced: 3, src_locked: 5, completed: 10, refunded: 0, failed: 0 },
    settlementLatency: { medianSeconds: 60, p95Seconds: 120 },
    successRate: 1.0,
    activeOrders: 10,
    ...overrides,
  };
}

function makeReconciliation(overrides: Partial<ReconciliationStatus> = {}): ReconciliationStatus {
  return {
    timestamp: Date.now(),
    cursors: { ethereum: 1000, stellar: 500, solana: 300 },
    drift: { ethereum: 0, stellar: 0, solana: 0 },
    lastRunAt: Math.floor(Date.now() / 1000) - 60, // 1 min ago
    lastRunOk: true,
    eventsReplayed: 5,
    totalConflicts: 0,
    ...overrides,
  };
}

function makeServiceHealth(overrides: Partial<ServiceHealthSummary> = {}): ServiceHealthSummary {
  return {
    timestamp: Date.now(),
    overall: "healthy",
    services: [
      { name: "coordinator", status: "healthy", responseTimeMs: 12 },
      { name: "relayer", status: "healthy", responseTimeMs: 8 },
    ],
    summary: { healthy: 2, degraded: 0, unhealthy: 0, unknown: 0, total: 2 },
    ...overrides,
  };
}

describe("AlertManager — thresholds", () => {
  it("returns default thresholds", () => {
    const mgr = new AlertManager();
    expect(mgr.getThresholds()).toEqual(DEFAULT_THRESHOLDS);
  });

  it("merges a partial threshold update", () => {
    const mgr = new AlertManager();
    const updated = mgr.updateThresholds({ driftWarning: 100 });
    expect(updated.driftWarning).toBe(100);
    expect(updated.driftCritical).toBe(DEFAULT_THRESHOLDS.driftCritical);
  });

  it("preserves existing thresholds across multiple updates", () => {
    const mgr = new AlertManager();
    mgr.updateThresholds({ driftWarning: 75 });
    const final = mgr.updateThresholds({ activeOrdersWarning: 300 });
    expect(final.driftWarning).toBe(75);
    expect(final.activeOrdersWarning).toBe(300);
  });
});

describe("AlertManager — order metrics", () => {
  let mgr: AlertManager;
  beforeEach(() => {
    mgr = new AlertManager();
  });

  it("fires no alerts when metrics are healthy", () => {
    mgr.evaluateOrderMetrics(makeMetrics());
    expect(mgr.getActiveAlerts()).toHaveLength(0);
  });

  it("fires warning alert when active orders exceed warning threshold", () => {
    mgr.evaluateOrderMetrics(makeMetrics({ activeOrders: DEFAULT_THRESHOLDS.activeOrdersWarning + 1 }));
    const alerts = mgr.getActiveAlerts();
    const alert = alerts.find((a) => a.id === "active_orders");
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("warning");
  });

  it("fires critical alert when active orders exceed critical threshold", () => {
    mgr.evaluateOrderMetrics(makeMetrics({ activeOrders: DEFAULT_THRESHOLDS.activeOrdersCritical + 1 }));
    const alerts = mgr.getActiveAlerts();
    const alert = alerts.find((a) => a.id === "active_orders");
    expect(alert!.severity).toBe("critical");
  });

  it("fires warning when success rate drops below warning threshold", () => {
    mgr.evaluateOrderMetrics(makeMetrics({ successRate: DEFAULT_THRESHOLDS.successRateWarning - 0.05 }));
    const alert = mgr.getActiveAlerts().find((a) => a.id === "success_rate");
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("warning");
  });

  it("fires critical when success rate drops below critical threshold", () => {
    mgr.evaluateOrderMetrics(makeMetrics({ successRate: DEFAULT_THRESHOLDS.successRateCritical - 0.05 }));
    const alert = mgr.getActiveAlerts().find((a) => a.id === "success_rate");
    expect(alert!.severity).toBe("critical");
  });

  it("does not duplicate an already-active alert", () => {
    const highLoad = makeMetrics({ activeOrders: DEFAULT_THRESHOLDS.activeOrdersCritical + 1 });
    mgr.evaluateOrderMetrics(highLoad);
    mgr.evaluateOrderMetrics(highLoad);
    const alerts = mgr.getActiveAlerts().filter((a) => a.id === "active_orders");
    expect(alerts).toHaveLength(1);
  });

  it("resolves an alert when condition clears", () => {
    mgr.evaluateOrderMetrics(makeMetrics({ activeOrders: DEFAULT_THRESHOLDS.activeOrdersCritical + 1 }));
    expect(mgr.getActiveAlerts()).toHaveLength(1);
    mgr.evaluateOrderMetrics(makeMetrics({ activeOrders: 1 }));
    expect(mgr.getActiveAlerts()).toHaveLength(0);
    expect(mgr.getResolvedAlerts()).toHaveLength(1);
  });

  it("fires settlement latency warning", () => {
    mgr.evaluateOrderMetrics(
      makeMetrics({
        settlementLatency: {
          medianSeconds: DEFAULT_THRESHOLDS.settlementLatencyWarning + 1,
          p95Seconds: null,
        },
      })
    );
    const alert = mgr.getActiveAlerts().find((a) => a.id === "settlement_latency");
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("warning");
  });

  it("skips success rate check when successRate is null", () => {
    mgr.evaluateOrderMetrics(makeMetrics({ successRate: null }));
    expect(mgr.getActiveAlerts().some((a) => a.id === "success_rate")).toBe(false);
  });
});

describe("AlertManager — reconciliation", () => {
  let mgr: AlertManager;
  beforeEach(() => {
    mgr = new AlertManager();
  });

  it("fires no alerts when reconciliation is fresh", () => {
    mgr.evaluateReconciliation(makeReconciliation());
    expect(mgr.getActiveAlerts()).toHaveLength(0);
  });

  it("fires warning when reconciliation is stale", () => {
    const staleSeconds = DEFAULT_THRESHOLDS.reconciliationStalenessWarning + 10;
    mgr.evaluateReconciliation(
      makeReconciliation({ lastRunAt: Math.floor(Date.now() / 1000) - staleSeconds })
    );
    const alert = mgr.getActiveAlerts().find((a) => a.id === "reconciliation_staleness");
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("warning");
  });

  it("fires critical when reconciliation is critically stale", () => {
    const staleSeconds = DEFAULT_THRESHOLDS.reconciliationStalenessCritical + 10;
    mgr.evaluateReconciliation(
      makeReconciliation({ lastRunAt: Math.floor(Date.now() / 1000) - staleSeconds })
    );
    const alert = mgr.getActiveAlerts().find((a) => a.id === "reconciliation_staleness");
    expect(alert!.severity).toBe("critical");
  });

  it("fires drift alert per chain", () => {
    mgr.evaluateReconciliation(
      makeReconciliation({
        drift: {
          ethereum: DEFAULT_THRESHOLDS.driftWarning + 1,
          stellar: 0,
          solana: 0,
        },
      })
    );
    const alert = mgr.getActiveAlerts().find((a) => a.id === "chain_drift_ethereum");
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("warning");
  });

  it("fires critical drift alert", () => {
    mgr.evaluateReconciliation(
      makeReconciliation({
        drift: {
          ethereum: DEFAULT_THRESHOLDS.driftCritical + 1,
          stellar: 0,
          solana: 0,
        },
      })
    );
    const alert = mgr.getActiveAlerts().find((a) => a.id === "chain_drift_ethereum");
    expect(alert!.severity).toBe("critical");
  });

  it("skips staleness check when lastRunAt is null", () => {
    mgr.evaluateReconciliation(makeReconciliation({ lastRunAt: null }));
    expect(mgr.getActiveAlerts().some((a) => a.id === "reconciliation_staleness")).toBe(false);
  });
});

describe("AlertManager — service health", () => {
  let mgr: AlertManager;
  beforeEach(() => {
    mgr = new AlertManager();
  });

  it("fires no alerts when all services are healthy", () => {
    mgr.evaluateServiceHealth(makeServiceHealth());
    expect(mgr.getActiveAlerts()).toHaveLength(0);
  });

  it("fires critical alert when a service is unhealthy", () => {
    mgr.evaluateServiceHealth(
      makeServiceHealth({
        services: [
          { name: "coordinator", status: "unhealthy", responseTimeMs: 0, error: "ECONNREFUSED" },
          { name: "relayer", status: "healthy", responseTimeMs: 10 },
        ],
      })
    );
    const alert = mgr.getActiveAlerts().find((a) => a.id === "service_unhealthy_coordinator");
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("critical");
  });

  it("fires warning alert when a service is degraded", () => {
    mgr.evaluateServiceHealth(
      makeServiceHealth({
        services: [
          { name: "relayer", status: "degraded", responseTimeMs: 50 },
        ],
      })
    );
    const alert = mgr.getActiveAlerts().find((a) => a.id === "service_degraded_relayer");
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("warning");
  });

  it("resolves service alert when service recovers", () => {
    mgr.evaluateServiceHealth(
      makeServiceHealth({
        services: [{ name: "relayer", status: "unhealthy", responseTimeMs: 0 }],
      })
    );
    expect(mgr.getActiveAlerts().some((a) => a.id === "service_unhealthy_relayer")).toBe(true);
    mgr.evaluateServiceHealth(
      makeServiceHealth({
        services: [{ name: "relayer", status: "healthy", responseTimeMs: 10 }],
      })
    );
    expect(mgr.getActiveAlerts().some((a) => a.id === "service_unhealthy_relayer")).toBe(false);
    expect(mgr.getResolvedAlerts().some((a) => a.id === "service_unhealthy_relayer")).toBe(true);
  });
});

describe("AlertManager — sorting and history", () => {
  it("sorts critical alerts before warnings", () => {
    const mgr = new AlertManager();
    // Fire warning first
    mgr.evaluateOrderMetrics(makeMetrics({ activeOrders: DEFAULT_THRESHOLDS.activeOrdersWarning + 1 }));
    // Then critical
    mgr.evaluateOrderMetrics(makeMetrics({
      activeOrders: DEFAULT_THRESHOLDS.activeOrdersWarning + 1,
      successRate: DEFAULT_THRESHOLDS.successRateCritical - 0.1,
    }));
    const alerts = mgr.getActiveAlerts();
    const severities = alerts.map((a) => a.severity);
    // All criticals should precede warnings
    const firstWarning = severities.indexOf("warning");
    const lastCritical = severities.lastIndexOf("critical");
    if (firstWarning !== -1 && lastCritical !== -1) {
      expect(lastCritical).toBeLessThan(firstWarning);
    }
  });

  it("caps resolved history", () => {
    const mgr = new AlertManager({}, 3);
    for (let i = 0; i < 5; i++) {
      mgr.evaluateOrderMetrics(makeMetrics({ activeOrders: DEFAULT_THRESHOLDS.activeOrdersCritical + 1 }));
      mgr.evaluateOrderMetrics(makeMetrics({ activeOrders: 0 }));
    }
    expect(mgr.getResolvedAlerts().length).toBeLessThanOrEqual(3);
  });
});
