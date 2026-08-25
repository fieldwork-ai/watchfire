/**
 * The wire and event shapes, shared by every subpath export.
 *
 * `RawReport` is what the browser sends. `WatchfireEvent` is what the host's
 * `onEvent` callback receives after parsing, resolution and fingerprinting.
 * Keeping both in one file is deliberate: the browser bundle and the server
 * handler must agree byte for byte, and a duplicated interface is how that
 * agreement rots.
 */

/** Wire format version. Bumped only on a breaking change to `RawReport`. */
export const WIRE_VERSION = 1;

export type BreadcrumbKind = "navigation" | "click" | "fetch" | "console";

export interface Breadcrumb {
  kind: BreadcrumbKind;
  /** Milliseconds before the error, so the payload carries no wall-clock time. */
  ageMs: number;
  /** Human-readable one-liner: a route pattern, a selector, "GET /api/x 500". */
  message: string;
  /** Console level, fetch status, and similar scalars. Never free content. */
  data?: Record<string, string | number | boolean>;
}

/** One report as it leaves the browser. Stacks are raw; parsing is server-side. */
export interface RawReport {
  v: number;
  message: string;
  /** The unparsed `error.stack` string, exactly as the engine produced it. */
  stack: string | null;
  /** "error" for throws, "unhandledrejection", "boundary" for React. */
  kind: string;
  /** Location the error happened at, already reduced to a path (no query). */
  path: string;
  release: string | null;
  /** React's componentStack when the report came from an error boundary. */
  componentStack?: string;
  breadcrumbs: Breadcrumb[];
  /**
   * How many further occurrences of this same signature the client suppressed
   * before sending. Zero on the first send of a signature.
   */
  suppressed: number;
  /** Milliseconds since the page loaded, for ordering within a session. */
  pageAgeMs: number;
  /**
   * Host-supplied scalars: a tenant id, a feature flag, a workspace. Sent by
   * the client and therefore UNTRUSTED — the host must validate anything it
   * intends to rely on. It exists because `sendBeacon` cannot set request
   * headers, so a header is not available to carry this.
   */
  context?: Record<string, string | number | boolean>;
}

export interface RawEnvelope {
  v: number;
  reports: RawReport[];
}

/** One frame, after parsing and (where possible) source-map resolution. */
export interface Frame {
  /** Function name as the engine reported it, or null for anonymous frames. */
  fn: string | null;
  /** Original source path once resolved, else the generated file URL. */
  file: string;
  line: number | null;
  column: number | null;
  /** True when a source map produced this frame's file and line. */
  resolved: boolean;
}

export interface WatchfireEvent {
  /** Unique per report. Correlates a log line with a stored row. */
  reportId: string;
  /** Stable group key. Same bug, same value, across releases. */
  fingerprint: string;
  message: string;
  kind: string;
  path: string;
  release: string | null;
  frames: Frame[];
  /** The raw stack, kept so an unparseable format is still diagnosable. */
  rawStack: string | null;
  componentStack?: string;
  breadcrumbs: Breadcrumb[];
  suppressed: number;
  /**
   * The host context the client sent, bounded and type-checked but NOT
   * verified. Treat it as a claim: validate before storing anything that
   * attributes a report to a tenant.
   */
  context: Record<string, string | number | boolean>;
  /** Set from the request, not the payload: clients must not assert identity. */
  userAgent: string | null;
  receivedAt: Date;
}
