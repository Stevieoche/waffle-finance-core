import { describe, it, expect, vi, afterEach } from "vitest";
import axios from "axios";
import { MetricsAggregator } from "../src/metrics-aggregator.js";

// Minimal Prometheus text that covers all fields the aggregator reads
const SAMPLE_PROM_TEXT = `
# HELP coordinator_orders_total Total number of orders by status and direction
# TYPE coordinator_orders_total counter
coordinator_orders_total{status="completed",direction="eth_to_xlm"} 80
coordinator_orders_total{status="refunded",direction="eth_to_xlm"} 10
coordinator_orders_total{status="failed",direction="eth_to_xlm"} 5
coordinator_orders_total{status="announced",direction="xlm_to_eth"} 3
coordinator_active_orders{direction="eth_to_xlm"} 15
coordinator_active_orders{direction="xlm_to_eth"} 5
coordinator_order_current_state{direction="eth_to_xlm",state="announced"} 3
coordinator_order_current_state{direction="eth_to_xlm",state="src_locked"} 5
coordinator_order_current_state{direction="eth_to_xlm",state="completed"} 80
coordinator_swap_duration_seconds{quantile="0.5",direction="eth_to_xlm",outcome="completed"} 120
coordinator_swap_duration_seconds{quantile="0.95",direction="eth_to_xlm",outcome="completed"} 300
coordinator_listener_last_block{chain="ethereum"} 1000
coordinator_listener_last_block{chain="stellar"} 500
coordinator_listener_last_block{chain="solana"} 300
coordinator_listener_lag_blocks{chain="ethereum"} 2
coordinator_listener_lag_blocks{chain="stellar"} 0
coordinator_listener_lag_blocks{chain="solana"} 5
coordinator_reconciliation_last_run_timestamp_seconds 1700000000
coordinator_reconciliation_runs_total{result="success"} 10
coordinator_reconciliation_runs_total{result="failure"} 1
coordinator_reconciliation_events_replayed_total 42
coordinator_reconciliation_conflicts_total{chain="ethereum",conflict_type="chain_ahead"} 3
`.trim();

function stubAxiosGet(text = SAMPLE_PROM_TEXT) {
  return vi.spyOn(axios, "get").mockResolvedValue({ status: 200, data: text });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MetricsAggregator.getOrderMetrics", () => {
  it("parses order counts per chain", async () => {
    stubAxiosGet();
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001" });
    const metrics = await agg.getOrderMetrics();
    // eth from direction eth_to_xlm and xlm_to_eth
    expect(metrics.perChain["eth"]).toBeGreaterThan(0);
  });

  it("parses per-direction counts", async () => {
    stubAxiosGet();
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001" });
    const metrics = await agg.getOrderMetrics();
    expect(metrics.perDirection["eth_to_xlm"]).toBeGreaterThan(0);
  });

  it("parses settlement latency quantiles", async () => {
    stubAxiosGet();
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001" });
    const metrics = await agg.getOrderMetrics();
    expect(metrics.settlementLatency.medianSeconds).toBe(120);
    expect(metrics.settlementLatency.p95Seconds).toBe(300);
  });

  it("computes success rate correctly", async () => {
    stubAxiosGet();
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001" });
    const metrics = await agg.getOrderMetrics();
    // 80 completed / (80+10+5) = 0.842...
    expect(metrics.successRate).toBeCloseTo(80 / 95, 3);
  });

  it("calculates total active orders", async () => {
    stubAxiosGet();
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001" });
    const metrics = await agg.getOrderMetrics();
    expect(metrics.activeOrders).toBe(20); // 15 + 5
  });

  it("caches results within TTL", async () => {
    const spy = stubAxiosGet();
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001", cacheTtlMs: 60_000 });
    await agg.getOrderMetrics();
    await agg.getOrderMetrics();
    // Should have only fetched once
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refetches after cache expires", async () => {
    const spy = stubAxiosGet();
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001", cacheTtlMs: 0 });
    await agg.getOrderMetrics();
    await agg.getOrderMetrics();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("throws when coordinator metrics endpoint returns non-200", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({ status: 500, data: "" });
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001" });
    await expect(agg.getOrderMetrics()).rejects.toThrow("HTTP 500");
  });
});

describe("MetricsAggregator.getReconciliationStatus", () => {
  it("parses chain cursors", async () => {
    stubAxiosGet();
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001" });
    const status = await agg.getReconciliationStatus();
    expect(status.cursors.ethereum).toBe(1000);
    expect(status.cursors.stellar).toBe(500);
    expect(status.cursors.solana).toBe(300);
  });

  it("parses chain drift", async () => {
    stubAxiosGet();
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001" });
    const status = await agg.getReconciliationStatus();
    expect(status.drift.ethereum).toBe(2);
    expect(status.drift.stellar).toBe(0);
    expect(status.drift.solana).toBe(5);
  });

  it("parses lastRunAt", async () => {
    stubAxiosGet();
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001" });
    const status = await agg.getReconciliationStatus();
    expect(status.lastRunAt).toBe(1_700_000_000);
  });

  it("infers lastRunOk from success/failure counts", async () => {
    stubAxiosGet();
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001" });
    const status = await agg.getReconciliationStatus();
    expect(status.lastRunOk).toBe(true); // 10 success >= 1 failure
  });

  it("totals replayed events and conflicts", async () => {
    stubAxiosGet();
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001" });
    const status = await agg.getReconciliationStatus();
    expect(status.eventsReplayed).toBe(42);
    expect(status.totalConflicts).toBe(3);
  });

  it("invalidates cache on demand", async () => {
    const spy = stubAxiosGet();
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001", cacheTtlMs: 60_000 });
    await agg.getReconciliationStatus();
    agg.invalidateCache();
    await agg.getReconciliationStatus();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("MetricsAggregator.getServiceHealth", () => {
  it("fetches health for coordinator", async () => {
    vi.spyOn(axios, "get").mockImplementation((url: string) => {
      if (url.endsWith("/health")) {
        return Promise.resolve({
          status: 200,
          data: { status: "ok", uptime: 999 },
        });
      }
      return Promise.resolve({ status: 200, data: "" });
    });
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001" });
    const summary = await agg.getServiceHealth();
    expect(summary.services).toHaveLength(1);
    expect(summary.services[0]!.name).toBe("coordinator");
    expect(summary.services[0]!.status).toBe("healthy");
    expect(summary.overall).toBe("healthy");
  });

  it("marks service unhealthy when health endpoint throws", async () => {
    vi.spyOn(axios, "get").mockRejectedValue(new Error("ECONNREFUSED"));
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001" });
    const summary = await agg.getServiceHealth();
    expect(summary.services[0]!.status).toBe("unhealthy");
    expect(summary.overall).toBe("unhealthy");
  });

  it("includes additional service URLs", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: { status: "ok" },
    });
    const agg = new MetricsAggregator({
      coordinatorUrl: "http://coordinator:3001",
      serviceUrls: {
        relayer: "http://relayer:3002",
        resolver: "http://resolver:3003",
      },
    });
    const summary = await agg.getServiceHealth();
    expect(summary.services).toHaveLength(3);
    const names = summary.services.map((s) => s.name);
    expect(names).toContain("coordinator");
    expect(names).toContain("relayer");
    expect(names).toContain("resolver");
  });

  it("normalizes 'ok' status to 'healthy'", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({ status: 200, data: { status: "ok" } });
    const agg = new MetricsAggregator({ coordinatorUrl: "http://coordinator:3001" });
    const summary = await agg.getServiceHealth();
    expect(summary.services[0]!.status).toBe("healthy");
  });
});
