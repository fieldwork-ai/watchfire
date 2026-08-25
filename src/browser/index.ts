/**
 * The browser entry point.
 *
 * Two rules shape everything here:
 *
 * NOTHING IS PARSED CLIENT-SIDE. The raw `error.stack` string goes over the
 * wire untouched. Parsing on the server means a parser fix ships in one deploy
 * rather than waiting for every user's cached bundle to expire, and it keeps
 * this file small enough to sit in the critical path.
 *
 * NOTHING THROWS. Every handler is wrapped. Instrumentation that breaks the
 * page it is watching is worse than no instrumentation, and an error inside an
 * error handler is the hardest class of bug to diagnose from the outside.
 */
import type { RawEnvelope, RawReport } from "../types.js";
import { WIRE_VERSION } from "../types.js";
import {
  BreadcrumbBuffer,
  DEFAULT_CAPTURE,
  installRecorders,
  safePath,
  type CaptureConfig,
} from "./breadcrumbs.js";

export type { CaptureConfig } from "./breadcrumbs.js";

export interface InitOptions {
  /** Where reports POST to. Usually "/api/errors". */
  endpoint: string;
  /** Build identifier. Must match what the maps were stored under. */
  release?: string | null;
  capture?: Partial<CaptureConfig>;
  /** Substrings; a matching message is dropped before it is queued. */
  ignoreErrors?: (string | RegExp)[];
  /** Milliseconds to batch before sending. Default 3000. */
  flushIntervalMs?: number;
  /** Sends per page load, after which everything is counted and dropped. */
  maxReportsPerPage?: number;
  /** Sends per distinct signature per page load. Default 3. */
  maxPerSignature?: number;
}

/**
 * Errors that carry no information and fire in volume.
 *
 * `ResizeObserver loop` is a benign browser notice that a resize handler ran
 * long; every app produces it and nobody has ever fixed a bug from one. Script
 * errors from other origins arrive with no message, file or line, so they
 * cannot be grouped or acted on. Extension errors are not the site's code.
 */
const DEFAULT_IGNORE: RegExp[] = [
  /ResizeObserver loop/,
  /(^|: )Script error\.?$/,
  /Non-Error promise rejection captured/,
  /extensions?\//i,
  /^chrome-extension:\/\//,
  /^moz-extension:\/\//,
];

interface State {
  options: Required<Omit<InitOptions, "capture" | "ignoreErrors" | "release">> & {
    release: string | null;
    capture: CaptureConfig;
    ignoreErrors: (string | RegExp)[];
  };
  buffer: BreadcrumbBuffer;
  queue: RawReport[];
  /** Sends so far, per signature, this page load. */
  seen: Map<string, number>;
  /** Occurrences suppressed since the last send, per signature. */
  suppressed: Map<string, number>;
  sent: number;
  pageLoadedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  teardown: () => void;
}

let state: State | null = null;

/**
 * A cheap client-side signature. Deliberately NOT the server's fingerprint:
 * this only has to be stable within one page load to suppress a hot loop, and
 * computing the real one would mean shipping the parser to the browser.
 */
function signatureOf(message: string, stack: string | null): string {
  const firstFrame = stack?.split("\n").find((line) => /:\d+:\d+/.test(line))?.trim() ?? "";
  return `${message.slice(0, 120)}|${firstFrame.slice(0, 120)}`;
}

function shouldIgnore(message: string, patterns: (string | RegExp)[]): boolean {
  for (const pattern of [...DEFAULT_IGNORE, ...patterns]) {
    if (typeof pattern === "string" ? message.includes(pattern) : pattern.test(message)) {
      return true;
    }
  }
  return false;
}

function send(reports: RawReport[], endpoint: string): void {
  if (reports.length === 0) return;
  const envelope: RawEnvelope = { v: WIRE_VERSION, reports };
  const body = JSON.stringify(envelope);

  // sendBeacon survives the page going away, which is exactly when the last
  // batch would otherwise be lost. It has no response and cannot set headers,
  // so the handler must accept text/plain as well as JSON.
  try {
    if (navigator.sendBeacon?.(endpoint, new Blob([body], { type: "application/json" }))) return;
  } catch {
    // Falls through to fetch.
  }
  try {
    void fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
credentials: "same-origin",
    }).catch(() => {
      // A failed report is dropped. Retrying would risk amplifying an outage
      // the errors are probably about.
    });
  } catch {
    // No transport available. Nothing further to try.
  }
}

function flush(): void {
  if (state === null) return;
  const { queue, options } = state;
  if (queue.length === 0) return;
  state.queue = [];
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  send(queue, options.endpoint);
}

function enqueue(report: Omit<RawReport, "v" | "suppressed" | "pageAgeMs">): void {
  if (state === null) return;
  const { options } = state;

  if (shouldIgnore(report.message, options.ignoreErrors)) return;

  const signature = signatureOf(report.message, report.stack);
  const alreadySent = state.seen.get(signature) ?? 0;

  // Per-signature cap: a hot loop costs a few reports, not thousands. The
  // suppressed count rides along on the next report that does get through, so
  // a storm reads as a storm rather than vanishing.
  if (alreadySent >= options.maxPerSignature || state.sent >= options.maxReportsPerPage) {
    state.suppressed.set(signature, (state.suppressed.get(signature) ?? 0) + 1);
    return;
  }

  state.seen.set(signature, alreadySent + 1);
  state.sent += 1;

  state.queue.push({
    ...report,
    v: WIRE_VERSION,
    suppressed: state.suppressed.get(signature) ?? 0,
    pageAgeMs: Date.now() - state.pageLoadedAt,
  });
  state.suppressed.delete(signature);

  if (state.timer === null) {
    state.timer = setTimeout(flush, options.flushIntervalMs);
  }
}

/** Reports an error explicitly. Safe to call before or after `init`. */
export function captureError(
  error: unknown,
  context?: { kind?: string; componentStack?: string },
): void {
  if (state === null) return;
  try {
    const isError = error instanceof Error;
    enqueue({
      message: isError ? `${error.name}: ${error.message}` : String(error),
      stack: isError ? (error.stack ?? null) : null,
      kind: context?.kind ?? "error",
      path: safePath(location.pathname),
      release: state.options.release,
      breadcrumbs: state.buffer.snapshot(),
      ...(context?.componentStack === undefined
        ? {}
        : { componentStack: context.componentStack.slice(0, 4000) }),
    });
  } catch {
    // Reporting an error must never itself produce one.
  }
}

/** Records a breadcrumb by hand, for app events the recorders cannot see. */
export function addBreadcrumb(message: string, data?: Record<string, string | number>): void {
  try {
    state?.buffer.add("navigation", message, data);
  } catch {
    // Ignored by design.
  }
}

/** Installs the global handlers. Calling twice tears the first down. */
export function init(options: InitOptions): () => void {
  if (typeof window === "undefined") return () => {};
  if (state !== null) state.teardown();

  const capture: CaptureConfig = { ...DEFAULT_CAPTURE, ...options.capture };
  const buffer = new BreadcrumbBuffer(capture.limit);
  const stopRecorders = installRecorders(buffer, capture);

  const onError = (event: ErrorEvent) => {
    // `event.error` is absent for cross-origin scripts; the message alone is
    // still worth sending, and DEFAULT_IGNORE drops the contentless ones.
    captureError(event.error ?? event.message, { kind: "error" });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    captureError(event.reason, { kind: "unhandledrejection" });
  };
  const onHidden = () => {
    if (document.visibilityState === "hidden") flush();
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  // visibilitychange rather than unload: it is the only one that fires
  // reliably on mobile Safari, where a backgrounded tab may never unload.
  document.addEventListener("visibilitychange", onHidden);

  const teardown = () => {
    flush();
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    document.removeEventListener("visibilitychange", onHidden);
    stopRecorders();
    state = null;
  };

  state = {
    options: {
      endpoint: options.endpoint,
      release: options.release ?? null,
      capture,
      ignoreErrors: options.ignoreErrors ?? [],
      flushIntervalMs: options.flushIntervalMs ?? 3000,
      maxReportsPerPage: options.maxReportsPerPage ?? 20,
      maxPerSignature: options.maxPerSignature ?? 3,
    },
    buffer,
    queue: [],
    seen: new Map(),
    suppressed: new Map(),
    sent: 0,
    pageLoadedAt: Date.now(),
    timer: null,
    teardown,
  };

  return teardown;
}
