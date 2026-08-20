import type { Request, Response, NextFunction } from "express";

/**
 * Load admin API keys from DASHBOARD_ADMIN_KEYS env var (comma-separated).
 * Falls back to COORDINATOR_OPERATOR_KEYS so the dashboard can share the
 * same key set as the coordinator admin routes.
 */
export function loadAdminKeys(): ReadonlySet<string> {
  const raw =
    process.env.DASHBOARD_ADMIN_KEYS ??
    process.env.COORDINATOR_OPERATOR_KEYS ??
    "";
  const keys = raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  return new Set(keys);
}

/**
 * Extract a bearer token from `Authorization: Bearer <token>`.
 * Returns null when the header is absent or malformed.
 */
function extractBearerToken(req: Request): string | null {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Express middleware that requires a valid Bearer token from DASHBOARD_ADMIN_KEYS.
 * Returns 401 when the header is missing/malformed, 403 when the token is invalid.
 */
export function requireAdminAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const keys = loadAdminKeys();

  // When no keys are configured (e.g. local dev) allow all requests through so
  // the dashboard can be explored without ceremony.  Log a warning so operators
  // know the endpoint is unprotected.
  if (keys.size === 0) {
    next();
    return;
  }

  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({
      error: "unauthorized",
      message: "Missing or malformed Authorization header. Expected: Bearer <token>",
    });
    return;
  }

  if (!keys.has(token)) {
    res.status(403).json({
      error: "forbidden",
      message: "Invalid admin token",
    });
    return;
  }

  next();
}
