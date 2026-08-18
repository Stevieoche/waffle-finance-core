# Technical Design: SSE Order Events

## Overview

This design adds real-time Server-Sent Events (SSE) push delivery to the WaffleFinance coordinator. Clients currently poll `GET /api/orders/history` every 15 s. With SSE, they connect once and receive order state transitions as they happen.

The implementation follows the layered pattern already established in the codebase:

- **Backend**: `SseBroker` (new service) + `GET /api/orders/:id/events` route wired into the existing `OrderService` transition methods
- **Frontend**: `createSseTransport` (new `OrderEventTransport` implementation) + `useOrderStream` hook using the existing `mergeTransports` + `createPollingTransport` primitives
- **Multi-instance**: optional Redis Pub/Sub adapter toggled by `REDIS_URL`; single-instance mode requires no external dependency

No existing interfaces are broken. All new coordinator wiring passes through `AppDeps` in `app.ts`.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  coordinator process                                         │
│                                                             │
│  OrderService.recordSrcLock()  ─────────────────────────►  │
│  OrderService.recordDstLock()  ──────┐                      │
│  OrderService.recordSecret()   ──────┼──► SseBroker         │
│  OrderService.markStatus()     ──────┘    │                  │
│                                           │ broadcast()      │
│                                           ▼                  │
│                                  SubscriberRegistry          │
│                                    (Map<orderId, Set<Res>>)  │
│                                           │                  │
│                               ┌───────────┴──────────┐      │
│                               │   ReplayBuffer        │      │
│                               │  (circular, 50/order) │      │
│                               └───────────────────────┘      │
│                                           │                  │
│                                    Redis Pub/Sub adapter      │
│                                    (optional, REDIS_URL)      │
└───────────────────────┬─────────────────────────────────────┘
                        │  text/event-stream
                        ▼
              GET /api/orders/:id/events
                        │
              ┌─────────▼──────────┐
              │   Browser / Client  │
              │   EventSource       │
              │   createSseTransport│
              │   useOrderStream    │
              └────────────────────┘
```

---

## Component Design

### 1. `SseBroker` — `coordinator/src/sse/sse-broker.ts`

The central hub. Owns the subscriber registry and replay buffer. Has no dependency on Express — it only needs `http.ServerResponse`-compatible write handles, so it is fully unit-testable without a running server.

```typescript
export interface SseEvent {
  id: number;          // monotonic per-order integer
  event: SseEventType; // 'OrderCreated' | 'OrderClaimed' | 'OrderRefunded'
                       // | 'SecretRevealed' | 'StatusChanged' | 'ping' | 'shutdown' | 'replay-gap'
  data: SseEventData;  // typed union — see Event Schema section
  timestamp: number;   // Date.now()
}

export type SseEventType =
  | 'OrderCreated'
  | 'OrderClaimed'
  | 'OrderRefunded'
  | 'SecretRevealed'
  | 'StatusChanged'
  | 'ping'
  | 'shutdown'
  | 'replay-gap';

export interface SseBroker {
  /**
   * Register a new SSE subscriber for an order.
   * Returns a cleanup function — call it on client disconnect.
   */
  subscribe(orderId: string, res: SseResponseHandle, lastEventId?: number): () => void;

  /** Broadcast a typed event to all local subscribers for orderId. */
  broadcast(orderId: string, event: Omit<SseEvent, 'id'>): void;

  /** Current subscriber count (for health/metrics). */
  readonly subscriberCount: number;

  /** Graceful shutdown — send shutdown frames to all open streams. */
  shutdown(): void;
}

export interface SseResponseHandle {
  write(chunk: string): boolean;
  on(event: 'close', listener: () => void): this;
  writableEnded: boolean;
}
```

**Implementation details:**

- `SubscriberRegistry`: `Map<orderId, Set<SseResponseHandle>>`. Adding/removing from a Set is O(1).
- `ReplayBuffer`: `Map<orderId, SseEvent[]>`. Each array is a circular buffer capped at 50. A per-order event counter provides the `id` field.
- `keepAlive`: a single `setInterval` (30 s) iterates all active subscribers and writes `: ping\n\n` to each.
- `maxSubscribers`: checked in `subscribe()`; returns false to signal 503 when at 1 000.
- On terminal event broadcast, the broker calls `res.end()` after writing the frame and removes the subscriber.

### 2. `RedisAdapter` — `coordinator/src/sse/redis-adapter.ts`

Optional. Loaded at startup only when `process.env.REDIS_URL` is set. Wraps `ioredis` (to be added as a devDependency).

```typescript
export interface SseRedisAdapter {
  /** Publish an event to the Redis channel for this orderId. */
  publish(orderId: string, event: SseEvent): Promise<void>;
  /** Subscribe to all order-event channels; calls onMessage for each. */
  onMessage(cb: (orderId: string, event: SseEvent) => void): void;
  /** Disconnect cleanly. */
  close(): Promise<void>;
}
```

Channel naming: `order-events:{orderId}` (one channel per order).

The broker calls `redisAdapter.publish()` after every local broadcast. The adapter's `onMessage` callback calls `broker.broadcast()` locally, making remote events arrive exactly like local ones.

**Failure mode**: if `ioredis` emits an `error` event, the adapter logs a warning and marks itself as degraded. The broker continues operating in local-only mode. Reconnection is handled automatically by `ioredis`.

### 3. SSE Route — `coordinator/src/server/routes/sse.ts`

Mounts as `GET /api/orders/:id/events`. Registered in `app.ts` alongside the existing routes.

**Handler flow:**

```
1. Validate :id with orderIdSchema (Zod) → 400 on failure
2. orders.get(id) → 404 if not found
3. Check broker.subscriberCount < MAX_SUBSCRIBERS → 503 if full
4. Set response headers:
     Content-Type: text/event-stream
     Cache-Control: no-cache
     Connection: keep-alive
     X-Accel-Buffering: no
5. Parse Last-Event-ID header → integer or undefined
6. broker.subscribe(id, res, lastEventId) → registers cleanup on 'close'
7. Send initial 'connected' comment: ': connected\n\n'
8. If lastEventId provided, replay buffered events > lastEventId
9. Return (connection stays open — Express does not end the response)
```

The route factory receives `SseBroker` via closure, matching the existing pattern (e.g. `ordersRoutes(orders, log, abuseDetector)`).

### 4. `OrderService` wiring — inject `SseBroker` at construction

`OrderService` constructor gains an optional `sseBroker?: SseBroker` parameter. After each successful transition, it calls `sseBroker?.broadcast(publicId, event)`. No call sites outside `OrderService` need to change.

```typescript
// In recordSrcLock — after repo.recordSrcLock():
this.sseBroker?.broadcast(input.publicId, {
  event: 'OrderCreated',
  data: buildOrderCreatedPayload(order, input),
  timestamp: Date.now(),
});
```

This keeps the broadcast fire-and-forget: `broadcast()` is synchronous (writing to existing response handles), so it cannot throw into the OrderService call chain.

### 5. `createSseTransport` — `frontend/src/lib/sseTransport.ts`

Implements `OrderEventTransport` using the browser's `EventSource` API. Normalises SSE event names to `OrderEventPayload` via `createOrderEventPayload`.

```typescript
export function createSseTransport(
  orderId: string,
  apiBaseUrl: string
): OrderEventTransport {
  return {
    start(emitter) {
      if (typeof EventSource === 'undefined') {
        emitter.fail({ code: 'network', message: 'EventSource not available', retryable: false });
        return () => {};
      }

      const url = `${apiBaseUrl}/api/orders/${encodeURIComponent(orderId)}/events`;
      const es = new EventSource(url);

      const HTLC_EVENTS = ['OrderCreated', 'OrderClaimed', 'OrderRefunded', 'SecretRevealed', 'StatusChanged'];
      for (const eventName of HTLC_EVENTS) {
        es.addEventListener(eventName, (e: MessageEvent) => {
          try {
            const raw = JSON.parse(e.data);
            emitter.update(createOrderEventPayload({ orderId, status: raw.status ?? eventName, source: 'sse', ...raw }));
          } catch {
            // Malformed frame — skip, do not fail the stream
          }
        });
      }

      es.onerror = () => {
        const retryable = typeof navigator !== 'undefined' ? !navigator.onLine : true;
        emitter.fail({ code: 'network', message: 'SSE connection error', retryable });
      };

      return () => es.close();
    },
  };
}
```

### 6. `useOrderStream` — `frontend/src/hooks/useOrderStream.ts`

Thin wrapper around `useOrderSubscription` that composes SSE + polling via `mergeTransports`.

```typescript
export function useOrderStream(orderId: string | null): UseOrderSubscriptionResult {
  const apiBaseUrl = useApiBaseUrl(); // existing config hook

  const transport = useMemo(() => {
    if (!orderId) return null;
    return mergeTransports(
      createSseTransport(orderId, apiBaseUrl),
      createPollingTransport({
        poll: () => fetchOrderHistory(apiBaseUrl, orderId),
        intervalMs: 15_000,
        immediate: true,
      })
    );
  }, [orderId, apiBaseUrl]);

  return useOrderSubscription({
    transport,
    stopWhenAllSettled: true,
    maxConsecutiveFailures: 5,
  });
}
```

When `orderId` is `null`, `transport` is `null`, and `useOrderSubscription` returns `phase: 'idle'` — matching the requirement exactly.

---

## Event Schema

All SSE frames follow this wire format:

```
id: <monotonic-integer>\n
event: <EventType>\n
data: <JSON>\n
\n
```

### `OrderCreated` (emitted on `src_locked`)

```json
{
  "orderId": "pub_abc123",
  "status": "src_locked",
  "srcChain": "ethereum",
  "srcTxHash": "0xabc...",
  "blockNumber": 12345678,
  "timelock": 1720000000,
  "timestamp": 1720000000000
}
```

### `OrderClaimed` (emitted on `dst_locked` or `secret_revealed`)

```json
{
  "orderId": "pub_abc123",
  "status": "dst_locked",
  "dstChain": "stellar",
  "dstTxHash": "abc...",
  "blockNumber": 5678,
  "timelock": 1720000200,
  "resolver": "GABC...",
  "timestamp": 1720000010000
}
```

### `OrderRefunded` (emitted on `refunded`)

```json
{
  "orderId": "pub_abc123",
  "status": "refunded",
  "txHash": "0xdef...",
  "timestamp": 1720086400000
}
```

### `SecretRevealed` (emitted from `recordSecret`)

```json
{
  "orderId": "pub_abc123",
  "preimage": "0xdeadbeef...",
  "revealedTx": "0xghi...",
  "timestamp": 1720000020000
}
```

### `StatusChanged` (all other transitions)

```json
{
  "orderId": "pub_abc123",
  "status": "completed",
  "previousStatus": "secret_revealed",
  "timestamp": 1720000030000
}
```

### Keep-alive ping

```
: ping

```

### Reconnect gap

```
id: <N>
event: replay-gap
data: {"message":"Events missed. Re-fetch order state via GET /api/orders/:id"}

```

---

## Components and Interfaces

### `SseBroker` interface (`coordinator/src/sse/sse-broker.ts`)

```typescript
export interface SseBroker {
  subscribe(orderId: string, res: SseResponseHandle, lastEventId?: number): () => void;
  broadcast(orderId: string, event: Omit<SseEvent, 'id'>): void;
  readonly subscriberCount: number;
  shutdown(): void;
}

export interface SseResponseHandle {
  write(chunk: string): boolean;
  on(event: 'close', listener: () => void): this;
  writableEnded: boolean;
}
```

### `SseRedisAdapter` interface (`coordinator/src/sse/redis-adapter.ts`)

```typescript
export interface SseRedisAdapter {
  publish(orderId: string, event: SseEvent): Promise<void>;
  onMessage(cb: (orderId: string, event: SseEvent) => void): void;
  close(): Promise<void>;
}
```

### `OrderEventTransport` implementation (`frontend/src/lib/sseTransport.ts`)

Satisfies the existing `OrderEventTransport` interface from `orderEventStream.ts`:

```typescript
export function createSseTransport(
  orderId: string,
  apiBaseUrl: string
): OrderEventTransport
```

### `useOrderStream` hook (`frontend/src/hooks/useOrderStream.ts`)

```typescript
export function useOrderStream(
  orderId: string | null
): UseOrderSubscriptionResult
```

Returns the same shape as `useOrderSubscription` — no new return type needed.

---

## Data Models

### `SseEvent` (wire + in-memory)

```typescript
export interface SseEvent {
  /** Monotonically increasing integer scoped to one orderId. */
  id: number;
  /** Discriminant used as the SSE `event:` field. */
  event: SseEventType;
  /** Typed payload — JSON-serialised into the SSE `data:` field. */
  data: SseEventData;
  /** Unix milliseconds — echoed inside `data` as `timestamp`. */
  timestamp: number;
}

export type SseEventType =
  | 'OrderCreated'
  | 'OrderClaimed'
  | 'OrderRefunded'
  | 'SecretRevealed'
  | 'StatusChanged'
  | 'ping'
  | 'shutdown'
  | 'replay-gap';

export type SseEventData =
  | OrderCreatedData
  | OrderClaimedData
  | OrderRefundedData
  | SecretRevealedData
  | StatusChangedData
  | ReplayGapData
  | Record<string, never>; // ping / shutdown carry no data

export interface OrderCreatedData {
  orderId: string; status: 'src_locked';
  srcChain: string; srcTxHash: string;
  blockNumber: number; timelock: number; timestamp: number;
}

export interface OrderClaimedData {
  orderId: string; status: 'dst_locked' | 'secret_revealed';
  dstChain: string; dstTxHash: string;
  blockNumber: number; timelock: number;
  resolver: string | null; timestamp: number;
}

export interface OrderRefundedData {
  orderId: string; status: 'refunded';
  txHash: string; timestamp: number;
}

export interface SecretRevealedData {
  orderId: string; preimage: string;
  revealedTx: string; timestamp: number;
}

export interface StatusChangedData {
  orderId: string; status: string;
  previousStatus: string | null; timestamp: number;
}

export interface ReplayGapData {
  message: string;
}
```

### `SubscriberRegistry` (in-process)

```typescript
// coordinator/src/sse/sse-broker.ts (internal)
type SubscriberRegistry = Map<string, Set<SseResponseHandle>>;
```

### `ReplayBuffer` (in-process)

```typescript
// coordinator/src/sse/sse-broker.ts (internal)
type ReplayBuffer = Map<string, SseEvent[]>; // capped at REPLAY_BUFFER_SIZE = 50
```

### Per-order event counter (in-process)

```typescript
type EventCounters = Map<string, number>; // orderId → next event id
```

---

## Correctness Properties

- **No lost events between subscribe and broadcast**: The `subscribe()` call registers the response handle before returning, and `broadcast()` is synchronous. Since Node.js is single-threaded, no broadcast can occur between registration and the caller sending headers.
- **No double-dispatch on reconnect**: Replay sends only events with `id > lastEventId`. The monotonic per-order counter guarantees strict ordering.
- **No leaked subscribers on disconnect**: The `res.on('close', cleanup)` handler is registered inside `subscribe()` before returning; it removes the handle from the registry immediately.
- **No crash propagation from broadcast**: `broadcast()` catches all write errors internally and removes the offending subscriber. `OrderService` transition methods are never interrupted.
- **Idempotent `shutdown()`**: Iterates a snapshot of all active subscribers; calling twice is safe because `writableEnded` guards against double-close.

---

## File Map

| File | Action |
|---|---|
| `coordinator/src/sse/sse-broker.ts` | New — `SseBroker` class, `SubscriberRegistry`, `ReplayBuffer`, keep-alive timer |
| `coordinator/src/sse/redis-adapter.ts` | New — optional Redis Pub/Sub adapter |
| `coordinator/src/sse/event-builders.ts` | New — typed payload builder functions for each event type |
| `coordinator/src/sse/index.ts` | New — barrel export |
| `coordinator/src/server/routes/sse.ts` | New — `GET /api/orders/:id/events` route factory |
| `coordinator/src/server/app.ts` | Modified — mount SSE route, accept `sseBroker` in `AppDeps` |
| `coordinator/src/services/order-service.ts` | Modified — accept optional `sseBroker` in constructor, call `broadcast` after each transition |
| `coordinator/src/index.ts` | Modified — construct `SseBroker`, inject into `OrderService` and route, wire `SIGTERM` handler |
| `coordinator/test/sse-broker.test.ts` | New — unit tests for broker, replay buffer, keep-alive, subscriber cap |
| `coordinator/test/sse-route.test.ts` | New — supertest integration tests for the SSE endpoint |
| `coordinator/test/sse-e2e.test.ts` | New — E2E push delivery tests using `eventsource` npm package |
| `coordinator/docs/SSE_API.md` | New — API documentation |
| `frontend/src/lib/sseTransport.ts` | New — `createSseTransport` implementing `OrderEventTransport` |
| `frontend/src/hooks/useOrderStream.ts` | New — `useOrderStream` hook |
| `frontend/src/lib/sseTransport.test.ts` | New — unit tests for SSE transport |
| `frontend/src/hooks/useOrderStream.test.tsx` | New — hook tests |

---

## Data Flow: State Transition → Client Frame

```
1. Chain listener calls orders.recordSrcLock(input)
2. OrderService validates + writes to DB
3. OrderService calls sseBroker.broadcast(publicId, {event:'OrderCreated', data:{...}})
4. SseBroker.broadcast():
   a. Assigns next event id for this orderId (atomic counter)
   b. Pushes to ReplayBuffer
   c. For each subscriber res in registry[orderId]:
      - Writes SSE frame string to res
      - On write error: removes subscriber from registry
   d. If Redis adapter present: publishes to 'order-events:{orderId}'
5. Client EventSource fires 'OrderCreated' event listener
6. createSseTransport calls emitter.update(payload)
7. subscribeToOrderEvents.reconcile() diffs vs last known status
8. React state updates via useOrderSubscription reducer
9. Component re-renders with updated order map
```

---

## `AppDeps` Changes

```typescript
// app.ts — additions to AppDeps interface
export interface AppDeps {
  // ... existing fields ...
  /** When provided, SSE endpoint is mounted and OrderService broadcasts to it. */
  sseBroker?: SseBroker;
}
```

The SSE route is mounted only when `sseBroker` is provided, matching the optional-injection pattern used for `auditRepo`, `orderExport`, and `runReconcile`.

---

## Concurrency and Safety

- **Write race**: `broadcast()` iterates a snapshot (`Array.from(set)`) of the subscriber set, so a disconnect mid-iteration cannot produce a concurrent modification.
- **OrderService calls**: `broadcast()` is synchronous and cannot throw (write errors are caught internally), so it cannot delay or fail OrderService transitions.
- **Keep-alive timer**: uses a single shared `setInterval`; the callback iterates all subscribers and skips any whose `writableEnded` is true (already disconnected but cleanup not yet fired).
- **Replay buffer**: append is O(1) with a capped array. Reads are O(n) where n ≤ 50. No lock needed because Node.js is single-threaded.

---

## Multi-Instance Deployment

When `REDIS_URL` is set:

```
Instance A                          Instance B
─────────────────────────────       ─────────────────────────────
OrderService.recordSrcLock()         Client connected here
       │                                     │
       ▼                                     │
SseBroker.broadcast()                        │
       │                                     │
       ├─ local subscribers (0)              │
       │                                     │
       └─► Redis PUBLISH                     │
           order-events:pub_abc123           │
                   │                         │
                   └──────────────────────►  │
                                      SseBroker onMessage
                                             │
                                      local subscribers (1)
                                             │
                                      res.write(frame)
                                             │
                                      Client receives event ✓
```

Single-instance mode (no `REDIS_URL`): no `ioredis` import occurs at all; the `RedisAdapter` module is never loaded.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| `orders.get(id)` returns null | HTTP 404 before upgrading to stream |
| Subscriber cap (1000) reached | HTTP 503, `X-WF-Error: subscriber-limit` header |
| Write to disconnected response | Caught in `broadcast()`; subscriber removed silently |
| Redis connection lost | Broker logs warning, continues local-only; ioredis reconnects automatically |
| `SIGTERM` received | Broker iterates all subscribers, writes `event: shutdown` frame, calls `res.end()` |
| Terminal order status | Final event sent; `res.end()` called; subscriber removed |

---

## Testing Strategy

### Unit tests (`coordinator/test/sse-broker.test.ts`)
- Subscribers receive broadcast frames
- Replay buffer respects 50-event cap
- Keep-alive ping emitted on idle streams
- Subscriber cap enforced at 1 000
- Terminal broadcast closes the stream and removes subscriber
- Disconnected subscriber removed on next broadcast

### Integration tests (`coordinator/test/sse-route.test.ts`)
- `GET /api/orders/:id/events` returns 200 + `text/event-stream`
- Unknown order returns 404 before upgrade
- Malformed id returns 400
- `Last-Event-ID` header triggers replay
- `replay-gap` frame returned when Last-Event-ID is too old

### E2E tests (`coordinator/test/sse-e2e.test.ts`)
- Full `recordSrcLock` → `OrderCreated` frame received within 2 s
- All five state transitions produce correct event sequence
- Reconnect with `Last-Event-ID` receives only missed events
- Keep-alive ping within 31 s on idle connection
- Disconnect removes subscriber from registry within 1 s

### Frontend unit tests
- `createSseTransport` calls `emitter.update` on each named event
- `createSseTransport` calls `emitter.fail` on `onerror` with correct `retryable`
- `createSseTransport` returns no-op when `EventSource` unavailable
- `useOrderStream(null)` returns `phase: 'idle'`
- `useOrderStream` calls `unsubscribe` on unmount

---

## New Dependencies

| Package | Where | Reason |
|---|---|---|
| `ioredis` | `coordinator` (optional, runtime) | Redis Pub/Sub for multi-instance mode. Only imported when `REDIS_URL` is set. |
| `eventsource` | `coordinator` (devDependency) | Node.js `EventSource` polyfill for E2E tests. |

No new frontend dependencies. `EventSource` is a browser native API.
