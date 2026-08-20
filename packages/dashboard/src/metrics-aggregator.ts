import axios from "axios";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Direction = "eth_to_xlm" | "xlm_to_eth" | "eth_to_sol" | "sol_to_eth";
export type Chain = "ethereum" | "stellar" | "solana";

export interface OrderMetrics {
  /** Snapshot timestamp (unix ms) */
  timestamp: number;
  /** Total orders per chain (src chain) */
  perChain: Record<string, number>;
  /** Total orders per direction */
  perDirection: Record<Direction, number>;
  /** Breakdown by status */
  byStatus: Record<string, number>;
  /** Settlement latency: median & p95 in seconds (from Prometheus) */
  settlementLatency: {
    medianSeconds: number | null;
    p95Seconds: number | null;
  };
  /** Success rate 0–1 (completed / (completed + refunded + failed)) */
  successRate: number | null;
  /** Active in-flight orders */
  activeOrders: number;
}

export interface ReconciliationStatus {
  timestamp: number;
  /** Reconciliation cursor per chain (last processed block/slot/ledger) */
  cursors: Record<Chain, number>;
  /** Drift in blocks/slots/ledger per chain (head - cursor) */
  drift: Record<Chain, number>;
  /** Unix seconds of the last reconciliation run, or null if never */
  lastRunAt: number | null;
  /** Whether the last run succeeded */
  lastRunOk: boolean | null;
  /** Total events replayed in the last run */
  eventsReplayed: number;
  /** Total conflicts detected overall */
  totalConflicts: number;
}

export interface ServiceHealthDetail {
  name: string;
  status: "healthy" | "degraded" | "unhealthy" | "unknown";
  responseTimeMs: number;
  uptime?: number;
  version?: string;
  error?: string;
  checks?: Array<{ name: string; ok: boolean; detail?: string }>;
}

export interface ServiceHealthSummary {
  timestamp: number;
  overall: "healthy" | "degraded" | "unhealthy";
  services: ServiceHealthDetail[];
  summary: {
    healthy: number;
    degraded: number;
    unhealthy: number;
    unknown: number;
    total: number;
  };
}

// ─── Prometheus metric parser (text exposition format) ────────────────────────

interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parsePrometheusText(text: string): PromSample[] {
  const samples: PromSample[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // metric_name{label="value",...} numeric [timestamp]
    const braceOpen = trimmed.indexOf("{");
    const braceClose = trimmed.indexOf("}");
    let metricName: string;
    let labelsStr = "";
    let valueStr: string;

    if (braceOpen !== -1 && braceClose !== -1) {
      metricName = trimmed.slice(0, braceOpen);
      labelsStr = trimmed.slice(braceOpen + 1, braceClose);
      valueStr = trimmed.slice(braceClose + 2).split(" ")[0]!;
    } else {
      const parts = trimmed.split(" ");
      metricName = parts[0]!;
      valueStr = parts[1]!;
    }

    const value = parseFloat(valueStr ?? "NaN");
    if (Number.isNaN(value)) continue;

    const labels: Record<string, string> = {};
    if (labelsStr) {
      for (const part of labelsStr.split(",")) {
        const eqIdx = part.indexOf("=");
        if (eqIdx === -1) continue;
        const k = part.slice(0, eqIdx).trim();
        const v = part
          .slice(eqIdx + 1)
          .trim()
          .replace(/^"|"$/g, "");
        labels[k] = v;
      }
    }

    samples.push({ name: metricName, labels, value });
  }
  return samples;
}

function samplesFor(samples: PromSample[], name: string): PromSample[] {
  return samples.filter((s) => s.name === name);
}

function sumSamples(samples: PromSample[]): number {
  return samples.reduce((acc, s) => acc + s.value, 0);
}

// ─── MetricsAggregator ────────────────────────────────────────────────────────

export interface MetricsAggregatorConfig {
  /** Base URL of the coordinator service, e.g. http://localhost:3001 */
  coordinatorUrl: string;
  /** Base URLs of other services: relayer, resolver */
  serviceUrls?: Record<string, string>;
  /** How long to cache a metrics fetch result (ms). Default 60 000. */
  cacheTtlMs?: number;
  /** Request timeout for coordinator metrics (ms). Default 5 000. */
  timeoutMs?: number;
}

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

export class MetricsAggregator {
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly coordinatorUrl: string;
  private readonly serviceUrls: Record<string, string>;

  private metricsCache: CacheEntry<OrderMetrics> | null = null;
  private reconciliationCache: CacheEntry<ReconciliationStatus> | null = null;
  private serviceHealthCache: CacheEntry<ServiceHealthSummary> | null = null;

  constructor(config: MetricsAggregatorConfig) {
    this.coordinatorUrl = config.coordinatorUrl.replace(/\/$/, "");
    this.serviceUrls = config.serviceUrls ?? {};
    this.cacheTtlMs = config.cacheTtlMs ?? 60_000;
    this.timeoutMs = config.timeoutMs ?? 5_000;
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private isFresh<T>(entry: CacheEntry<T> | null): boolean {
    if (!entry) return false;
    return Date.now() - entry.fetchedAt < this.cacheTtlMs;
  }

  private async fetchPrometheusMetrics(): Promise<PromSample[]> {
    const resp = await axios.get(`${this.coordinatorUrl}/metrics`, {
      timeout: this.timeoutMs,
      responseType: "text",
      validateStatus: () => true,
    });
    if (resp.status !== 200) {
      throw new Error(`Coordinator metrics returned HTTP ${resp.status}`);
    }
    return parsePrometheusText(resp.data as string);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Fetch and aggregate order metrics from the coordinator's Prometheus
   * endpoint. Result is cached for `cacheTtlMs`.
   */
  async getOrderMetrics(): Promise<OrderMetrics> {
    if (this.isFresh(this.metricsCache)) {
      return this.metricsCache!.data;
    }

    const samples = await this.fetchPrometheusMetrics();
    const now = Date.now();

    // Orders per chain — use active orders gauge + total counter
    const perChain: Record<string, number> = {};
    for (const s of samplesFor(samples, "coordinator_orders_total")) {
      const chain = s.labels["direction"]?.split("_to_")[0] ?? "unknown";
      perChain[chain] = (perChain[chain] ?? 0) + s.value;
    }

    // Per direction
    const perDirection: Partial<Record<Direction, number>> = {};
    for (const s of samplesFor(samples, "coordinator_orders_total")) {
      const dir = s.labels["direction"] as Direction | undefined;
      if (dir) {
        perDirection[dir] = (perDirection[dir] ?? 0) + s.value;
      }
    }

    // By status
    const byStatus: Record<string, number> = {};
    for (const s of samplesFor(samples, "coordinator_order_current_state")) {
      const state = s.labels["state"];
      if (state) {
        byStatus[state] = (byStatus[state] ?? 0) + s.value;
      }
    }

    // Settlement latency — swap duration histogram quantiles
    let medianSeconds: number | null = null;
    let p95Seconds: number | null = null;
    for (const s of samplesFor(samples, "coordinator_swap_duration_seconds")) {
      if (s.labels["quantile"] === "0.5") medianSeconds = s.value;
      if (s.labels["quantile"] === "0.95") p95Seconds = s.value;
    }

    // Success rate: completed / (completed + refunded + failed)
    let completed = 0;
    let refunded = 0;
    let failed = 0;
    for (const s of samplesFor(samples, "coordinator_orders_total")) {
      const status = s.labels["status"];
      if (status === "completed") completed += s.value;
      else if (status === "refunded") refunded += s.value;
      else if (status === "failed") failed += s.value;
    }
    const terminal = completed + refunded + failed;
    const successRate = terminal > 0 ? completed / terminal : null;

    // Active orders
    const activeOrders = sumSamples(samplesFor(samples, "coordinator_active_orders"));

    const data: OrderMetrics = {
      timestamp: now,
      perChain,
      perDirection: perDirection as Record<Direction, number>,
      byStatus,
      settlementLatency: { medianSeconds, p95Seconds },
      successRate,
      activeOrders,
    };

    this.metricsCache = { data, fetchedAt: now };
    return data;
  }

  /**
   * Fetch reconciliation status from coordinator metrics.
   * Cursor, drift, and run metadata are parsed from Prometheus gauges/counters.
   */
  async getReconciliationStatus(): Promise<ReconciliationStatus> {
    if (this.isFresh(this.reconciliationCache)) {
      return this.reconciliationCache!.data;
    }

    const samples = await this.fetchPrometheusMetrics();
    const now = Date.now();

    const chains: Chain[] = ["ethereum", "stellar", "solana"];
    const cursors: Record<Chain, number> = { ethereum: 0, stellar: 0, solana: 0 };
    const drift: Record<Chain, number> = { ethereum: 0, stellar: 0, solana: 0 };

    for (const s of samplesFor(samples, "coordinator_listener_last_block")) {
      const chain = s.labels["chain"] as Chain | undefined;
      if (chain && chains.includes(chain)) {
        cursors[chain] = s.value;
      }
    }
    for (const s of samplesFor(samples, "coordinator_listener_lag_blocks")) {
      const chain = s.labels["chain"] as Chain | undefined;
      if (chain && chains.includes(chain)) {
        drift[chain] = s.value;
      }
    }

    // Last reconciliation run timestamp
    let lastRunAt: number | null = null;
    for (const s of samplesFor(
      samples,
      "coordinator_reconciliation_last_run_timestamp_seconds"
    )) {
      if (s.value > 0) lastRunAt = s.value;
    }

    // Last run ok: infer from reconciliation_runs_total labels
    let lastRunOk: boolean | null = null;
    let successRuns = 0;
    let failureRuns = 0;
    for (const s of samplesFor(samples, "coordinator_reconciliation_runs_total")) {
      if (s.labels["result"] === "success") successRuns += s.value;
      if (s.labels["result"] === "failure") failureRuns += s.value;
    }
    if (successRuns + failureRuns > 0) {
      // Approximate: if more successes than failures, last was probably ok
      lastRunOk = successRuns >= failureRuns;
    }

    const eventsReplayed = sumSamples(
      samplesFor(samples, "coordinator_reconciliation_events_replayed_total")
    );
    const totalConflicts = sumSamples(
      samplesFor(samples, "coordinator_reconciliation_conflicts_total")
    );

    const data: ReconciliationStatus = {
      timestamp: now,
      cursors,
      drift,
      lastRunAt,
      lastRunOk,
      eventsReplayed,
      totalConflicts,
    };

    this.reconciliationCache = { data, fetchedAt: now };
    return data;
  }

  /**
   * Fetch health status for all registered services. Falls back to the
   * coordinator's own /health endpoint plus any configured service URLs.
   */
  async getServiceHealth(): Promise<ServiceHealthSummary> {
    if (this.isFresh(this.serviceHealthCache)) {
      return this.serviceHealthCache!.data;
    }

    const now = Date.now();

    // Always include coordinator
    const targets: Array<{ name: string; url: string }> = [
      { name: "coordinator", url: this.coordinatorUrl },
      ...Object.entries(this.serviceUrls).map(([name, url]) => ({
        name,
        url: url.replace(/\/$/, ""),
      })),
    ];

    const services: ServiceHealthDetail[] = await Promise.all(
      targets.map(async ({ name, url }) => {
        const start = Date.now();
        try {
          const resp = await axios.get(`${url}/health`, {
            timeout: this.timeoutMs,
            validateStatus: () => true,
          });
          const d = resp.data as Record<string, unknown>;
          const httpStatus = resp.status ?? 200;
          let status: ServiceHealthDetail["status"];
          if (httpStatus >= 500) {
            status = "unhealthy";
          } else if (d["status"] === "ok" || d["status"] === "healthy") {
            status = "healthy";
          } else if (d["status"] === "degraded") {
            status = "degraded";
          } else {
            status = "unknown";
          }
          return {
            name,
            status,
            responseTimeMs: Date.now() - start,
            uptime: (d["uptime"] ?? d["uptimeSeconds"]) as number | undefined,
            version: d["version"] as string | undefined,
            checks: d["checks"] as ServiceHealthDetail["checks"],
          };
        } catch (err) {
          return {
            name,
            status: "unhealthy" as const,
            responseTimeMs: Date.now() - start,
            error: err instanceof Error ? err.message : "Unknown error",
          };
        }
      })
    );

    const summary = services.reduce(
      (acc, s) => ({
        ...acc,
        [s.status]: (acc[s.status as keyof typeof acc] as number) + 1,
        total: acc.total + 1,
      }),
      { healthy: 0, degraded: 0, unhealthy: 0, unknown: 0, total: 0 }
    );

    let overall: ServiceHealthSummary["overall"] = "healthy";
    if (summary.unhealthy > 0) overall = "unhealthy";
    else if (summary.degraded > 0) overall = "degraded";

    const data: ServiceHealthSummary = {
      timestamp: now,
      overall,
      services,
      summary,
    };

    this.serviceHealthCache = { data, fetchedAt: now };
    return data;
  }

  /** Invalidate all caches — useful for testing. */
  invalidateCache(): void {
    this.metricsCache = null;
    this.reconciliationCache = null;
    this.serviceHealthCache = null;
  }
}
