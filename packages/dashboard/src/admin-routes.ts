import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { requireAdminAuth } from "./auth.js";
import type { MetricsAggregator } from "./metrics-aggregator.js";
import type { AlertManager, AlertThresholds } from "./alerts.js";

export interface AdminRoutesDeps {
  metrics: MetricsAggregator;
  alerts: AlertManager;
}

/**
 * Mount admin API routes on the given router.
 *
 * All routes require a valid Bearer token (see `requireAdminAuth`).
 *
 * Routes:
 *   GET /api/admin/metrics               — order metrics per chain/direction
 *   GET /api/admin/reconciliation-status — chain cursors, drift, last run
 *   GET /api/admin/service-health        — coordinator/relayer/resolver status
 *   GET /api/admin/alerts                — active alerts and threshold breaches
 *   PUT /api/admin/alerts/thresholds     — update alert threshold configuration
 */
export function adminRoutes(deps: AdminRoutesDeps): Router {
  const router = Router();

  /**
   * GET /api/admin/metrics
   *
   * Aggregated order metrics from the coordinator Prometheus endpoint.
   * Cached for up to 1 minute (configurable via MetricsAggregator).
   *
   * Response 200:
   *   {
   *     timestamp: number,
   *     perChain: Record<string, number>,
   *     perDirection: Record<string, number>,
   *     byStatus: Record<string, number>,
   *     settlementLatency: { medianSeconds: number|null, p95Seconds: number|null },
   *     successRate: number|null,
   *     activeOrders: number
   *   }
   */
  router.get(
    "/api/admin/metrics",
    requireAdminAuth,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const data = await deps.metrics.getOrderMetrics();
        res.json(data);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/admin/reconciliation-status
   *
   * Chain cursor positions, drift, and last reconciliation run metadata.
   *
   * Response 200:
   *   {
   *     timestamp: number,
   *     cursors: { ethereum: number, stellar: number, solana: number },
   *     drift:   { ethereum: number, stellar: number, solana: number },
   *     lastRunAt: number|null,
   *     lastRunOk: boolean|null,
   *     eventsReplayed: number,
   *     totalConflicts: number
   *   }
   */
  router.get(
    "/api/admin/reconciliation-status",
    requireAdminAuth,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const data = await deps.metrics.getReconciliationStatus();
        res.json(data);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/admin/service-health
   *
   * Aggregated health status for all registered services.
   *
   * Response 200:
   *   {
   *     timestamp: number,
   *     overall: "healthy"|"degraded"|"unhealthy",
   *     services: [{ name, status, responseTimeMs, uptime?, version?, checks? }],
   *     summary: { healthy, degraded, unhealthy, unknown, total }
   *   }
   */
  router.get(
    "/api/admin/service-health",
    requireAdminAuth,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const data = await deps.metrics.getServiceHealth();
        // Run alert evaluation in background (non-blocking)
        deps.alerts.evaluateServiceHealth(data);
        res.json(data);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/admin/alerts
   *
   * Active alerts, recently resolved alerts, and current threshold config.
   *
   * Query params:
   *   ?includeResolved=true   — include recently resolved alerts (default false)
   *   ?limit=N                — max resolved alerts to include (default 50)
   *
   * Response 200:
   *   {
   *     timestamp: number,
   *     active: Alert[],
   *     resolved?: Alert[],
   *     thresholds: AlertThresholds
   *   }
   */
  router.get(
    "/api/admin/alerts",
    requireAdminAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Re-evaluate alerts with fresh data when requested
        const [orderMetrics, reconcStatus] = await Promise.allSettled([
          deps.metrics.getOrderMetrics(),
          deps.metrics.getReconciliationStatus(),
        ]);

        if (orderMetrics.status === "fulfilled") {
          deps.alerts.evaluateOrderMetrics(orderMetrics.value);
        }
        if (reconcStatus.status === "fulfilled") {
          deps.alerts.evaluateReconciliation(reconcStatus.value);
        }

        const includeResolved = req.query["includeResolved"] === "true";
        const limit = Math.min(
          parseInt(String(req.query["limit"] ?? "50"), 10) || 50,
          200
        );

        const body: {
          timestamp: number;
          active: ReturnType<AlertManager["getActiveAlerts"]>;
          resolved?: ReturnType<AlertManager["getResolvedAlerts"]>;
          thresholds: AlertThresholds;
        } = {
          timestamp: Date.now(),
          active: deps.alerts.getActiveAlerts(),
          thresholds: deps.alerts.getThresholds(),
        };

        if (includeResolved) {
          body.resolved = deps.alerts.getResolvedAlerts(limit);
        }

        res.json(body);
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * PUT /api/admin/alerts/thresholds
   *
   * Update alert threshold configuration. Accepts a partial thresholds object;
   * unspecified fields are left unchanged.
   *
   * Request body: Partial<AlertThresholds>
   *
   * Response 200:
   *   { ok: true, thresholds: AlertThresholds }
   *
   * Response 400:
   *   { error: "bad_request", message: string }
   */
  router.put(
    "/api/admin/alerts/thresholds",
    requireAdminAuth,
    (req: Request, res: Response) => {
      const body = req.body as Record<string, unknown>;
      const numericFields: Array<keyof AlertThresholds> = [
        "driftWarning",
        "driftCritical",
        "successRateWarning",
        "successRateCritical",
        "reconciliationStalenessWarning",
        "reconciliationStalenessCritical",
        "activeOrdersWarning",
        "activeOrdersCritical",
        "settlementLatencyWarning",
        "settlementLatencyCritical",
      ];

      const patch: Partial<AlertThresholds> = {};
      for (const field of numericFields) {
        if (field in body) {
          const val = Number(body[field]);
          if (Number.isNaN(val) || val < 0) {
            res.status(400).json({
              error: "bad_request",
              message: `Field ${field} must be a non-negative number`,
            });
            return;
          }
          (patch as Record<string, number>)[field] = val;
        }
      }

      const updated = deps.alerts.updateThresholds(patch);
      res.json({ ok: true, thresholds: updated });
    }
  );

  return router;
}
