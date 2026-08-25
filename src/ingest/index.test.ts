import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIngestHandler, memoryRateLimiter, type IngestOptions } from "./index.js";
import { clearSourceMapCache } from "../sourcemaps/resolve.js";
import type { MapStore } from "../sourcemaps/store.js";
import type { RawEnvelope, RawReport, WatchfireEvent } from "../types.js";
import { WIRE_VERSION } from "../types.js";
import { MINIFIED, SOURCE_MAP } from "../sourcemaps/map-fixture.js";

const ORIGIN = "https://app.example";

function report(over: Partial<RawReport> = {}): RawReport {
  return {
    v: WIRE_VERSION,
    message: "TypeError: boom",
    stack: "TypeError: boom\n    at handleSubmit (https://app.example/_next/static/a.js:1:31)",
    kind: "error",
    path: "/checkout",
    release: "rel-1",
    breadcrumbs: [],
    suppressed: 0,
    pageAgeMs: 1200,
    ...over,
  };
}

function post(reports: RawReport[], init: RequestInit = {}): Request {
  const envelope: RawEnvelope = { v: WIRE_VERSION, reports };
  return new Request(`${ORIGIN}/api/errors`, {
    method: "POST",
    headers: { origin: ORIGIN, "user-agent": "test-agent", ...(init.headers ?? {}) },
    body: JSON.stringify(envelope),
    ...init,
  });
}

function harness(options: Partial<IngestOptions> = {}) {
  const events: WatchfireEvent[] = [];
  const handler = createIngestHandler({
    onEvent: (event) => {
      events.push(event);
    },
    ...options,
  });
  return { events, handler };
}

beforeEach(() => {
  clearSourceMapCache();
});

describe("createIngestHandler", () => {
  it("accepts a valid report and emits one event", async () => {
    const { events, handler } = harness();
    const response = await handler(post([report()]));
    expect(response.status).toBe(204);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ message: "TypeError: boom", kind: "error", path: "/checkout" });
    expect(events[0]?.fingerprint).toHaveLength(16);
    expect(events[0]?.reportId).toBeTruthy();
  });

  it("rejects non-POST with 405", async () => {
    const { handler } = harness();
    const response = await handler(new Request(`${ORIGIN}/api/errors`, { method: "GET" }));
    expect(response.status).toBe(405);
  });

  /**
   * Every rejection path below returns 204. A client that learns its report
   * was refused gains nothing it can act on, and a browser retrying during an
   * outage amplifies the outage the errors are probably about.
   */
  describe("always answers 204, never signalling a rejection", () => {
    it.each([
      ["malformed JSON", () => new Request(`${ORIGIN}/api/errors`, {
        method: "POST", headers: { origin: ORIGIN }, body: "{{{not json",
      })],
      ["wrong wire version", () => new Request(`${ORIGIN}/api/errors`, {
        method: "POST", headers: { origin: ORIGIN }, body: JSON.stringify({ v: 999, reports: [] }),
      })],
      ["missing reports array", () => new Request(`${ORIGIN}/api/errors`, {
        method: "POST", headers: { origin: ORIGIN }, body: JSON.stringify({ v: WIRE_VERSION }),
      })],
      ["empty body", () => new Request(`${ORIGIN}/api/errors`, {
        method: "POST", headers: { origin: ORIGIN }, body: "",
      })],
    ])("%s", async (_name, build) => {
      const { events, handler } = harness();
      const response = await handler(build());
      expect(response.status).toBe(204);
      expect(events).toEqual([]);
    });

    it("a throwing onEvent still answers 204 and keeps processing the batch", async () => {
      const seen: string[] = [];
      const handler = createIngestHandler({
        onEvent: (event) => {
          seen.push(event.message);
          if (event.message.includes("first")) throw new Error("host callback failed");
        },
      });
      const response = await handler(
        post([report({ message: "first" }), report({ message: "second" })]),
      );
      expect(response.status).toBe(204);
      expect(seen).toEqual(["first", "second"]);
    });
  });

  describe("origin checking", () => {
    it("drops a cross-origin report", async () => {
      const { events, handler } = harness();
      await handler(post([report()], { headers: { origin: "https://evil.example" } }));
      expect(events).toEqual([]);
    });

    it("accepts a report with no Origin header, as sendBeacon sends", async () => {
      const { events, handler } = harness();
      const request = new Request(`${ORIGIN}/api/errors`, {
        method: "POST",
        body: JSON.stringify({ v: WIRE_VERSION, reports: [report()] }),
      });
      await handler(request);
      expect(events).toHaveLength(1);
    });

    it("honours a custom allowOrigin", async () => {
      const { events, handler } = harness({ allowOrigin: () => false });
      await handler(post([report()]));
      expect(events).toEqual([]);
    });
  });

  describe("rate limiting", () => {
    it("stops a flooding client", async () => {
      const { events, handler } = harness({ rateLimiter: memoryRateLimiter(2, 60_000) });
      const headers = { "x-forwarded-for": "203.0.113.9" };
      for (let i = 0; i < 5; i++) await handler(post([report()], { headers }));
      expect(events).toHaveLength(2);
    });

    it("limits per client, not globally", async () => {
      const { events, handler } = harness({ rateLimiter: memoryRateLimiter(1, 60_000) });
      await handler(post([report()], { headers: { "x-forwarded-for": "203.0.113.1" } }));
      await handler(post([report()], { headers: { "x-forwarded-for": "203.0.113.2" } }));
      expect(events).toHaveLength(2);
    });

    it("takes the rightmost x-forwarded-for entry, which the client cannot forge", async () => {
      const { events, handler } = harness({ rateLimiter: memoryRateLimiter(1, 60_000) });
      // A client spoofing the left of the list must not escape its own bucket.
      const spoofed = { "x-forwarded-for": "1.1.1.1, 203.0.113.5" };
      const other = { "x-forwarded-for": "2.2.2.2, 203.0.113.5" };
      await handler(post([report()], { headers: spoofed }));
      await handler(post([report()], { headers: other }));
      expect(events).toHaveLength(1);
    });
  });

  describe("bounds", () => {
    it("refuses an oversized declared content-length before reading", async () => {
      const { events, handler } = harness({ maxBodyBytes: 100 });
      await handler(post([report()], { headers: { "content-length": "999999" } }));
      expect(events).toEqual([]);
    });

    it("refuses an oversized body when content-length lies", async () => {
      const { events, handler } = harness({ maxBodyBytes: 100 });
      await handler(post([report({ message: "x".repeat(5000) })]));
      expect(events).toEqual([]);
    });

    it("caps reports per request", async () => {
      const { events, handler } = harness({ maxReportsPerRequest: 3 });
      await handler(post(Array.from({ length: 10 }, () => report())));
      expect(events).toHaveLength(3);
    });

    it("truncates an over-long message and stack", async () => {
      const { events, handler } = harness();
      await handler(post([report({ message: "y".repeat(9000), stack: "z".repeat(90_000) })]));
      expect(events[0]?.message.length).toBeLessThanOrEqual(2000);
      expect(events[0]?.rawStack?.length).toBeLessThanOrEqual(20_000);
    });

    it("caps breadcrumbs", async () => {
      const crumbs = Array.from({ length: 200 }, (_, i) => ({
        kind: "click" as const, message: `btn-${i}`, ageMs: i,
      }));
      const { events, handler } = harness();
      await handler(post([report({ breadcrumbs: crumbs })]));
      expect(events[0]?.breadcrumbs.length).toBeLessThanOrEqual(50);
    });
  });

  describe("scrubbing", () => {
    it("strips query strings from the reported path", async () => {
      const { events, handler } = harness();
      await handler(post([report({ path: "/connectors/callback?code=live-oauth-code&state=x" })]));
      expect(events[0]?.path).toBe("/connectors/callback");
      expect(JSON.stringify(events[0])).not.toContain("live-oauth-code");
    });

    it("strips query strings from breadcrumb messages", async () => {
      const { events, handler } = harness();
      await handler(post([report({
        breadcrumbs: [{ kind: "fetch", message: "/api/oauth/callback?code=secret-code", ageMs: 5 }],
      })]));
      expect(JSON.stringify(events[0]?.breadcrumbs)).not.toContain("secret-code");
    });

    it("takes the user agent from the request, never the payload", async () => {
      const { events, handler } = harness();
      await handler(post([{ ...report(), userAgent: "spoofed" } as unknown as RawReport]));
      expect(events[0]?.userAgent).toBe("test-agent");
    });

    it("drops a release outside the allowlist", async () => {
      const { events, handler } = harness({ releaseAllowlist: (r) => r === "rel-2" });
      await handler(post([report({ release: "rel-1" })]));
      expect(events[0]?.release).toBeNull();
    });

    it("drops an absurdly long release id", async () => {
      const { events, handler } = harness();
      await handler(post([report({ release: "r".repeat(500) })]));
      expect(events[0]?.release).toBeNull();
    });
  });

  describe("source-map resolution", () => {
    /** A store serving the real esbuild map for one generated chunk. */
    const store: MapStore = {
      get: async (_release, file) => (file === "a.js.map" ? JSON.stringify(SOURCE_MAP) : null),
      put: async () => {},
      list: async () => [],
    };

    it("resolves frames to original source when a map is available", async () => {
      const column = MINIFIED.indexOf("throw") + 1;
      const { events, handler } = harness({ maps: store });
      await handler(post([report({
        stack: `RangeError: negative price\n    at r (https://app.example/_next/static/a.js:1:${column})`,
      })]));
      const frame = events[0]?.frames[0];
      expect(frame?.resolved).toBe(true);
      expect(frame?.file).toContain("checkout.ts");
    });

    it("leaves frames unresolved when the release has no maps, without failing", async () => {
      const { events, handler } = harness({ maps: store });
      await handler(post([report({
        stack: "TypeError: boom\n    at h (https://app.example/_next/static/unknown.js:1:5)",
      })]));
      expect(events).toHaveLength(1);
      expect(events[0]?.frames[0]?.resolved).toBe(false);
      // The generated location survives, so the report is still diagnosable.
      expect(events[0]?.frames[0]?.file).toContain("unknown.js");
    });

    it("skips resolution entirely when the report carries no release", async () => {
      const get = vi.fn(async () => null);
      const { events, handler } = harness({ maps: { get, put: async () => {}, list: async () => [] } });
      await handler(post([report({ release: null })]));
      expect(get).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
    });

    it("survives a store that throws", async () => {
      const angry: MapStore = {
        get: async () => { throw new Error("s3 is down"); },
        put: async () => {},
        list: async () => [],
      };
      const { events, handler } = harness({ maps: angry });
      const response = await handler(post([report()]));
      expect(response.status).toBe(204);
      expect(events).toHaveLength(1);
    });
  });

  it("preserves the suppressed count from the client", async () => {
    const { events, handler } = harness();
    await handler(post([report({ suppressed: 214 })]));
    expect(events[0]?.suppressed).toBe(214);
  });

  it("keeps a React component stack when present", async () => {
    const { events, handler } = harness();
    await handler(post([report({ kind: "boundary", componentStack: "\n  at Checkout\n  at Page" })]));
    expect(events[0]?.componentStack).toContain("Checkout");
  });
});

describe("memoryRateLimiter", () => {
  it("allows up to the limit then refuses", () => {
    const limiter = memoryRateLimiter(3, 60_000);
    expect([1, 2, 3].map(() => limiter.check("k"))).toEqual([true, true, true]);
    expect(limiter.check("k")).toBe(false);
  });

  it("forgets hits once the window passes", () => {
    vi.useFakeTimers();
    try {
      const limiter = memoryRateLimiter(1, 1000);
      expect(limiter.check("k")).toBe(true);
      expect(limiter.check("k")).toBe(false);
      vi.advanceTimersByTime(1500);
      expect(limiter.check("k")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
