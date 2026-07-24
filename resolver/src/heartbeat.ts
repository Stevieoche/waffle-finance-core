/**
 * Resolver heartbeat client.
 *
 * Sends a periodic liveness signal to the coordinator's
 * POST /api/resolvers/heartbeat endpoint so the coordinator can track
 * which resolvers are alive and surface stale ones to operators.
 *
 * Design
 * ──────
 * • Opt-in: the heartbeat only runs when `coordinatorUrl` is set and
 *   a resolver address is known (either Ethereum or Stellar).
 * • Best-effort: a failed heartbeat is logged but never throws. The
 *   resolver continues operating normally even when the coordinator is
 *   temporarily unreachable.
 * • Graceful shutdown: `stop()` clears the interval immediately.
 * • Configurable interval with a safe minimum (10 s) to prevent
 *   accidental DoS of the coordinator.
 */

import type { Logger } from "pino";

export interface HeartbeatClientOptions {
  /** Base URL of the coordinator, e.g. "http://localhost:3001". */
  coordinatorUrl: string;
  /** The resolver's Ethereum address (hex). Used when chain = "ethereum". */
  ethereumAddress?: string | null;
  /** The resolver's Stellar public key. Used when chain = "stellar". */
  stellarAddress?: string | null;
  /** How often to send a heartbeat, in milliseconds. Default: 30 000 (30 s). */
  intervalMs?: number;
  /** Injected fetch (for testing). Defaults to globalThis.fetch. */
  fetcher?: typeof fetch;
  log: Logger;
}

/** Minimum safe heartbeat interval — prevents accidental flooding. */
const MIN_INTERVAL_MS = 10_000;
const DEFAULT_INTERVAL_MS = 30_000;

export type HeartbeatChain = "ethereum" | "stellar";

export interface HeartbeatEntry {
  address: string;
  chain: HeartbeatChain;
}

export class HeartbeatClient {
  private readonly _coordinatorUrl: string;
  private readonly _entries: HeartbeatEntry[];
  private readonly _intervalMs: number;
  private readonly _fetcher: typeof fetch;
  private readonly _log: Logger;
  private _timer: ReturnType<typeof setInterval> | null = null;

  /** Total heartbeat attempts sent since start (for observability). */
  private _sent = 0;
  /** Total heartbeat failures since start. */
  private _failures = 0;

  constructor(opts: HeartbeatClientOptions) {
    this._coordinatorUrl = opts.coordinatorUrl.replace(/\/$/, "");
    this._log = opts.log.child({ component: "HeartbeatClient" });
    this._fetcher = opts.fetcher ?? globalThis.fetch;
    this._intervalMs = Math.max(opts.intervalMs ?? DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS);

    this._entries = [];
    if (opts.ethereumAddress) {
      this._entries.push({ address: opts.ethereumAddress, chain: "ethereum" });
    }
    if (opts.stellarAddress) {
      this._entries.push({ address: opts.stellarAddress, chain: "stellar" });
    }
  }

  /**
   * Start the heartbeat loop. No-op if there are no addresses to heartbeat
   * for, or if already running.
   */
  start(): void {
    if (this._entries.length === 0) {
      this._log.info("no resolver addresses configured — heartbeat disabled");
      return;
    }
    if (this._timer !== null) return; // already running

    // Send immediately on start, then on each interval tick.
    void this._sendAll();
    this._timer = setInterval(() => void this._sendAll(), this._intervalMs);
    this._log.info(
      { intervalMs: this._intervalMs, entries: this._entries.length },
      "heartbeat client started",
    );
  }

  /** Stop the heartbeat loop. Safe to call multiple times. */
  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
      this._log.info({ sent: this._sent, failures: this._failures }, "heartbeat client stopped");
    }
  }

  /** Whether the client is currently running. */
  get running(): boolean {
    return this._timer !== null;
  }

  /** Diagnostic counters (for tests and metrics). */
  get stats(): { sent: number; failures: number } {
    return { sent: this._sent, failures: this._failures };
  }

  /** Send one heartbeat for each configured entry. Best-effort, never throws. */
  private async _sendAll(): Promise<void> {
    for (const entry of this._entries) {
      await this._sendOne(entry);
    }
  }

  private async _sendOne(entry: HeartbeatEntry): Promise<void> {
    const url = `${this._coordinatorUrl}/api/resolvers/heartbeat`;
    this._sent++;
    try {
      const res = await this._fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: entry.address, chain: entry.chain }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this._failures++;
        this._log.warn(
          { address: entry.address, chain: entry.chain, status: res.status, body: text },
          "heartbeat rejected by coordinator",
        );
      } else {
        this._log.debug(
          { address: entry.address, chain: entry.chain },
          "heartbeat sent",
        );
      }
    } catch (err) {
      this._failures++;
      this._log.warn(
        { address: entry.address, chain: entry.chain, err },
        "heartbeat failed (coordinator unreachable)",
      );
    }
  }
}
