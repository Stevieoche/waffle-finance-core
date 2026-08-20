# @wafflefinance/dashboard

Unified observability dashboard for WaffleFinance core services.

Exposes admin REST endpoints that aggregate metrics, reconciliation state, service health, and alert status from the coordinator and related services. Designed to be mounted alongside the coordinator or run as a standalone Express app.

---

## Features

| Endpoint | Description |
|---|---|
| `GET /api/admin/metrics` | Orders per chain/direction, settlement latency, success rate |
| `GET /api/admin/reconciliation-status` | Chain cursors, block drift, last run metadata |
| `GET /api/admin/service-health` | Coordinator / relayer / resolver health aggregation |
| `GET /api/admin/alerts` | Active threshold-breach alerts with configurable thresholds |
| `PUT /api/admin/alerts/thresholds` | Update alert thresholds at runtime |
| `GET /dashboard/health` | Unified service health (existing) |
| `GET /dashboard/liveness` | Liveness check (existing) |
| `GET /dashboard/readiness` | Readiness check (existing) |

---

## Authentication

All `/api/admin/*` routes require a `Bearer` token:

```
Authorization: Bearer <token>
```

Tokens are read from (in priority order):

1. `DASHBOARD_ADMIN_KEYS` — comma-separated list of valid tokens
2. `COORDINATOR_OPERATOR_KEYS` — fallback to the coordinator's own key set

When neither variable is set (local development), all requests are allowed through with a warning.

---

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `DASHBOARD_ADMIN_KEYS` | — | Comma-separated admin Bearer tokens |
| `COORDINATOR_OPERATOR_KEYS` | — | Fallback token set (shared with coordinator) |
| `COORDINATOR_URL` | `http://localhost:3001` | Coordinator base URL for Prometheus scraping |
| `RELAYER_URL` | — | Optional relayer base URL for health aggregation |
| `RESOLVER_URL` | — | Optional resolver base URL for health aggregation |

### Metrics cache TTL

Results from the coordinator Prometheus endpoint are cached for **60 seconds** by default to avoid hammering the metrics endpoint. This is configurable via `MetricsAggregator`:

```ts
new MetricsAggregator({ coordinatorUrl, cacheTtlMs: 30_000 })
```

---

## Admin API Reference

### `GET /api/admin/metrics`

Aggregates order metrics from the coordinator's `/metrics` Prometheus endpoint.

**Response:**
```json
{
  "timestamp": 1700000000000,
  "perChain": { "ethereum": 120, "stellar": 80 },
  "perDirection": { "eth_to_xlm": 100, "xlm_to_eth": 100, "eth_to_sol": 0, "sol_to_eth": 0 },
  "byStatus": { "announced": 5, "src_locked": 10, "completed": 200, "refunded": 5, "failed": 0 },
  "settlementLatency": { "medianSeconds": 90, "p95Seconds": 240 },
  "successRate": 0.952,
  "activeOrders": 15
}
```

---

### `GET /api/admin/reconciliation-status`

Returns chain-level reconciliation state parsed from Prometheus gauges.

**Response:**
```json
{
  "timestamp": 1700000000000,
  "cursors": { "ethereum": 21500000, "stellar": 49000000, "solana": 280000000 },
  "drift":   { "ethereum": 2, "stellar": 0, "solana": 5 },
  "lastRunAt": 1700000000,
  "lastRunOk": true,
  "eventsReplayed": 42,
  "totalConflicts": 0
}
```

---

### `GET /api/admin/service-health`

Fetches `/health` from all registered services and returns an aggregated view.

**Response:**
```json
{
  "timestamp": 1700000000000,
  "overall": "healthy",
  "services": [
    { "name": "coordinator", "status": "healthy", "responseTimeMs": 12, "uptime": 3600 },
    { "name": "relayer",     "status": "healthy", "responseTimeMs": 8 }
  ],
  "summary": { "healthy": 2, "degraded": 0, "unhealthy": 0, "unknown": 0, "total": 2 }
}
```

---

### `GET /api/admin/alerts`

Returns active threshold alerts, optional resolved history, and current thresholds.

**Query params:**

| Param | Default | Description |
|---|---|---|
| `includeResolved` | `false` | Include recently resolved alerts |
| `limit` | `50` | Max resolved alerts returned (max 200) |

**Response:**
```json
{
  "timestamp": 1700000000000,
  "active": [
    {
      "id": "chain_drift_solana",
      "name": "Chain drift — solana",
      "severity": "warning",
      "message": "solana listener is 75 blocks behind chain head (warning threshold: 50)",
      "firedAt": 1700000000000,
      "resolvedAt": null,
      "triggerValue": 75,
      "threshold": 50
    }
  ],
  "thresholds": { "driftWarning": 50, "driftCritical": 200, ... }
}
```

---

### `PUT /api/admin/alerts/thresholds`

Update alert thresholds at runtime. Accepts a partial object; unspecified fields are unchanged.

**Request body:**
```json
{
  "driftWarning": 100,
  "successRateCritical": 0.6
}
```

**Response:**
```json
{
  "ok": true,
  "thresholds": { "driftWarning": 100, "driftCritical": 200, "successRateCritical": 0.6, ... }
}
```

---

## Default Alert Thresholds

| Alert | Warning | Critical |
|---|---|---|
| Block drift per chain | 50 blocks | 200 blocks |
| Success rate | < 90% | < 70% |
| Reconciliation staleness | > 5 min | > 15 min |
| Active orders | > 500 | > 1 000 |
| Settlement latency (median) | > 300 s | > 900 s |
| Service health | degraded | unhealthy |

---

## Usage

### As a standalone package

```ts
import express from "express";
import {
  dashboardHealthRoutes,
  adminRoutes,
  MetricsAggregator,
  AlertManager,
} from "@wafflefinance/dashboard";

const aggregator = new MetricsAggregator({
  coordinatorUrl: process.env.COORDINATOR_URL ?? "http://localhost:3001",
  serviceUrls: {
    relayer:  process.env.RELAYER_URL  ?? "http://localhost:3002",
    resolver: process.env.RESOLVER_URL ?? "http://localhost:3003",
  },
  cacheTtlMs: 60_000,
});

const alerts = new AlertManager();

const app = express();
app.use(express.json());
app.use(dashboardHealthRoutes([
  { name: "coordinator", url: process.env.COORDINATOR_URL ?? "http://localhost:3001" },
]));
app.use(adminRoutes({ metrics: aggregator, alerts }));

app.listen(4000, () => console.log("Dashboard listening on :4000"));
```

---

## Development

```bash
pnpm test          # run all tests (vitest)
pnpm test:watch    # watch mode
pnpm build         # compile TypeScript
```

---

## Tests

72 tests across 4 suites:

| Suite | Tests | Coverage |
|---|---|---|
| `test/health.test.ts` | 10 | Health / liveness / readiness routes |
| `test/alerts.test.ts` | 24 | Alert firing, resolution, thresholds, sorting |
| `test/admin-routes.test.ts` | 20 | All 5 admin endpoints + auth middleware |
| `test/metrics-aggregator.test.ts` | 18 | Prometheus parsing, caching, service health |
