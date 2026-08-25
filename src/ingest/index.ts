/**
 * The server handler.
 *
 * A web-standard `(Request) => Response`, so it drops unchanged into a Next.js
 * route handler, Hono, Bun and Deno, and needs only a thin shim for Express.
 *
 * THE HANDLER ALWAYS RETURNS 2xx. A client that receives a 500 from the error
 * reporter has learned nothing it can act on, and a browser retrying failed
 * reports during an outage amplifies the outage. Validation failures are
 * counted through `onLog`, never signalled to the page.
 */
import type { Breadcrumb, RawEnvelope, RawReport, WatchfireEvent } from "../types.js";
import { WIRE_VERSION } from "../types.js";
import { parseStack } from "../stack/parse.js";
import { fingerprint } from "../stack/fingerprint.js";
import { resolveFrames } from "../sourcemaps/resolve.js";
import type { MapStore } from "../sourcemaps/store.js";

export interface RateLimiter {
  /** True when the request may proceed. */
  check(key: string): boolean;
}

export interface IngestOptions {
  /** Called once per accepted report. The whole point of the library. */
  onEvent: (event: WatchfireEvent, request: Request) => void | Promise<void>;
  /** Store for source-map resolution. Null disables resolution entirely. */
  maps?: MapStore | null;
  /** Trusted release ids. A report naming anything else resolves unmapped. */
  releaseAllowlist?: (release: string) => boolean;
  /** Per-IP limiter. Defaults to 60 requests/minute in process memory. */
  rateLimiter?: RateLimiter;
  /** Extracts the client IP. Defaults to standard proxy headers. */
  clientIp?: (request: Request) => string | null;
  /** Rejects requests from unexpected origins. Defaults to same-origin only. */
  allowOrigin?: (origin: string | null, request: Request) => boolean;
  /** Maximum request body, in bytes. Default 256 KB. */
  maxBodyBytes?: number;
  /** Reports accepted per request. Default 20. */
  maxReportsPerRequest?: number;
  onLog?: (message: string, error?: unknown) => void;
}

const MAX_MESSAGE = 2000;
const MAX_STACK = 20_000;
const MAX_BREADCRUMBS = 50;

/**
 * In-memory sliding window. Per-process, which is the right scope: the goal is
 * to stop one client flooding one task, not to enforce a global quota, and a
 * shared limiter would put a network round trip in front of a 204.
 */
export function memoryRateLimiter(limit = 60, windowMs = 60_000): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    check(key) {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs);
      recent.push(now);
      hits.set(key, recent);
      // Opportunistic sweep: without it the map grows for the process lifetime
      // on a service with many distinct client IPs.
      if (hits.size > 10_000) {
        for (const [otherKey, times] of hits) {
          if (times.every((at) => now - at >= windowMs)) hits.delete(otherKey);
        }
      }
      return recent.length <= limit;
    },
  };
}

function defaultClientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    // Rightmost entry is the one the nearest trusted proxy observed; the left
    // of the list is client-supplied and therefore forgeable.
    const parts = forwarded.split(",").map((part) => part.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last !== undefined) return last;
  }
  return request.headers.get("x-real-ip");
}

/**
 * Same-origin check.
 *
 * The comparison is against the HOST HEADER, not `request.url`. A server
 * behind a reverse proxy sees its own internal address in `request.url`
 * (Next.js standalone reports the bind address, and an ALB or nginx rewrites
 * the target anyway), so comparing against it rejects every genuine
 * same-origin report while looking correct in a unit test built from a
 * synthetic Request. `x-forwarded-host` takes precedence because that is what
 * the browser actually addressed.
 *
 * This is a cheap filter against another site posting junk, not a security
 * boundary: the rate limit and the body caps are what bound abuse.
 */
function defaultAllowOrigin(origin: string | null, request: Request): boolean {
  // sendBeacon and same-origin fetch may omit Origin entirely.
  if (origin === null) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  const forwarded = request.headers.get("x-forwarded-host");
  const host = forwarded?.split(",")[0]?.trim() ?? request.headers.get("host");
  if (host !== null && host !== undefined && host.length > 0) return originHost === host;

  try {
    return originHost === new URL(request.url).host;
  } catch {
    return false;
  }
}

/** Strips the query string. See the note in browser/breadcrumbs.ts. */
function scrubPath(path: string): string {
  const cut = path.indexOf("?");
  const withoutQuery = cut === -1 ? path : path.slice(0, cut);
  return withoutQuery.slice(0, 512);
}

function scrubBreadcrumbs(crumbs: unknown): Breadcrumb[] {
  if (!Array.isArray(crumbs)) return [];
  const out: Breadcrumb[] = [];
  for (const crumb of crumbs.slice(-MAX_BREADCRUMBS)) {
    if (typeof crumb !== "object" || crumb === null) continue;
    const { kind, message, ageMs, data } = crumb as Partial<Breadcrumb>;
    if (typeof kind !== "string" || typeof message !== "string") continue;
    out.push({
      kind: kind as Breadcrumb["kind"],
      message: scrubPath(message).slice(0, 300),
      ageMs: typeof ageMs === "number" && Number.isFinite(ageMs) ? ageMs : 0,
      ...(typeof data === "object" && data !== null ? { data } : {}),
    });
  }
  return out;
}

function validReport(value: unknown): value is RawReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Partial<RawReport>;
  return typeof report.message === "string" && typeof report.kind === "string";
}

/**
 * Report ids are correlation handles, not secrets: they tie a one-line log
 * event to a stored row. `randomUUID` where available, with a fallback for
 * runtimes that lack it.
 */
function reportId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createIngestHandler(options: IngestOptions): (request: Request) => Promise<Response> {
  const {
    onEvent,
    maps = null,
    releaseAllowlist,
    rateLimiter = memoryRateLimiter(),
    clientIp = defaultClientIp,
    allowOrigin = defaultAllowOrigin,
    maxBodyBytes = 256 * 1024,
    maxReportsPerRequest = 20,
    onLog,
  } = options;

  return async function handle(request: Request): Promise<Response> {
    // Accepted, not processed: the client is told nothing either way.
    const ok = new Response(null, { status: 204 });

    try {
      if (request.method !== "POST") {
        return new Response(null, { status: 405, headers: { allow: "POST" } });
      }
      if (!allowOrigin(request.headers.get("origin"), request)) return ok;

      const ip = clientIp(request) ?? "unknown";
      if (!rateLimiter.check(ip)) return ok;

      // Declared length first: it costs nothing and rejects an oversized body
      // before it is read. The post-read check catches a missing or lying one.
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > maxBodyBytes) return ok;

      const body = await request.text();
      if (body.length > maxBodyBytes) return ok;

      let envelope: RawEnvelope;
      try {
        envelope = JSON.parse(body) as RawEnvelope;
      } catch {
        return ok;
      }
      if (envelope?.v !== WIRE_VERSION || !Array.isArray(envelope.reports)) return ok;

      const userAgent = request.headers.get("user-agent");
      const reports = envelope.reports.filter(validReport).slice(0, maxReportsPerRequest);

      for (const report of reports) {
        const release =
          typeof report.release === "string" &&
          report.release.length > 0 &&
          report.release.length <= 128 &&
          (releaseAllowlist === undefined || releaseAllowlist(report.release))
            ? report.release
            : null;

        const rawStack = typeof report.stack === "string" ? report.stack.slice(0, MAX_STACK) : null;
        const parsed = parseStack(rawStack);
        const frames = await resolveFrames(parsed, release, maps);
        const message = report.message.slice(0, MAX_MESSAGE);

        const event: WatchfireEvent = {
          reportId: reportId(),
          fingerprint: fingerprint(frames, message, report.kind),
          message,
          kind: report.kind.slice(0, 40),
          path: scrubPath(typeof report.path === "string" ? report.path : ""),
          release,
          frames,
          rawStack,
          ...(typeof report.componentStack === "string"
            ? { componentStack: report.componentStack.slice(0, 4000) }
            : {}),
          breadcrumbs: scrubBreadcrumbs(report.breadcrumbs),
          suppressed:
            typeof report.suppressed === "number" && report.suppressed > 0
              ? Math.min(report.suppressed, 1_000_000)
              : 0,
          userAgent,
          receivedAt: new Date(),
        };

        try {
          await onEvent(event, request);
        } catch (error) {
          // The host's callback failing must not lose the rest of the batch.
          onLog?.("watchfire: onEvent threw", error);
        }
      }

      return ok;
    } catch (error) {
      onLog?.("watchfire: ingest failed", error);
      return ok;
    }
  };
}

export type { WatchfireEvent, Frame, Breadcrumb } from "../types.js";
export type { MapStore } from "../sourcemaps/store.js";
export { filesystemStore, s3Store, layeredStore } from "../sourcemaps/store.js";
export { defaultMapsDir } from "../sourcemaps/default-dir.js";
