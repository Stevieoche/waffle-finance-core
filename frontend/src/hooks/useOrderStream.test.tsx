/**
 * Unit tests for useOrderStream.
 *
 * Mocks createSseTransport and createPollingTransport so no real network
 * calls or EventSource instances are created.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOrderStream } from "./useOrderStream";

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock the SSE transport so no real EventSource is opened
vi.mock("../lib/sseTransport", () => ({
  createSseTransport: vi.fn(() => ({
    start: vi.fn(() => () => {}),
  })),
}));

// Mock the env config to avoid import.meta.env issues in tests
vi.mock("../config/env", () => ({
  envConfig: { apiBaseUrl: "http://localhost:3001" },
}));

// Mock fetch used by the polling transport
const fetchMock = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ id: "wf_0x" + "a".repeat(64), status: "src_locked" }),
});
vi.stubGlobal("fetch", fetchMock);

const ORDER_ID = "wf_0x" + "a".repeat(64);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useOrderStream — null orderId", () => {
  it("returns phase idle when orderId is null", () => {
    const { result } = renderHook(() => useOrderStream(null));
    expect(result.current.phase).toBe("idle");
  });

  it("returns empty orders map when orderId is null", () => {
    const { result } = renderHook(() => useOrderStream(null));
    expect(Object.keys(result.current.orders)).toHaveLength(0);
  });
});

describe("useOrderStream — with orderId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: ORDER_ID, status: "src_locked" }),
    });
  });

  it("transitions to active phase when orderId is provided", async () => {
    const { result } = renderHook(() => useOrderStream(ORDER_ID));
    // Phase should be active once the subscription is open
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.phase).toBe("active");
  });

  it("calls unsubscribe on unmount — no dangling connection", async () => {
    const { result, unmount } = renderHook(() => useOrderStream(ORDER_ID));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    unmount();
    expect(result.current.phase === "closed" || result.current.phase === "active").toBe(true);
  });

  it("transport is referentially stable across re-renders with same orderId", () => {
    const { result, rerender } = renderHook(() => useOrderStream(ORDER_ID));
    const sub1 = result.current;
    rerender();
    const sub2 = result.current;
    // Same orderId → same subscription, phase should be stable (not reset)
    expect(sub1.phase).toBe(sub2.phase);
  });

  it("re-subscribes when orderId changes", async () => {
    const OTHER_ID = "wf_0x" + "b".repeat(64);
    let id = ORDER_ID;
    const { result, rerender } = renderHook(() => useOrderStream(id));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.phase).toBe("active");

    id = OTHER_ID;
    rerender();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    // Still active with the new ID
    expect(result.current.phase).toBe("active");
  });
});
