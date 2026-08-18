# SSE API — Real-Time Order Events

The WaffleFinance coordinator exposes a Server-Sent Events endpoint that pushes
order state changes to connected clients in real time, eliminating the need to
poll `GET /api/orders/history`.

---

## Endpoint

```
GET /api/orders/:id/events
```

### Path parameter

| Parameter | Type   | Description                                                |
|-----------|--------|------------------------------------------------------------|
| `id`      | string | Order public ID in the format `wf_0x{64 hex chars}`       |

### Required headers

| Header   | Value              | Notes                                    |
|----------|--------------------|------------------------------------------|
| `Accept` | `text/event-stream`| Signals to the server to upgrade to SSE |

### Response headers

| Header                | Value              |
|-----------------------|--------------------|
| `Content-Type`        | `text/event-stream`|
| `Cache-Control`       | `no-cache`         |
| `Connection`          | `keep-alive`       |
| `X-Accel-Buffering`   | `no`               |

The `X-Accel-Buffering: no` header disables Nginx proxy buffering so frames
reach the client immediately rather than accumulating in a proxy buffer.

---

## SSE frame format

Every event follows the standard SSE text protocol:

```
id: <monotonic-integer>
event: <EventType>
data: <JSON object>

```

The `id` field is a monotonically increasing integer scoped to the order. Clients
should record the last seen `id` and send it as `Last-Event-ID` on reconnect to
receive any missed events.

---

## Event types

### `OrderCreated`

Emitted when the order's source-side lock is recorded (`src_locked`).

```json
{
  "orderId": "wf_0xabc...",
  "status": "src_locked",
  "srcChain": "ethereum",
  "srcTxHash": "0x...",
  "blockNumber": 12345678,
  "timelock": 1720000000,
  "timestamp": 1720000000000
}
```

| Field         | Type   | Description                          |
|---------------|--------|--------------------------------------|
| `orderId`     | string | Order public ID                      |
| `status`      | string | Always `"src_locked"`                |
| `srcChain`    | string | Source blockchain (`ethereum`, etc.) |
| `srcTxHash`   | string | Source lock transaction hash         |
| `blockNumber` | number | Block/slot where the lock landed     |
| `timelock`    | number | Unix seconds — timelock expiry       |
| `timestamp`   | number | Unix ms when the event was generated |

---

### `OrderClaimed`

Emitted when the destination-side lock is recorded (`dst_locked`) or the secret
is revealed (`secret_revealed`).

```json
{
  "orderId": "wf_0xabc...",
  "status": "dst_locked",
  "dstChain": "stellar",
  "dstTxHash": "abc...",
  "blockNumber": 5678,
  "timelock": 1720000200,
  "resolver": "GABC...",
  "timestamp": 1720000010000
}
```

| Field         | Type            | Description                               |
|---------------|-----------------|-------------------------------------------|
| `status`      | string          | `"dst_locked"` or `"secret_revealed"`     |
| `dstChain`    | string          | Destination blockchain                    |
| `resolver`    | string \| null  | Resolver address if known                 |

---

### `OrderRefunded`

Emitted when the order status transitions to `refunded`.

```json
{
  "orderId": "wf_0xabc...",
  "status": "refunded",
  "txHash": "0x...",
  "timestamp": 1720086400000
}
```

---

### `SecretRevealed`

Emitted when the preimage is recorded via `recordSecret`.

```json
{
  "orderId": "wf_0xabc...",
  "preimage": "0xdeadbeef...",
  "revealedTx": "0x...",
  "timestamp": 1720000020000
}
```

---

### `StatusChanged`

Emitted for all other status transitions (`completed`, `failed`, `expired`,
`announced`, etc.).

```json
{
  "orderId": "wf_0xabc...",
  "status": "completed",
  "previousStatus": "secret_revealed",
  "timestamp": 1720000030000
}
```

---

### Keep-alive ping

A comment line is sent every 30 seconds on idle connections to prevent proxy
and load-balancer timeouts. It is not an SSE event and carries no data:

```
: ping

```

---

### `shutdown`

Sent to all open streams when the coordinator receives `SIGTERM`. Clients
should detect this and reconnect after a brief delay.

```
id: <n>
event: shutdown
data: {}

```

---

### `replay-gap`

Sent when a reconnecting client's `Last-Event-ID` is older than the oldest
buffered event (buffer holds the last 50 events per order). The client must
re-fetch the current order state via `GET /api/orders/:id`.

```
id: <n>
event: replay-gap
data: {"message":"Events missed. Re-fetch current order state via GET /api/orders/<id>"}

```

---

## Reconnection with `Last-Event-ID`

The browser's `EventSource` API automatically sends the `Last-Event-ID` header
when reconnecting after a dropped connection. The coordinator replays any buffered
events with `id > Last-Event-ID`, so the client receives exactly the events it
missed.

```
GET /api/orders/wf_0xabc.../events
Last-Event-ID: 3
```

The replay buffer holds the last **50 events** per order. If the gap is larger
than 50 events, a `replay-gap` frame is sent instead and the client must
re-fetch the full order state.

---

## Error responses

| Status | Condition                                        | Body                                          |
|--------|--------------------------------------------------|-----------------------------------------------|
| 400    | Order ID is malformed (fails `wf_0x{64}` pattern)| `{"error":"validation_error",...}`            |
| 404    | Order ID is valid but does not exist             | `{"error":"not_found",...}`                   |
| 503    | Server-side subscriber limit (1 000) reached     | `{"error":"service_unavailable",...}` + `X-WF-Error: subscriber-limit` header |

Errors are returned as JSON before the connection upgrades to SSE, so standard
HTTP error handling applies.

---

## Multi-instance deployment

When `REDIS_URL` is set, events are forwarded across coordinator instances via
Redis Pub/Sub on the channel `order-events:{orderId}`. Clients connected to any
instance receive events generated by any other instance.

When `REDIS_URL` is not set, the coordinator operates in single-instance mode.
In this mode, sticky sessions (e.g. `ip_hash` in Nginx) are required for
clients to receive all events.

---

## Usage example (curl)

```bash
curl -N \
  -H "Accept: text/event-stream" \
  http://localhost:3001/api/orders/wf_0xabcdef.../events
```

Expected output:
```
: connected

id: 1
event: OrderCreated
data: {"orderId":"wf_0xabcdef...","status":"src_locked","srcChain":"ethereum",...}

: ping

id: 2
event: StatusChanged
data: {"orderId":"wf_0xabcdef...","status":"completed","previousStatus":"secret_revealed",...}

```

---

## Frontend: `useOrderStream` hook

See inline JSDoc in `frontend/src/hooks/useOrderStream.ts` for usage examples
and the full return type.

Quick reference:

```tsx
import { useOrderStream } from '@/hooks';

function OrderStatus({ orderId }: { orderId: string | null }) {
  const { orders, phase, error } = useOrderStream(orderId);
  const order = orderId ? orders[orderId] : null;

  if (phase === 'idle') return null;
  if (!order) return <p>Loading…</p>;

  return <p>Status: {order.status}</p>;
}
```

The hook composes SSE (primary) and 15-second polling (fallback) via
`mergeTransports`. If SSE is blocked or fails, polling continues silently.
The `orderId` parameter must be referentially stable — store it in `useState`
rather than constructing a new string on every render.
