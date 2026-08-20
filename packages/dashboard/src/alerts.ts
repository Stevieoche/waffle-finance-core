import type { OrderMetrics, ReconciliationStatus, ServiceHealthSummary } from "./metrics-aggregator.js";

// ─── Alert types ──────────────────────────────────────────────────────────────

export type AlertSeverity = "critical" | "warning" | "info";

export interface Alert {
  id: string;
  name: string;
  severity: AlertSeverity;
  message: string;
  /** Unix ms when the alert was first detected */
  firedAt: number;
  /** Unix ms when the alert was resolved (null = still active) */
  resolvedAt: number | null;
  /** Which metric or value triggered the alert */
  triggerValue: number | string | null;
  /** The threshold that was breached */
  threshold: number | string | null;
}

// ─── Threshold configuration ──────────────────────────────────────────────────

export interface AlertThresholds {
  /**
   * Max acceptable block drift per chain before a warning fires.
   * Default: 50 blocks (warning), 200 blocks (critical).
   */
  driftWarning: number;
  driftCritical: number;
  /**
   * Minimum acceptable success rate (0–1).
   * Default: 0.9 warning, 0.7 critical.
   */
  successRateWarning: number;
  successRateCritical: number;
  /**
   * Maximum reconciliation gap (seconds since last run) before alerting.
   * Default: 5 min warning, 15 min critical.
   */
  reconciliationStalenessWarning: number;
  reconciliationStalenessCritical: number;
  /**
   * Max active in-flight orders before warning.
   * Default: 500 warning, 1000 critical.
   */
  activeOrdersWarning: number;
  activeOrdersCritical: number;
  /**
   * Max acceptable median settlement latency in seconds.
   * Default: 300s warning, 900s critical.
   */
  settlementLatencyWarning: number;
  settlementLatencyCritical: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  driftWarning: 50,
  driftCritical: 200,
  successRateWarning: 0.9,
  successRateCritical: 0.7,
  reconciliationStalenessWarning: 5 * 60,
  reconciliationStalenessCritical: 15 * 60,
  activeOrdersWarning: 500,
  activeOrdersCritical: 1_000,
  settlementLatencyWarning: 300,
  settlementLatencyCritical: 900,
};

// ─── Alert manager ────────────────────────────────────────────────────────────

export class AlertManager {
  private readonly activeAlerts = new Map<string, Alert>();
  private readonly resolvedAlerts: Alert[] = [];
  /** Cap resolved history to avoid unbounded memory growth */
  private readonly maxResolvedHistory: number;
  private thresholds: AlertThresholds;

  constructor(
    thresholds: Partial<AlertThresholds> = {},
    maxResolvedHistory = 200
  ) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.maxResolvedHistory = maxResolvedHistory;
  }

  // ── Threshold management ────────────────────────────────────────────────────

  getThresholds(): AlertThresholds {
    return { ...this.thresholds };
  }

  updateThresholds(patch: Partial<AlertThresholds>): AlertThresholds {
    this.thresholds = { ...this.thresholds, ...patch };
    return this.getThresholds();
  }

  // ── Alert lifecycle ─────────────────────────────────────────────────────────

  private fire(
    id: string,
    name: string,
    severity: AlertSeverity,
    message: string,
    triggerValue: number | string | null,
    threshold: number | string | null
  ): void {
    if (this.activeAlerts.has(id)) return; // already firing
    this.activeAlerts.set(id, {
      id,
      name,
      severity,
      message,
      firedAt: Date.now(),
      resolvedAt: null,
      triggerValue,
      threshold,
    });
  }

  private resolve(id: string): void {
    const alert = this.activeAlerts.get(id);
    if (!alert) return;
    const resolved: Alert = { ...alert, resolvedAt: Date.now() };
    this.activeAlerts.delete(id);
    this.resolvedAlerts.unshift(resolved);
    if (this.resolvedAlerts.length > this.maxResolvedHistory) {
      this.resolvedAlerts.length = this.maxResolvedHistory;
    }
  }

  private resolveIfPresent(id: string): void {
    if (this.activeAlerts.has(id)) this.resolve(id);
  }

  // ── Detection passes ────────────────────────────────────────────────────────

  evaluateOrderMetrics(metrics: OrderMetrics): void {
    const t = this.thresholds;

    // Active orders
    this.checkThreshold(
      "active_orders",
      "High active order count",
      metrics.activeOrders,
      t.activeOrdersWarning,
      t.activeOrdersCritical,
      (v) => `${v} orders in flight`
    );

    // Success rate
    if (metrics.successRate !== null) {
      const rate = metrics.successRate;
      const rateId = "success_rate";
      if (rate < t.successRateCritical) {
        this.fire(
          rateId,
          "Low success rate",
          "critical",
          `Success rate ${(rate * 100).toFixed(1)}% is below critical threshold ${(t.successRateCritical * 100).toFixed(1)}%`,
          rate,
          t.successRateCritical
        );
      } else if (rate < t.successRateWarning) {
        this.fire(
          rateId,
          "Low success rate",
          "warning",
          `Success rate ${(rate * 100).toFixed(1)}% is below warning threshold ${(t.successRateWarning * 100).toFixed(1)}%`,
          rate,
          t.successRateWarning
        );
      } else {
        this.resolveIfPresent(rateId);
      }
    }

    // Settlement latency
    const latency = metrics.settlementLatency.medianSeconds;
    if (latency !== null) {
      this.checkThreshold(
        "settlement_latency",
        "High settlement latency",
        latency,
        t.settlementLatencyWarning,
        t.settlementLatencyCritical,
        (v) => `Median settlement latency ${v.toFixed(0)}s`
      );
    }
  }

  evaluateReconciliation(status: ReconciliationStatus): void {
    const t = this.thresholds;
    const nowSeconds = Date.now() / 1000;

    // Reconciliation staleness
    const stalenessId = "reconciliation_staleness";
    if (status.lastRunAt !== null) {
      const staleness = nowSeconds - status.lastRunAt;
      this.checkThreshold(
        stalenessId,
        "Reconciliation stale",
        staleness,
        t.reconciliationStalenessWarning,
        t.reconciliationStalenessCritical,
        (v) => `Last reconciliation run ${(v / 60).toFixed(1)} min ago`
      );
    }

    // Chain drift per chain
    for (const [chain, driftVal] of Object.entries(status.drift)) {
      const driftId = `chain_drift_${chain}`;
      this.checkThreshold(
        driftId,
        `Chain drift — ${chain}`,
        driftVal,
        t.driftWarning,
        t.driftCritical,
        (v) => `${chain} listener is ${v} blocks behind chain head`
      );
    }
  }

  evaluateServiceHealth(health: ServiceHealthSummary): void {
    for (const svc of health.services) {
      const id = `service_unhealthy_${svc.name}`;
      if (svc.status === "unhealthy") {
        this.fire(
          id,
          `Service unhealthy — ${svc.name}`,
          "critical",
          `${svc.name} reported status ${svc.status}${svc.error ? `: ${svc.error}` : ""}`,
          svc.status,
          "healthy"
        );
      } else if (svc.status === "degraded") {
        const degradedId = `service_degraded_${svc.name}`;
        this.fire(
          degradedId,
          `Service degraded — ${svc.name}`,
          "warning",
          `${svc.name} is degraded`,
          svc.status,
          "healthy"
        );
        this.resolveIfPresent(id); // resolve unhealthy if now only degraded
      } else {
        this.resolveIfPresent(id);
        this.resolveIfPresent(`service_degraded_${svc.name}`);
      }
    }
  }

  // ── Generic threshold helper ────────────────────────────────────────────────

  private checkThreshold(
    id: string,
    name: string,
    value: number,
    warnThreshold: number,
    critThreshold: number,
    messageFactory: (v: number) => string
  ): void {
    if (value >= critThreshold) {
      this.fire(
        id,
        name,
        "critical",
        `${messageFactory(value)} (critical threshold: ${critThreshold})`,
        value,
        critThreshold
      );
    } else if (value >= warnThreshold) {
      this.fire(
        id,
        name,
        "warning",
        `${messageFactory(value)} (warning threshold: ${warnThreshold})`,
        value,
        warnThreshold
      );
    } else {
      this.resolveIfPresent(id);
    }
  }

  // ── Query ────────────────────────────────────────────────────────────────────

  getActiveAlerts(): Alert[] {
    return [...this.activeAlerts.values()].sort((a, b) => {
      // critical first, then by firedAt desc
      const sev: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
      const diff = sev[a.severity] - sev[b.severity];
      return diff !== 0 ? diff : b.firedAt - a.firedAt;
    });
  }

  getResolvedAlerts(limit = 50): Alert[] {
    return this.resolvedAlerts.slice(0, limit);
  }

  getAllAlerts(limit = 50): Alert[] {
    return [...this.getActiveAlerts(), ...this.getResolvedAlerts(limit)];
  }
}
