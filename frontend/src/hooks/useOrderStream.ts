/**
 * `useOrderStream` — real-time order updates with automatic polling fallback.
 *
 * Composes an SSE transport (primary) and a polling transport (fallback) via
 * `mergeTransports`, so the UI receives push events when SSE is available and
 * silently falls back to 15-second polling in environments where it is blocked
 * (corporate proxies, old browsers, SSE not yet deployed).
 *
 * @example
 * ```tsx
 * function OrderStatus({ orderId }: { orderId: string | null }) {
 *   const { orders, phase, error } = useOrderStream(orderId);
 *   const order = orderId ? orders[orderId] : null;
 *   if (phase === 'idle') return null;
 *   return <div>{order?.status ?? 'loading…'}</div>;
 * }
 * ```
 *
 * ## Fallback behaviour
 * The merged transport runs SSE and polling concurrently. If SSE fails
 * permanently (exhausted after 5 consecutive failures), polling keeps
 * delivering updates. The `phase` and `error` fields in the return value
 * reflect the stream's aggregate health.
 *
 * ## `orderId` stability
 * The transport is memoised on `[orderId, apiBaseUrl]`. Passing a new object
 * reference for `orderId` on every render will cause the subscription to
 * tear down and re-open each render. Store the id in `useState` or a stable
 * variable rather than constructing it inline.
 */

import { useMemo } from "react";
import {
  createPollingTransport,
  mergeTransports,
  type OrderEventTransport,
} from "../lib/orderEventStream";
import {
  useOrderSubscription,
  type UseOrderSubscriptionResult,
} from "./useOrderSubscription";
import { createSseTransport } from "../lib/sseTransport";
import { envConfig } from "../config/env";
import { createOrderEventPayload } from "../lib/orderEvents";

/**
 * Subscribe to real-time order updates for the given `orderId`.
 *
 * @param orderId  The coordinator public order ID, or `null` to watch nothing.
 *                 Must be referentially stable across renders.
 * @returns        The same shape as `useOrderSubscription`.
 */
export function useOrderStream(orderId: string | null): UseOrderSubscriptionResult {
  const apiBaseUrl = envConfig.apiBaseUrl;

  const transport = useMemo((): OrderEventTransport | null => {
    if (!orderId) return null;

    const sseTransport = createSseTransport(orderId, apiBaseUrl);

    const pollingTransport = createPollingTransport({
      poll: async () => {
        const res = await fetch(
          `${apiBaseUrl.replace(/\/$/, "")}/api/orders/${encodeURIComponent(orderId)}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Record<string, unknown>;
        return [
          createOrderEventPayload({
            orderId,
            status: data.status,
            source: "poll",
            srcTxHash: (data.src as any)?.lockTx ?? null,
            dstTxHash: (data.dst as any)?.lockTx ?? null,
            details: data,
          }),
        ];
      },
      intervalMs: 15_000,
      immediate: true,
    });

    return mergeTransports(sseTransport, pollingTransport);
  }, [orderId, apiBaseUrl]);

  return useOrderSubscription({
    transport,
    stopWhenAllSettled: true,
    maxConsecutiveFailures: 5,
  });
}
