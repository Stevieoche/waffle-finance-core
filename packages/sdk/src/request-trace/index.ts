/**
 * SDK replayable request trace utility.
 *
 * Captures the essential contract-boundary state for every HTLC client call:
 * route identity, sanitized input shape, call sequence, and response
 * classification. The output is deterministic and safe to store or send to
 * logs because all secret-bearing fields are redacted before the trace is
 * finalised.
 *
 * Usage pattern
 * ─────────────
 * Wrap any IHTLCClient with TracingHTLCAdapter, then call your operations
 * as normal. After the call, read the trace from the adapter or pass a
 * collector callback:
 *
 *   const tracer = new RequestTracer();
 *   const client = new TracingHTLCAdapter(myEthAdapter, { tracer });
 *   await client.createOrder(input);
 *   const trace = tracer.flush(); // deterministic, log-safe snapshot
 *
 * Design goals
 * ─────────────
 * 1. OPT-IN — tracing is off by default; callers attach a tracer explicitly.
 * 2. SAFE-BY-DEFAULT — secrets (preimage, hashlock raw hex, private keys)
 *    are redacted from the stored payload before any snapshot is produced.
 * 3. DETERMINISTIC OUTPUT — the same call sequence always produces the same
 *    trace structure, making it suitable for replay scripts and golden-file
 *    testing.
 * 4. ZERO OVERHEAD WHEN DISABLED — when no tracer is attached the wrapper
 *    adds one null-check per call and nothing else.
 */

import type { IHTLCClient, HTLCCreateResult, HTLCTxResult, HTLCErrorCode } from "../htlc-client.js";
import { HTLCError } from "../htlc-client.js";
import type { Chain, Direction } from "../types/index.js";

// ── Redaction ────────────────────────────────────────────────────────────────

/**
 * Sentinel value written in place of any redacted field.
 * The value is stable and machine-readable so downstream tooling can detect
 * redacted fields without heuristics.
 */
export const REDACTED = "[REDACTED]" as const;
export type Redacted = typeof REDACTED;

/**
 * Regex that matches 0x-prefixed hex strings of 16+ hex chars (32+ characters
 * total including the prefix). This covers hashlocks (64 hex), preimages (64
 * hex), private keys (64 hex), and short secrets (16+ hex). Strings shorter
 * than this (e.g. transaction hashes displayed to users) are typically safe to
 * log.
 *
 * Mirrors the pattern used by coordinator/src/utils/sanitize-for-log.ts so
 * redaction behaviour is consistent across the whole system.
 */
const SECRET_HEX_PATTERN = /0x[0-9a-fA-F]{16,}/g;

/**
 * Redact any value that looks like a raw secret. Returns the value unchanged
 * when it is not a string or does not match the secret pattern.
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(SECRET_HEX_PATTERN, REDACTED);
  }
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_INPUT_KEYS.has(k.toLowerCase())
      ? REDACTED
      : redactSecrets(v);
  }
  return out;
}

/**
 * Exact key names that must always be redacted regardless of their value
 * shape. This is a belt-and-suspenders guard for fields whose name reveals
 * their sensitive nature even when the value is not a hex string.
 */
const SENSITIVE_INPUT_KEYS = new Set([
  "preimage",
  "secret",
  "privatekey",
  "resolverprivatekey",
  "resolverprivkey",
  "secretkey",
  "resolversecret",
  "mnemonic",
  "seed",
]);

// ── Trace model ───────────────────────────────────────────────────────────────

/** Which SDK operation produced this step. */
export type TraceOperation = "createOrder" | "claimOrder" | "refundOrder";

/** Outcome of a single traced call. */
export type TraceOutcome =
  | "success"
  | "htlc_error"   // HTLCError thrown — classified, expected failure
  | "unknown_error"; // Unexpected error not wrapped by an adapter

/** A single step in the call sequence. */
export interface TraceStep {
  /** Sequential index, starting at 0. */
  index: number;
  /** Which adapter method was called. */
  operation: TraceOperation;
  /** Which chain the underlying client targets. */
  chain: Chain;
  /** Sanitized (redacted) input snapshot. */
  sanitizedInput: unknown;
  /** Outcome of the call. */
  outcome: TraceOutcome;
  /**
   * When outcome is `htlc_error`, the stable HTLCErrorCode.
   * Null for success or unexpected errors.
   */
  errorCode: HTLCErrorCode | null;
  /** Whether the error is considered retryable (mirrors HTLCError.retryable). */
  retryable: boolean | null;
  /** Sanitized result snapshot on success. Null on failure. */
  sanitizedResult: unknown | null;
  /** Wall-clock duration of the call in milliseconds. */
  durationMs: number;
  /** Unix ms timestamp when the call started. */
  startedAt: number;
}

/**
 * A complete, replayable trace for a single order request session.
 *
 * The trace captures route identity (which adapter, which chain), the ordered
 * call sequence, and enough context to reconstruct why a request behaved as it
 * did without including any secrets.
 */
export interface RequestTrace {
  /**
   * Unique trace identifier. Generated by the tracer at flush time.
   * Format: `trace_<hex16>` — 16 lowercase hex characters.
   */
  traceId: string;
  /**
   * The direction of the swap this trace belongs to, when known.
   * Set by the caller via `RequestTracer.setContext()`.
   */
  direction: Direction | null;
  /**
   * The public order ID from the coordinator, when known.
   * Never contains a preimage or secret.
   */
  publicOrderId: string | null;
  /**
   * Which chain adapter is under observation.
   * Set automatically by TracingHTLCAdapter.
   */
  chain: Chain;
  /** Route kind — always `"wafflefinance-htlc"` for the built-in adapters. */
  routeKind: string;
  /** ISO-8601 timestamp when the first step was recorded. */
  sessionStartedAt: string;
  /** ISO-8601 timestamp when the trace was flushed (snapshot taken). */
  flushedAt: string;
  /** Total wall-clock duration across all steps, in milliseconds. */
  totalDurationMs: number;
  /** Ordered sequence of recorded call steps. */
  steps: TraceStep[];
  /**
   * High-level session outcome derived from the steps.
   * `success` = at least one step succeeded.
   * `failed`  = all steps that ran ended in error.
   * `empty`   = no steps were recorded.
   */
  sessionOutcome: "success" | "failed" | "empty";
  /**
   * Caller-supplied metadata (set via RequestTracer.setContext).
   * Sanitized before storage — no raw secrets will appear here.
   */
  metadata: Record<string, unknown>;
}

// ── RequestTracer ─────────────────────────────────────────────────────────────

/**
 * Stateful trace accumulator. One instance per request/session.
 *
 * Typical usage:
 *   const tracer = new RequestTracer();
 *   tracer.setContext({ direction: 'eth_to_xlm', publicOrderId: 'wf_0x...' });
 *   // ... pass tracer to TracingHTLCAdapter ...
 *   const trace = tracer.flush();
 */
export class RequestTracer {
  private readonly _steps: TraceStep[] = [];
  private _direction: Direction | null = null;
  private _publicOrderId: string | null = null;
  private _metadata: Record<string, unknown> = {};
  private _sessionStart: number | null = null;

  /**
   * Set optional context that will be included in the flushed trace.
   * Called any time before flush.
   */
  setContext(ctx: {
    direction?: Direction;
    publicOrderId?: string;
    metadata?: Record<string, unknown>;
  }): void {
    if (ctx.direction !== undefined) this._direction = ctx.direction;
    if (ctx.publicOrderId !== undefined) this._publicOrderId = ctx.publicOrderId;
    if (ctx.metadata !== undefined) {
      this._metadata = redactSecrets(ctx.metadata) as Record<string, unknown>;
    }
  }

  /**
   * Record a single step. Called internally by TracingHTLCAdapter.
   * @internal
   */
  record(step: Omit<TraceStep, "index">): void {
    const index = this._steps.length;
    if (index === 0) this._sessionStart = step.startedAt;
    this._steps.push({ ...step, index });
  }

  /** Produce a frozen, log-safe snapshot and reset internal state. */
  flush(chain: Chain, routeKind: string): RequestTrace {
    const now = Date.now();
    const sessionStartMs = this._sessionStart ?? now;
    const totalDurationMs = this._steps.reduce((sum, s) => sum + s.durationMs, 0);

    const sessionOutcome: RequestTrace["sessionOutcome"] =
      this._steps.length === 0
        ? "empty"
        : this._steps.some((s) => s.outcome === "success")
        ? "success"
        : "failed";

    const trace: RequestTrace = {
      traceId: generateTraceId(),
      direction: this._direction,
      publicOrderId: this._publicOrderId,
      chain,
      routeKind,
      sessionStartedAt: new Date(sessionStartMs).toISOString(),
      flushedAt: new Date(now).toISOString(),
      totalDurationMs,
      steps: [...this._steps],
      sessionOutcome,
      metadata: { ...this._metadata },
    };

    // Reset state after flush so the tracer can be reused for a subsequent request.
    this._steps.length = 0;
    this._direction = null;
    this._publicOrderId = null;
    this._metadata = {};
    this._sessionStart = null;

    return Object.freeze(trace);
  }

  /** Number of steps recorded so far (without flushing). */
  get stepCount(): number {
    return this._steps.length;
  }

  /** True if at least one step has been recorded. */
  get hasSteps(): boolean {
    return this._steps.length > 0;
  }
}

// ── TracingHTLCAdapter ────────────────────────────────────────────────────────

export interface TracingHTLCAdapterOptions {
  /** The tracer instance that will accumulate steps. */
  tracer: RequestTracer;
  /**
   * The chain this adapter targets. Used in the trace's `chain` field and
   * in each step's `chain` field.
   */
  chain: Chain;
  /**
   * Optional route kind label. Defaults to `"wafflefinance-htlc"`.
   */
  routeKind?: string;
}

/**
 * Transparent wrapper that delegates all calls to the underlying adapter and
 * records a TraceStep for each call.
 *
 * The wrapper is generic over the create-input and signer types so it can
 * wrap any of the three chain adapters (Ethereum, Soroban, Solana) without
 * losing type safety at the call site.
 */
export class TracingHTLCAdapter<TCreateInput = unknown, TSigner = unknown>
  implements IHTLCClient<TCreateInput, TSigner>
{
  private readonly _tracer: RequestTracer;
  private readonly _chain: Chain;
  private readonly _routeKind: string;

  constructor(
    private readonly _inner: IHTLCClient<TCreateInput, TSigner>,
    opts: TracingHTLCAdapterOptions,
  ) {
    this._tracer = opts.tracer;
    this._chain = opts.chain;
    this._routeKind = opts.routeKind ?? "wafflefinance-htlc";
  }

  async createOrder(input: TCreateInput, signer?: TSigner): Promise<HTLCCreateResult> {
    const start = Date.now();
    try {
      const result = await this._inner.createOrder(input, signer);
      this._tracer.record({
        operation: "createOrder",
        chain: this._chain,
        sanitizedInput: redactSecrets(input as unknown),
        outcome: "success",
        errorCode: null,
        retryable: null,
        sanitizedResult: redactSecrets(result),
        durationMs: Date.now() - start,
        startedAt: start,
      });
      return result;
    } catch (err) {
      this._recordError("createOrder", input, err, start);
      throw err;
    }
  }

  async claimOrder(
    orderId: string,
    preimage: `0x${string}`,
    signer?: TSigner,
  ): Promise<HTLCTxResult> {
    const start = Date.now();
    // Preimage is always redacted — do not log the raw value.
    const sanitizedInput = { orderId, preimage: REDACTED };
    try {
      const result = await this._inner.claimOrder(orderId, preimage, signer);
      this._tracer.record({
        operation: "claimOrder",
        chain: this._chain,
        sanitizedInput,
        outcome: "success",
        errorCode: null,
        retryable: null,
        sanitizedResult: redactSecrets(result),
        durationMs: Date.now() - start,
        startedAt: start,
      });
      return result;
    } catch (err) {
      this._recordError("claimOrder", sanitizedInput, err, start);
      throw err;
    }
  }

  async refundOrder(orderId: string, signer?: TSigner): Promise<HTLCTxResult> {
    const start = Date.now();
    const sanitizedInput = { orderId };
    try {
      const result = await this._inner.refundOrder(orderId, signer);
      this._tracer.record({
        operation: "refundOrder",
        chain: this._chain,
        sanitizedInput,
        outcome: "success",
        errorCode: null,
        retryable: null,
        sanitizedResult: redactSecrets(result),
        durationMs: Date.now() - start,
        startedAt: start,
      });
      return result;
    } catch (err) {
      this._recordError("refundOrder", sanitizedInput, err, start);
      throw err;
    }
  }

  /**
   * Flush the tracer and return the complete trace for this adapter's chain.
   * Convenience wrapper — equivalent to calling `tracer.flush(chain, routeKind)`.
   */
  flushTrace(): RequestTrace {
    return this._tracer.flush(this._chain, this._routeKind);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _recordError(
    operation: TraceOperation,
    sanitizedInput: unknown,
    err: unknown,
    start: number,
  ): void {
    const isHtlcError = err instanceof HTLCError;
    this._tracer.record({
      operation,
      chain: this._chain,
      sanitizedInput: redactSecrets(sanitizedInput),
      outcome: isHtlcError ? "htlc_error" : "unknown_error",
      errorCode: isHtlcError ? (err as HTLCError).code : null,
      retryable: isHtlcError ? (err as HTLCError).retryable : null,
      sanitizedResult: null,
      durationMs: Date.now() - start,
      startedAt: start,
    });
  }
}

// ── Replay helpers ────────────────────────────────────────────────────────────

/**
 * Serialize a trace to a compact JSON string suitable for storage in a log
 * line, a file, or a database field.
 *
 * The output is deterministic given the same trace — no random fields are
 * added after the traceId is generated at flush time.
 */
export function serializeTrace(trace: RequestTrace): string {
  return JSON.stringify(trace);
}

/**
 * Deserialize a trace produced by `serializeTrace`. Validates the top-level
 * shape and throws `TraceParseError` if required fields are missing.
 */
export function deserializeTrace(json: string): RequestTrace {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new TraceParseError("Trace JSON is not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TraceParseError("Trace must be a JSON object");
  }
  const r = raw as Record<string, unknown>;
  for (const required of ["traceId", "chain", "routeKind", "steps", "sessionOutcome"] as const) {
    if (!(required in r)) {
      throw new TraceParseError(`Missing required field: ${required}`);
    }
  }
  return raw as RequestTrace;
}

/**
 * Return a human-readable summary of a trace, suitable for a log line or a
 * debugging script. Does not include any step-level detail — use the full
 * trace object for that.
 */
export function summarizeTrace(trace: RequestTrace): string {
  const parts: string[] = [
    `traceId=${trace.traceId}`,
    `chain=${trace.chain}`,
    `route=${trace.routeKind}`,
    `outcome=${trace.sessionOutcome}`,
    `steps=${trace.steps.length}`,
    `durationMs=${trace.totalDurationMs}`,
  ];
  if (trace.direction) parts.push(`direction=${trace.direction}`);
  if (trace.publicOrderId) parts.push(`orderId=${trace.publicOrderId}`);
  const errors = trace.steps.filter((s) => s.outcome !== "success");
  if (errors.length > 0) {
    parts.push(`errors=${errors.map((s) => s.errorCode ?? "unknown").join(",")}`);
  }
  return parts.join(" ");
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class TraceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceParseError";
  }
}

// ── Internal utilities ────────────────────────────────────────────────────────

/**
 * Generate a pseudo-random trace ID. Uses `crypto.getRandomValues` when
 * available (browser + Node 18+), otherwise falls back to `Math.random`.
 * The ID is not cryptographically strong — it only needs to be unique enough
 * to correlate log lines.
 */
function generateTraceId(): string {
  const prefix = "trace_";
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    const buf = new Uint8Array(8);
    globalThis.crypto.getRandomValues(buf);
    return prefix + Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback for older environments.
  let hex = "";
  for (let i = 0; i < 8; i++) hex += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  return prefix + hex;
}
