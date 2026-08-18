# Implementation Plan: SSE Order Events

## Overview

Implement real-time Server-Sent Events push delivery for order state changes in the WaffleFinance coordinator. The work is split into 9 groups that can be executed sequentially: core types, broker, Redis adapter, HTTP route, wiring into the app, E2E tests, frontend transport, React hook, and documentation.

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1"] },
    { "wave": 2, "tasks": ["2", "7"] },
    { "wave": 3, "tasks": ["3", "4", "8"] },
    { "wave": 4, "tasks": ["5"] },
    { "wave": 5, "tasks": ["6", "9"] }
  ]
}
```

Backend tasks (1–6) and frontend tasks (7–9) are independent and can be worked in parallel. Wave 2 runs `2` (SseBroker) and `7` (frontend transport) concurrently. Wave 3 runs `3` (Redis adapter), `4` (SSE route), and `8` (useOrderStream hook) concurrently once their respective prerequisites are done.

## Tasks

- [ ] 1. SSE core types and event builders
  - [ ] 1.1 Create `coordinator/src/sse/event-builders.ts` with typed payload builder functions (`buildOrderCreatedPayload`, `buildOrderClaimedPayload`, `buildOrderRefundedPayload`, `buildSecretRevealedPayload`, `buildStatusChangedPayload`) and all `SseEvent` / `SseEventType` / `SseEventData` type definitions
  - [ ] 1.2 Create `coordinator/src/sse/index.ts` barrel export re-exporting all public types and classes from the `sse/` directory

- [ ] 2. SseBroker implementation
  - [ ] 2.1 Create `coordinator/src/sse/sse-broker.ts` implementing the `SseBroker` interface with `SubscriberRegistry` (`Map<string, Set<SseResponseHandle>>`), `ReplayBuffer` (circular buffer capped at 50 events per order), per-order event counters, and `subscribe()` / `broadcast()` / `shutdown()` methods
  - [ ] 2.2 Add keep-alive timer in `SseBroker` constructor: a single `setInterval` every 30 s that iterates all active subscribers and writes `: ping\n\n`, skipping any where `writableEnded` is true
  - [ ] 2.3 Implement subscriber cap (max 1 000): `subscribe()` returns `false` when the cap is reached; add `subscriberCount` getter
  - [ ] 2.4 Implement terminal-status auto-close in `broadcast()`: when the event type signals a terminal state, call `res.end()` after writing the frame and remove the subscriber
  - [ ] 2.5 Write unit tests in `coordinator/test/sse-broker.test.ts` covering: subscriber receives broadcast frames, replay buffer 50-event cap, keep-alive ping timing, subscriber cap enforcement, terminal broadcast closes stream, disconnected subscriber removed on next broadcast

- [ ] 3. Optional Redis Pub/Sub adapter
  - [ ] 3.1 Add `ioredis` as a runtime dependency in `coordinator/package.json`
  - [ ] 3.2 Create `coordinator/src/sse/redis-adapter.ts` implementing `SseRedisAdapter` with `publish()`, `onMessage()`, and `close()` using `ioredis`; channel naming: `order-events:{orderId}`; graceful degradation on connection loss (log warning, continue local-only)
  - [ ] 3.3 Wire `RedisAdapter` into `SseBroker`: when a `redisAdapter` option is provided to the broker constructor, call `redisAdapter.publish()` after every local broadcast and register `redisAdapter.onMessage()` to call `broker.broadcast()` for remote events

- [ ] 4. SSE HTTP route
  - [ ] 4.1 Create `coordinator/src/server/routes/sse.ts` with a `sseRoutes(orders, broker, log)` factory mounting `GET /api/orders/:id/events`; implement full handler flow: validate `:id` (400), fetch order (404), check subscriber cap (503), set SSE headers, parse `Last-Event-ID`, call `broker.subscribe()`, send `: connected\n\n`, replay buffered events if `Last-Event-ID` present
  - [ ] 4.2 Write supertest integration tests in `coordinator/test/sse-route.test.ts` covering: 200 + `text/event-stream`, 404 unknown order, 400 malformed id, `Last-Event-ID` replay, `replay-gap` frame, 503 at cap

- [ ] 5. Wire SseBroker into AppDeps and OrderService
  - [ ] 5.1 Add optional `sseBroker?: SseBroker` to `AppDeps` in `coordinator/src/server/app.ts` and mount `sseRoutes` when present
  - [ ] 5.2 Add optional `sseBroker?: SseBroker` to `OrderService` constructor; after each successful transition, call `this.sseBroker?.broadcast(publicId, buildXxxPayload(...))` fire-and-forget
  - [ ] 5.3 Update `coordinator/src/index.ts` to construct `SseBroker` (with optional `RedisAdapter` when `REDIS_URL` is set), inject into `OrderService` and `AppDeps`, and register `SIGTERM` listener calling `broker.shutdown()`

- [ ] 6. E2E push delivery tests
  - [ ] 6.1 Add `eventsource` as a devDependency in `coordinator/package.json`
  - [ ] 6.2 Create `coordinator/test/sse-e2e.test.ts`: announce order → open `EventSource` → call `recordSrcLock` → assert `OrderCreated` frame received within 2 s
  - [ ] 6.3 Add E2E test: full five-transition sequence produces correct SSE event types in order
  - [ ] 6.4 Add E2E test: reconnect with `Last-Event-ID` receives only missed events
  - [ ] 6.5 Add E2E test: keep-alive ping emitted within 31 s with no order event (use short ping interval in test config)
  - [ ] 6.6 Add E2E test: closing client connection removes subscriber from `broker.subscriberCount` within 1 s

- [ ] 7. Frontend SSE transport
  - [ ] 7.1 Create `frontend/src/lib/sseTransport.ts` implementing `createSseTransport(orderId, apiBaseUrl): OrderEventTransport`; handle `EventSource` unavailable, named event listeners for all five HTLC event types, `onerror` with `retryable` from `navigator.onLine`, and teardown closing the `EventSource`
  - [ ] 7.2 Write unit tests in `frontend/src/lib/sseTransport.test.ts`: `emitter.update` on each named event, `emitter.fail` on error with correct `retryable`, no-op when `EventSource` unavailable, `es.close()` on teardown

- [ ] 8. `useOrderStream` React hook
  - [ ] 8.1 Create `frontend/src/hooks/useOrderStream.ts` composing `createSseTransport` + `createPollingTransport` via `mergeTransports` in `useMemo`; pass merged transport to `useOrderSubscription` with `stopWhenAllSettled: true`; return `null` transport when `orderId` is `null`
  - [ ] 8.2 Write hook tests in `frontend/src/hooks/useOrderStream.test.tsx`: `null` orderId returns `phase: 'idle'`, SSE event updates `orders` map, `unsubscribe` on unmount, transport identity stable across re-renders
  - [ ] 8.3 Export `useOrderStream` from `frontend/src/hooks/index.ts`

- [ ] 9. API documentation
  - [ ] 9.1 Create `coordinator/docs/SSE_API.md` documenting URL, headers, response format, all event types with field definitions, `Last-Event-ID` reconnection, keep-alive ping, error responses (400/404/503), and a `curl` example
  - [ ] 9.2 Add JSDoc to `frontend/src/hooks/useOrderStream.ts` with usage example, return type description, fallback behaviour note, and `orderId` stability warning

## Notes

- Tasks 1–6 (coordinator backend) and tasks 7–9 (frontend) are independent tracks and can be implemented in parallel.
- Task 3 (Redis adapter) is optional for single-instance deployments. The broker works without it; the adapter is only constructed when `REDIS_URL` is present in the environment.
- `broadcast()` in `SseBroker` must never throw into `OrderService`. All write errors are caught inside the broker and result in subscriber removal only.
- The `eventsource` devDependency (task 6.1) is a Node.js polyfill for `EventSource` needed only in tests — it does not affect the production bundle.
- No new frontend production dependencies are required; `EventSource` is a browser native API.
