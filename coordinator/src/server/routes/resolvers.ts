/**
 * Resolver registry and liveness routes.
 *
 *   POST /api/resolvers/heartbeat   — resolver daemon announces it is alive
 *   GET  /api/resolvers             — operator view of all known resolvers + liveness
 *   GET  /api/resolvers/:address    — single resolver liveness entry
 *
 * The heartbeat endpoint is intentionally unauthenticated so any resolver
 * that knows the coordinator URL can register its presence. Operator-level
 * auth is only required for destructive operations (not added here).
 *
 * The liveness snapshot uses a configurable stale threshold (default 90 s).
 * Callers can override it via `?staleThreshold=<seconds>` on the GET endpoints
 * to tune the "alive" window for their deployment.
 */

import { Router } from "express";
import { z } from "zod";
import type { ResolverLivenessService } from "../../services/resolver-liveness.js";
import { validationError } from "../errors.js";

const heartbeatSchema = z.object({
  address: z.string().min(1, "address is required"),
  chain: z.enum(["ethereum", "stellar"]),
});

export function resolversRoutes(liveness: ResolverLivenessService): Router {
  const router = Router();

  /**
   * POST /api/resolvers/heartbeat
   *
   * Body: { address: string, chain: "ethereum" | "stellar" }
   *
   * Called by the resolver daemon on a fixed interval to signal it is alive.
   * Idempotent — subsequent heartbeats from the same address simply update
   * the `last_seen` timestamp.
   */
  router.post("/resolvers/heartbeat", (req, res) => {
    const parsed = heartbeatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error.errors));
      return;
    }
    const { address, chain } = parsed.data;
    liveness.heartbeat(address, chain);
    res.status(200).json({ ok: true, address, chain });
  });

  /**
   * GET /api/resolvers
   *
   * Returns a liveness snapshot for all known resolvers.
   *
   * Query params:
   *   staleThreshold  — override the stale threshold in seconds (optional)
   *
   * Response shape:
   *   { resolvers: ResolverLivenessEntry[], aliveCount: number, staleCount: number }
   */
  router.get("/resolvers", (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    const entries = liveness.getAllLiveness(now);
    const aliveCount = entries.filter((e) => e.alive).length;
    const staleCount = entries.length - aliveCount;
    res.json({
      resolvers: entries,
      aliveCount,
      staleCount,
      queriedAt: new Date(now * 1000).toISOString(),
    });
  });

  /**
   * GET /api/resolvers/:address
   *
   * Returns the liveness entry for a single resolver address.
   * 404 when the address has never sent a heartbeat.
   */
  router.get("/resolvers/:address", (req, res) => {
    const address = req.params.address;
    if (!address || address.trim().length === 0) {
      res.status(400).json({ error: "validation_error", message: "address param is required" });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const entry = liveness.getLiveness(address, now);
    if (!entry) {
      res.status(404).json({ error: "not_found", message: `No heartbeat recorded for ${address}` });
      return;
    }
    res.json(entry);
  });

  return router;
}
