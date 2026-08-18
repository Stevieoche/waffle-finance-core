/**
 * Optional Redis Pub/Sub adapter for multi-instance SSE delivery.
 *
 * When REDIS_URL is set, every SSE event broadcast by one coordinator instance
 * is published to the Redis channel `order-events:{orderId}`. All instances
 * subscribe to the wildcard pattern `order-events:*` and forward received
 * messages to their local subscriber registries.
 *
 * When REDIS_URL is not set, this module is never imported and the broker
 * operates in single-instance mode with no external dependency.
 *
 * Failure mode: if the Redis connection is lost, the adapter logs a warning
 * and continues. ioredis handles reconnection automatically. The broker
 * continues delivering events locally during any Redis outage.
 */

import type { SseEvent } from "./event-builders.js";
import type { Logger } from "pino";

export interface SseRedisAdapter {
  publish(orderId: string, event: SseEvent): Promise<void>;
  onMessage(cb: (orderId: string, event: SseEvent) => void): void;
  close(): Promise<void>;
}

/**
 * Create a Redis Pub/Sub adapter.
 *
 * Uses ioredis — must be installed as a runtime dependency.
 * Only call this function when REDIS_URL is set.
 */
export async function createRedisAdapter(
  redisUrl: string,
  log: Logger,
): Promise<SseRedisAdapter> {
  // Dynamic import so ioredis is never loaded in single-instance mode
  const { default: Redis } = await import("ioredis");

  const publisher = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
  });

  const subscriber = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
  });

  const CHANNEL_PREFIX = "order-events:";

  const handlers = new Set<(orderId: string, event: SseEvent) => void>();

  // Connect both clients
  publisher.on("error", (err) => {
    log.warn({ err }, "SSE Redis publisher error — continuing in local-only mode");
  });
  subscriber.on("error", (err) => {
    log.warn({ err }, "SSE Redis subscriber error — continuing in local-only mode");
  });

  await Promise.all([publisher.connect(), subscriber.connect()]).catch((err) => {
    log.warn({ err }, "SSE Redis initial connect failed — continuing in local-only mode");
  });

  // Subscribe to wildcard pattern for all order channels
  subscriber.on("pmessage", (_pattern: string, channel: string, message: string) => {
    const orderId = channel.startsWith(CHANNEL_PREFIX)
      ? channel.slice(CHANNEL_PREFIX.length)
      : null;
    if (!orderId) return;

    let event: SseEvent;
    try {
      event = JSON.parse(message) as SseEvent;
    } catch {
      log.warn({ channel, message }, "SSE Redis: failed to parse message — skipping");
      return;
    }

    for (const handler of handlers) {
      try {
        handler(orderId, event);
      } catch {
        // Individual handler errors must not stop delivery to other handlers
      }
    }
  });

  subscriber.psubscribe(`${CHANNEL_PREFIX}*`).catch((err) => {
    log.warn({ err }, "SSE Redis: psubscribe failed — remote events will not be forwarded");
  });

  return {
    async publish(orderId, event) {
      const channel = `${CHANNEL_PREFIX}${orderId}`;
      try {
        await publisher.publish(channel, JSON.stringify(event));
      } catch (err) {
        log.warn({ err, orderId }, "SSE Redis: publish failed — event will reach local subscribers only");
      }
    },

    onMessage(cb) {
      handlers.add(cb);
    },

    async close() {
      try {
        await subscriber.punsubscribe();
        publisher.disconnect();
        subscriber.disconnect();
      } catch {
        // Best-effort
      }
    },
  };
}
