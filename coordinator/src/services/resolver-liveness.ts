/**
 * Resolver heartbeat and liveness service.
 *
 * This module encodes the resolver liveness model as a stable, testable
 * contract. It reads from and writes to the `resolver_heartbeats` table,
 * which already exists in the coordinator schema.
 *
 * Liveness semantics
 * ──────────────────
 * A resolver is considered ALIVE when it has published a heartbeat within
 * the last `staleThresholdSeconds`. Any resolver whose most recent heartbeat
 * is older than that threshold is STALE.
 *
 * The default threshold is 90 seconds. The resolver daemon sends a heartbeat
 * every 30 seconds, so three missed beats → stale. This gives a clear,
 * observable contract:
 *
 *   alive  : last_seen > now - staleThresholdSeconds
 *   stale  : last_seen ≤ now - staleThresholdSeconds
 *   unknown: never sent a heartbeat (not in the table)
 *
 * The liveness decision is stateless — it is computed at query time from the
 * stored `last_seen` unix timestamp. No background job is required.
 */

import type { Database } from "../persistence/db.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ResolverChain = "ethereum" | "stellar";

export interface ResolverHeartbeatRecord {
  /** The resolver's on-chain address. */
  address: string;
  /** Which chain this heartbeat is for. */
  chain: ResolverChain;
  /** Unix timestamp (seconds) of the most recent heartbeat. */
  lastSeen: number;
}

export interface ResolverLivenessEntry extends ResolverHeartbeatRecord {
  /**
   * Whether the resolver is considered alive at query time.
   * alive = lastSeen > (nowSeconds - staleThresholdSeconds)
   */
  alive: boolean;
  /** How many seconds ago the last heartbeat was received. */
  ageSeconds: number;
}

// ── Default thresholds ────────────────────────────────────────────────────────

/**
 * A resolver that has not published a heartbeat in this many seconds is
 * considered stale. The resolver daemon heartbeats every 30 s; three missed
 * beats = 90 s threshold.
 */
export const DEFAULT_STALE_THRESHOLD_SECONDS = 90;

// ── Repository ────────────────────────────────────────────────────────────────

export class ResolverLivenessRepository {
  constructor(private readonly db: Database) {}

  /**
   * Upsert a heartbeat for the given resolver address and chain.
   * Sets `last_seen` to `nowSeconds` (defaults to the current unix timestamp).
   */
  upsertHeartbeat(
    address: string,
    chain: ResolverChain,
    nowSeconds?: number,
  ): void {
    const ts = nowSeconds ?? Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO resolver_heartbeats (address, chain, last_seen)
         VALUES (:address, :chain, :lastSeen)
         ON CONFLICT(address) DO UPDATE SET
           chain     = excluded.chain,
           last_seen = excluded.last_seen`,
      )
      .run({ address, chain, lastSeen: ts });
  }

  /**
   * Return the heartbeat record for a single resolver address, or null if
   * the address has never sent a heartbeat.
   */
  findByAddress(address: string): ResolverHeartbeatRecord | null {
    const row = this.db
      .prepare(`SELECT address, chain, last_seen FROM resolver_heartbeats WHERE address = ?`)
      .get(address) as { address: string; chain: ResolverChain; last_seen: number } | undefined;
    if (!row) return null;
    return { address: row.address, chain: row.chain, lastSeen: row.last_seen };
  }

  /**
   * Return all known resolver heartbeat records, ordered by last_seen DESC.
   */
  findAll(): ResolverHeartbeatRecord[] {
    const rows = this.db
      .prepare(
        `SELECT address, chain, last_seen FROM resolver_heartbeats ORDER BY last_seen DESC`,
      )
      .all() as Array<{ address: string; chain: ResolverChain; last_seen: number }>;
    return rows.map((r) => ({ address: r.address, chain: r.chain, lastSeen: r.last_seen }));
  }

  /**
   * Return all resolvers whose last_seen is older than `(nowSeconds - staleAfterSeconds)`.
   * These are candidates for operator alerting or automatic deregistration.
   */
  findStale(
    staleAfterSeconds = DEFAULT_STALE_THRESHOLD_SECONDS,
    nowSeconds?: number,
  ): ResolverHeartbeatRecord[] {
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    const cutoff = now - staleAfterSeconds;
    const rows = this.db
      .prepare(
        `SELECT address, chain, last_seen FROM resolver_heartbeats
         WHERE last_seen <= :cutoff
         ORDER BY last_seen ASC`,
      )
      .all({ cutoff }) as Array<{ address: string; chain: ResolverChain; last_seen: number }>;
    return rows.map((r) => ({ address: r.address, chain: r.chain, lastSeen: r.last_seen }));
  }
}

// ── Liveness service ──────────────────────────────────────────────────────────

export class ResolverLivenessService {
  constructor(
    private readonly repo: ResolverLivenessRepository,
    private readonly staleThresholdSeconds = DEFAULT_STALE_THRESHOLD_SECONDS,
  ) {}

  /**
   * Record a heartbeat for `address` on `chain`.
   */
  heartbeat(address: string, chain: ResolverChain, nowSeconds?: number): void {
    this.repo.upsertHeartbeat(address, chain, nowSeconds);
  }

  /**
   * Return the full liveness snapshot for all known resolvers.
   * Each entry includes whether the resolver is currently alive.
   */
  getAllLiveness(nowSeconds?: number): ResolverLivenessEntry[] {
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    return this.repo.findAll().map((r) => this._toLivenessEntry(r, now));
  }

  /**
   * Return the liveness entry for a single resolver address, or null if unknown.
   */
  getLiveness(address: string, nowSeconds?: number): ResolverLivenessEntry | null {
    const record = this.repo.findByAddress(address);
    if (!record) return null;
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    return this._toLivenessEntry(record, now);
  }

  /**
   * Return all resolver entries that are currently stale.
   */
  getStaleResolvers(nowSeconds?: number): ResolverLivenessEntry[] {
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    return this.repo
      .findStale(this.staleThresholdSeconds, now)
      .map((r) => this._toLivenessEntry(r, now));
  }

  /**
   * Return true if at least one alive resolver exists for the given chain.
   */
  hasAliveResolver(chain: ResolverChain, nowSeconds?: number): boolean {
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    return this.getAllLiveness(now).some((r) => r.chain === chain && r.alive);
  }

  private _toLivenessEntry(
    record: ResolverHeartbeatRecord,
    nowSeconds: number,
  ): ResolverLivenessEntry {
    const ageSeconds = nowSeconds - record.lastSeen;
    return {
      ...record,
      alive: ageSeconds <= this.staleThresholdSeconds,
      ageSeconds,
    };
  }
}
