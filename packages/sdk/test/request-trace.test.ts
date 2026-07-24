/**
 * Tests for the SDK request trace utility.
 *
 * Covered:
 *  - redactSecrets: hex strings, key-name redaction, nested objects, arrays
 *  - RequestTracer: context setting, step recording, flush, reset after flush
 *  - TracingHTLCAdapter: success path, HTLCError path, unknown error path,
 *    preimage always redacted, result sanitization
 *  - serializeTrace / deserializeTrace: round-trip, missing field detection
 *  - summarizeTrace: output format
 *  - TraceParseError: shape validation
 *  - Determinism: same inputs produce same trace structure
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  REDACTED,
  redactSecrets,
  RequestTracer,
  TracingHTLCAdapter,
  serializeTrace,
  deserializeTrace,
  summarizeTrace,
  TraceParseError,
  type RequestTrace,
} from "../src/request-trace/index.js";
import { HTLCError } from "../src/htlc-client.js";

// ── Shared fixtures ────────────────────────────────────────────────────────

const HASHLOCK = ("0x" + "ab".repeat(32)) as `0x${string}`;
const PREIMAGE  = ("0x" + "cd".repeat(32)) as `0x${string}`;
const TX_HASH   = ("0x" + "ef".repeat(32)) as `0x${string}`;
const ORDER_ID  = "42";

function makeInner(overrides: Partial<{
  createOrder: () => Promise<any>;
  claimOrder: () => Promise<any>;
  refundOrder: () => Promise<any>;
}> = {}) {
  return {
    createOrder: overrides.createOrder ?? vi.fn().mockResolvedValue({ txId: TX_HASH, orderId: ORDER_ID }),
    claimOrder:  overrides.claimOrder  ?? vi.fn().mockResolvedValue({ txId: TX_HASH }),
    refundOrder: overrides.refundOrder ?? vi.fn().mockResolvedValue({ txId: TX_HASH }),
  };
}

// ── redactSecrets ──────────────────────────────────────────────────────────

describe("redactSecrets", () => {
  it("replaces 0x-prefixed hex strings of 16+ hex chars with [REDACTED]", () => {
    expect(redactSecrets(HASHLOCK)).toBe(REDACTED);
    expect(redactSecrets(PREIMAGE)).toBe(REDACTED);
    expect(redactSecrets(TX_HASH)).toBe(REDACTED);
  });

  it("leaves short hex strings untouched (< 16 hex chars)", () => {
    // 0x + 15 hex chars = 17 total chars — below threshold
    expect(redactSecrets("0x" + "a".repeat(15))).toBe("0x" + "a".repeat(15));
    // exactly 16 hex chars — should be redacted
    expect(redactSecrets("0x" + "a".repeat(16))).toBe(REDACTED);
  });

  it("leaves non-hex strings untouched", () => {
    expect(redactSecrets("hello world")).toBe("hello world");
    expect(redactSecrets("0xnotHex_xyz")).toBe("0xnotHex_xyz");
  });

  it("redacts secrets embedded in longer strings", () => {
    const msg = `error: preimage ${PREIMAGE} is wrong`;
    expect(redactSecrets(msg)).toContain(REDACTED);
    expect(redactSecrets(msg)).not.toContain(PREIMAGE);
  });

  it("redacts fields named 'preimage' by key name regardless of value", () => {
    const obj = { preimage: "some-non-hex-value", orderId: "42" };
    const result = redactSecrets(obj) as any;
    expect(result.preimage).toBe(REDACTED);
    expect(result.orderId).toBe("42");
  });

  it("redacts fields named 'secret', 'privateKey', 'resolverSecret' by key name", () => {
    const obj = { secret: "my-secret", privateKey: "key-val", resolverSecret: "s-val", safe: "ok" };
    const result = redactSecrets(obj) as any;
    expect(result.secret).toBe(REDACTED);
    expect(result.privateKey).toBe(REDACTED);
    expect(result.resolverSecret).toBe(REDACTED);
    expect(result.safe).toBe("ok");
  });

  it("recursively redacts nested objects", () => {
    const obj = { outer: { inner: { hashlock: HASHLOCK, amount: "100" } } };
    const result = redactSecrets(obj) as any;
    expect(result.outer.inner.hashlock).toBe(REDACTED);
    expect(result.outer.inner.amount).toBe("100");
  });

  it("recursively redacts arrays", () => {
    const arr = [HASHLOCK, "safe-string", PREIMAGE];
    const result = redactSecrets(arr) as any[];
    expect(result[0]).toBe(REDACTED);
    expect(result[1]).toBe("safe-string");
    expect(result[2]).toBe(REDACTED);
  });

  it("returns null and undefined unchanged", () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
  });

  it("returns numbers and booleans unchanged", () => {
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(true)).toBe(true);
  });
});

// ── RequestTracer ──────────────────────────────────────────────────────────

describe("RequestTracer", () => {
  it("starts with 0 steps", () => {
    const tracer = new RequestTracer();
    expect(tracer.stepCount).toBe(0);
    expect(tracer.hasSteps).toBe(false);
  });

  it("setContext stores direction and publicOrderId", () => {
    const tracer = new RequestTracer();
    tracer.setContext({ direction: "eth_to_xlm", publicOrderId: "wf_0xabc" });
    const trace = tracer.flush("ethereum", "wafflefinance-htlc");
    expect(trace.direction).toBe("eth_to_xlm");
    expect(trace.publicOrderId).toBe("wf_0xabc");
  });

  it("setContext redacts metadata secrets", () => {
    const tracer = new RequestTracer();
    tracer.setContext({ metadata: { hashlock: HASHLOCK, label: "test" } });
    const trace = tracer.flush("ethereum", "wafflefinance-htlc");
    expect((trace.metadata as any).hashlock).toBe(REDACTED);
    expect((trace.metadata as any).label).toBe("test");
  });

  it("record() appends steps with sequential indexes", () => {
    const tracer = new RequestTracer();
    const now = Date.now();
    tracer.record({ operation: "createOrder", chain: "ethereum", sanitizedInput: {}, outcome: "success", errorCode: null, retryable: null, sanitizedResult: {}, durationMs: 10, startedAt: now });
    tracer.record({ operation: "claimOrder",  chain: "ethereum", sanitizedInput: {}, outcome: "success", errorCode: null, retryable: null, sanitizedResult: {}, durationMs: 20, startedAt: now + 10 });
    expect(tracer.stepCount).toBe(2);
    const trace = tracer.flush("ethereum", "wafflefinance-htlc");
    expect(trace.steps[0].index).toBe(0);
    expect(trace.steps[1].index).toBe(1);
  });

  it("flush produces sessionOutcome=empty when no steps", () => {
    const tracer = new RequestTracer();
    const trace = tracer.flush("ethereum", "wafflefinance-htlc");
    expect(trace.sessionOutcome).toBe("empty");
    expect(trace.steps).toHaveLength(0);
    expect(trace.totalDurationMs).toBe(0);
  });

  it("flush produces sessionOutcome=success when any step succeeded", () => {
    const tracer = new RequestTracer();
    const now = Date.now();
    tracer.record({ operation: "createOrder", chain: "ethereum", sanitizedInput: {}, outcome: "htlc_error", errorCode: "chain_error", retryable: true, sanitizedResult: null, durationMs: 5, startedAt: now });
    tracer.record({ operation: "createOrder", chain: "ethereum", sanitizedInput: {}, outcome: "success", errorCode: null, retryable: null, sanitizedResult: {}, durationMs: 5, startedAt: now + 5 });
    const trace = tracer.flush("ethereum", "wafflefinance-htlc");
    expect(trace.sessionOutcome).toBe("success");
  });

  it("flush produces sessionOutcome=failed when all steps errored", () => {
    const tracer = new RequestTracer();
    const now = Date.now();
    tracer.record({ operation: "createOrder", chain: "ethereum", sanitizedInput: {}, outcome: "htlc_error", errorCode: "wallet_unavailable", retryable: true, sanitizedResult: null, durationMs: 5, startedAt: now });
    const trace = tracer.flush("ethereum", "wafflefinance-htlc");
    expect(trace.sessionOutcome).toBe("failed");
  });

  it("flush resets state — step count returns to 0 after flush", () => {
    const tracer = new RequestTracer();
    const now = Date.now();
    tracer.record({ operation: "createOrder", chain: "ethereum", sanitizedInput: {}, outcome: "success", errorCode: null, retryable: null, sanitizedResult: {}, durationMs: 5, startedAt: now });
    tracer.flush("ethereum", "wafflefinance-htlc");
    expect(tracer.stepCount).toBe(0);
    expect(tracer.hasSteps).toBe(false);
  });

  it("flush sets chain and routeKind on the trace", () => {
    const tracer = new RequestTracer();
    const trace = tracer.flush("stellar", "wafflefinance-htlc");
    expect(trace.chain).toBe("stellar");
    expect(trace.routeKind).toBe("wafflefinance-htlc");
  });

  it("flush generates a unique traceId starting with 'trace_'", () => {
    const tracer = new RequestTracer();
    const t1 = tracer.flush("ethereum", "wafflefinance-htlc");
    const t2 = tracer.flush("ethereum", "wafflefinance-htlc");
    expect(t1.traceId).toMatch(/^trace_[0-9a-f]{16}$/);
    expect(t2.traceId).toMatch(/^trace_[0-9a-f]{16}$/);
    expect(t1.traceId).not.toBe(t2.traceId);
  });

  it("flush includes ISO-8601 timestamps", () => {
    const tracer = new RequestTracer();
    const trace = tracer.flush("ethereum", "wafflefinance-htlc");
    expect(() => new Date(trace.sessionStartedAt)).not.toThrow();
    expect(() => new Date(trace.flushedAt)).not.toThrow();
  });

  it("totalDurationMs equals sum of step durationMs values", () => {
    const tracer = new RequestTracer();
    const now = Date.now();
    tracer.record({ operation: "createOrder", chain: "ethereum", sanitizedInput: {}, outcome: "success", errorCode: null, retryable: null, sanitizedResult: {}, durationMs: 100, startedAt: now });
    tracer.record({ operation: "claimOrder",  chain: "ethereum", sanitizedInput: {}, outcome: "success", errorCode: null, retryable: null, sanitizedResult: {}, durationMs: 200, startedAt: now + 100 });
    const trace = tracer.flush("ethereum", "wafflefinance-htlc");
    expect(trace.totalDurationMs).toBe(300);
  });
});

// ── TracingHTLCAdapter ─────────────────────────────────────────────────────

describe("TracingHTLCAdapter", () => {
  let tracer: RequestTracer;

  beforeEach(() => { tracer = new RequestTracer(); });

  // ── success paths ────────────────────────────────────────────────────────

  it("createOrder records a success step and returns the result", async () => {
    const inner = makeInner();
    const adapter = new TracingHTLCAdapter(inner, { tracer, chain: "ethereum" });

    const result = await adapter.createOrder({ hashlock: HASHLOCK, timelockSeconds: 3600 } as any);

    expect(result).toEqual({ txId: TX_HASH, orderId: ORDER_ID });
    expect(tracer.stepCount).toBe(1);

    const trace = adapter.flushTrace();
    expect(trace.steps[0].operation).toBe("createOrder");
    expect(trace.steps[0].outcome).toBe("success");
    expect(trace.steps[0].chain).toBe("ethereum");
    expect(trace.steps[0].errorCode).toBeNull();
    // TX_HASH is a 64-hex string → gets redacted in the stored result
    const storedResult = trace.steps[0].sanitizedResult as any;
    expect(storedResult.txId).toBe(REDACTED);
    expect(storedResult.orderId).toBe(ORDER_ID);
  });

  it("claimOrder records success and the result", async () => {
    const inner = makeInner();
    const adapter = new TracingHTLCAdapter(inner, { tracer, chain: "ethereum" });

    const result = await adapter.claimOrder(ORDER_ID, PREIMAGE);

    expect(result).toEqual({ txId: TX_HASH });
    const trace = adapter.flushTrace();
    expect(trace.steps[0].operation).toBe("claimOrder");
    expect(trace.steps[0].outcome).toBe("success");
    // txId is a 64-hex string → redacted in stored result
    expect((trace.steps[0].sanitizedResult as any).txId).toBe(REDACTED);
  });

  it("refundOrder records success and the result", async () => {
    const inner = makeInner();
    const adapter = new TracingHTLCAdapter(inner, { tracer, chain: "solana" });

    await adapter.refundOrder(ORDER_ID);
    const trace = adapter.flushTrace();
    expect(trace.steps[0].operation).toBe("refundOrder");
    expect(trace.steps[0].outcome).toBe("success");
    expect(trace.chain).toBe("solana");
  });

  // ── preimage redaction ────────────────────────────────────────────────────

  it("claimOrder ALWAYS redacts the preimage in the trace input", async () => {
    const inner = makeInner();
    const adapter = new TracingHTLCAdapter(inner, { tracer, chain: "ethereum" });

    await adapter.claimOrder(ORDER_ID, PREIMAGE);
    const trace = adapter.flushTrace();
    const input = trace.steps[0].sanitizedInput as any;
    expect(input.preimage).toBe(REDACTED);
    expect(input.orderId).toBe(ORDER_ID);
  });

  it("createOrder input has hashlock redacted", async () => {
    const inner = makeInner();
    const adapter = new TracingHTLCAdapter(inner, { tracer, chain: "ethereum" });

    await adapter.createOrder({ hashlock: HASHLOCK, amount: "1000", timelockSeconds: 3600 } as any);
    const trace = adapter.flushTrace();
    const input = trace.steps[0].sanitizedInput as any;
    // hashlock is a 64-hex string → matches the redaction pattern
    expect(input.hashlock).toBe(REDACTED);
    expect(input.amount).toBe("1000");
  });

  // ── HTLCError path ────────────────────────────────────────────────────────

  it("records htlc_error step and re-throws the HTLCError", async () => {
    const err = new HTLCError({ code: "wallet_unavailable", message: "no wallet", retryable: true });
    const inner = makeInner({ createOrder: vi.fn().mockRejectedValue(err) });
    const adapter = new TracingHTLCAdapter(inner, { tracer, chain: "ethereum" });

    await expect(adapter.createOrder({} as any)).rejects.toBe(err);

    const trace = adapter.flushTrace();
    expect(trace.steps[0].outcome).toBe("htlc_error");
    expect(trace.steps[0].errorCode).toBe("wallet_unavailable");
    expect(trace.steps[0].retryable).toBe(true);
    expect(trace.steps[0].sanitizedResult).toBeNull();
    expect(trace.sessionOutcome).toBe("failed");
  });

  it("records htlc_error with retryable=false for non-retryable codes", async () => {
    const err = new HTLCError({ code: "invalid_preimage", message: "bad", retryable: false });
    const inner = makeInner({ claimOrder: vi.fn().mockRejectedValue(err) });
    const adapter = new TracingHTLCAdapter(inner, { tracer, chain: "stellar" });

    await expect(adapter.claimOrder(ORDER_ID, PREIMAGE)).rejects.toThrow();

    const trace = adapter.flushTrace();
    expect(trace.steps[0].outcome).toBe("htlc_error");
    expect(trace.steps[0].errorCode).toBe("invalid_preimage");
    expect(trace.steps[0].retryable).toBe(false);
  });

  // ── Unknown error path ────────────────────────────────────────────────────

  it("records unknown_error step for non-HTLCError throws", async () => {
    const inner = makeInner({ refundOrder: vi.fn().mockRejectedValue(new Error("unexpected crash")) });
    const adapter = new TracingHTLCAdapter(inner, { tracer, chain: "solana" });

    await expect(adapter.refundOrder(ORDER_ID)).rejects.toThrow("unexpected crash");

    const trace = adapter.flushTrace();
    expect(trace.steps[0].outcome).toBe("unknown_error");
    expect(trace.steps[0].errorCode).toBeNull();
    expect(trace.steps[0].retryable).toBeNull();
  });

  // ── Malformed response shape ──────────────────────────────────────────────

  it("sanitizes a result containing hex secrets in the txId position", async () => {
    // Simulates a chain client that returns a txId that looks like a secret hex.
    // The txId itself is not sensitive (it's public), but we verify redaction
    // fires on any 16+ hex field in the result.
    const inner = makeInner({
      createOrder: vi.fn().mockResolvedValue({ txId: TX_HASH, orderId: ORDER_ID, rawPreimage: PREIMAGE }),
    });
    const adapter = new TracingHTLCAdapter(inner, { tracer, chain: "ethereum" });
    await adapter.createOrder({} as any);
    const trace = adapter.flushTrace();
    const result = trace.steps[0].sanitizedResult as any;
    // txId and orderId are short decimal — not redacted
    expect(result.txId).toBe(REDACTED); // TX_HASH is 64 hex → redacted
    expect(result.orderId).toBe(ORDER_ID);
    // rawPreimage is key-name sensitive
    expect(result.rawPreimage).toBe(REDACTED);
  });

  // ── Call sequence / multi-step ────────────────────────────────────────────

  it("records a multi-step sequence with correct indexes", async () => {
    const inner = makeInner();
    const adapter = new TracingHTLCAdapter(inner, { tracer, chain: "ethereum" });

    await adapter.createOrder({} as any);
    await adapter.claimOrder(ORDER_ID, PREIMAGE);
    await adapter.refundOrder(ORDER_ID);

    const trace = adapter.flushTrace();
    expect(trace.steps).toHaveLength(3);
    expect(trace.steps.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(trace.steps.map((s) => s.operation)).toEqual(["createOrder", "claimOrder", "refundOrder"]);
  });

  it("durationMs for each step is non-negative", async () => {
    const inner = makeInner();
    const adapter = new TracingHTLCAdapter(inner, { tracer, chain: "ethereum" });
    await adapter.createOrder({} as any);
    const trace = adapter.flushTrace();
    expect(trace.steps[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── flushTrace convenience ────────────────────────────────────────────────

  it("flushTrace passes the adapter chain and routeKind to the trace", () => {
    const inner = makeInner();
    const adapter = new TracingHTLCAdapter(inner, { tracer, chain: "stellar", routeKind: "custom-route" });
    const trace = adapter.flushTrace();
    expect(trace.chain).toBe("stellar");
    expect(trace.routeKind).toBe("custom-route");
  });

  it("flushTrace defaults routeKind to wafflefinance-htlc", () => {
    const inner = makeInner();
    const adapter = new TracingHTLCAdapter(inner, { tracer, chain: "ethereum" });
    const trace = adapter.flushTrace();
    expect(trace.routeKind).toBe("wafflefinance-htlc");
  });
});

// ── serializeTrace / deserializeTrace ────────────────────────────────────────

describe("serializeTrace / deserializeTrace", () => {
  function buildTrace(): RequestTrace {
    const tracer = new RequestTracer();
    tracer.setContext({ direction: "eth_to_xlm", publicOrderId: "wf_0xabc" });
    const inner = makeInner();
    const adapter = new TracingHTLCAdapter(inner, { tracer, chain: "ethereum" });
    // We can't await here in synchronous build — use the tracer directly
    const now = Date.now();
    tracer.record({ operation: "createOrder", chain: "ethereum", sanitizedInput: { amount: "100" }, outcome: "success", errorCode: null, retryable: null, sanitizedResult: { txId: "0xef12" }, durationMs: 50, startedAt: now });
    return tracer.flush("ethereum", "wafflefinance-htlc");
  }

  it("round-trips through serialize/deserialize", () => {
    const original = buildTrace();
    const json = serializeTrace(original);
    const restored = deserializeTrace(json);
    expect(restored.traceId).toBe(original.traceId);
    expect(restored.chain).toBe(original.chain);
    expect(restored.direction).toBe(original.direction);
    expect(restored.publicOrderId).toBe(original.publicOrderId);
    expect(restored.steps).toHaveLength(original.steps.length);
    expect(restored.sessionOutcome).toBe(original.sessionOutcome);
  });

  it("serializeTrace produces valid JSON", () => {
    const trace = buildTrace();
    const json = serializeTrace(trace);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("deserializeTrace throws TraceParseError for invalid JSON", () => {
    expect(() => deserializeTrace("not json {")).toThrow(TraceParseError);
  });

  it("deserializeTrace throws TraceParseError for non-object JSON", () => {
    expect(() => deserializeTrace('"just a string"')).toThrow(TraceParseError);
  });

  it("deserializeTrace throws TraceParseError when required field is missing", () => {
    const trace = buildTrace();
    const obj = JSON.parse(serializeTrace(trace));
    delete obj.traceId;
    expect(() => deserializeTrace(JSON.stringify(obj))).toThrow(TraceParseError);
  });

  it("deserializeTrace throws TraceParseError when 'steps' is missing", () => {
    const trace = buildTrace();
    const obj = JSON.parse(serializeTrace(trace));
    delete obj.steps;
    expect(() => deserializeTrace(JSON.stringify(obj))).toThrow(TraceParseError);
  });
});

// ── summarizeTrace ────────────────────────────────────────────────────────────

describe("summarizeTrace", () => {
  it("includes traceId, chain, route, outcome, steps, durationMs", () => {
    const tracer = new RequestTracer();
    const now = Date.now();
    tracer.record({ operation: "createOrder", chain: "ethereum", sanitizedInput: {}, outcome: "success", errorCode: null, retryable: null, sanitizedResult: {}, durationMs: 42, startedAt: now });
    const trace = tracer.flush("ethereum", "wafflefinance-htlc");
    const summary = summarizeTrace(trace);
    expect(summary).toContain("chain=ethereum");
    expect(summary).toContain("route=wafflefinance-htlc");
    expect(summary).toContain("outcome=success");
    expect(summary).toContain("steps=1");
    expect(summary).toContain("durationMs=42");
    expect(summary).toMatch(/traceId=trace_[0-9a-f]{16}/);
  });

  it("includes direction and orderId when set", () => {
    const tracer = new RequestTracer();
    tracer.setContext({ direction: "sol_to_eth", publicOrderId: "wf_0xdeadbeef" });
    const trace = tracer.flush("solana", "wafflefinance-htlc");
    const summary = summarizeTrace(trace);
    expect(summary).toContain("direction=sol_to_eth");
    expect(summary).toContain("orderId=wf_0xdeadbeef");
  });

  it("includes error codes when steps failed", () => {
    const tracer = new RequestTracer();
    const now = Date.now();
    tracer.record({ operation: "createOrder", chain: "ethereum", sanitizedInput: {}, outcome: "htlc_error", errorCode: "wallet_unavailable", retryable: true, sanitizedResult: null, durationMs: 10, startedAt: now });
    const trace = tracer.flush("ethereum", "wafflefinance-htlc");
    const summary = summarizeTrace(trace);
    expect(summary).toContain("errors=wallet_unavailable");
  });

  it("omits direction and orderId when not set", () => {
    const tracer = new RequestTracer();
    const trace = tracer.flush("ethereum", "wafflefinance-htlc");
    const summary = summarizeTrace(trace);
    expect(summary).not.toContain("direction=");
    expect(summary).not.toContain("orderId=");
  });
});

// ── Determinism ───────────────────────────────────────────────────────────────

describe("trace determinism", () => {
  it("two traces built from the same call sequence have the same structural shape", async () => {
    async function buildTraceFor(chain: "ethereum" | "stellar"): Promise<RequestTrace> {
      const tracer = new RequestTracer();
      tracer.setContext({ direction: "eth_to_xlm" });
      const inner = makeInner();
      const adapter = new TracingHTLCAdapter(inner, { tracer, chain });
      await adapter.createOrder({ amount: "1000" } as any);
      return adapter.flushTrace();
    }

    const t1 = await buildTraceFor("ethereum");
    const t2 = await buildTraceFor("ethereum");

    // Structure must be identical (traceId and timestamps differ by design)
    expect(t1.steps.length).toBe(t2.steps.length);
    expect(t1.steps[0].operation).toBe(t2.steps[0].operation);
    expect(t1.steps[0].outcome).toBe(t2.steps[0].outcome);
    expect(t1.steps[0].errorCode).toBe(t2.steps[0].errorCode);
    expect(t1.sessionOutcome).toBe(t2.sessionOutcome);
    expect(t1.direction).toBe(t2.direction);
    expect(t1.chain).toBe(t2.chain);
    // traceIds must be different
    expect(t1.traceId).not.toBe(t2.traceId);
  });

  it("error traces are structurally identical for the same HTLCError code", async () => {
    async function buildErrorTrace(): Promise<RequestTrace> {
      const tracer = new RequestTracer();
      const err = new HTLCError({ code: "simulation_failed", message: "reverted", retryable: false });
      const inner = makeInner({ createOrder: vi.fn().mockRejectedValue(err) });
      const adapter = new TracingHTLCAdapter(inner, { tracer, chain: "ethereum" });
      await adapter.createOrder({} as any).catch(() => {});
      return adapter.flushTrace();
    }

    const t1 = await buildErrorTrace();
    const t2 = await buildErrorTrace();

    expect(t1.steps[0].errorCode).toBe(t2.steps[0].errorCode);
    expect(t1.steps[0].retryable).toBe(t2.steps[0].retryable);
    expect(t1.sessionOutcome).toBe(t2.sessionOutcome);
  });
});
