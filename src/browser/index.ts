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
  /**
   * Scalars to attach to every report: a tenant id, a workspace, a flag.
   * Called at capture time rather than read once, so a value that changes
   * during the session (the active organization, say) is current.
   *
   * This exists because `sendBeacon` cannot set request headers, so a header
   * cannot carry it. The server receives it as an untrusted claim.
   */
  context?: () => Record<string, string | number | boolean> | undefined;
}

/**
 * Errors that are noise for EVERY app, at any volume, in any deployment.
 *
 * That bar is deliberately high, and it is the whole rule for this list. A
 * library has no business deciding what is noise for its hosts: chunk-load
 * failures are routine for a team deploying hourly and alarming for one
 * deploying monthly, and for a team investigating why users lose their session
 * mid-task they may be the most important signal there is. Anything that is
 * noise merely *sometimes* belongs in the host's own `ignoreErrors`, or better,
 * in the host's classification of what deserves attention.
 *
 * `ResizeObserver loop` is a benign browser notice that a resize handler ran
 * long; every app produces it and nobody has ever fixed a bug from one. Script
 * errors from other origins arrive with no message, file or line, so they
 * cannot be grouped or acted on. Extension code is not the site's code.
 */
const DEFAULT_IGNORE: RegExp[] = [
  /ResizeObserver loop/,
  /(^|: )Script error\.?$/,
  /Non-Error promise rejection captured/,
];

/**
 * Sources whose errors are not the site's code.
 *
 * Matched against the STACK, not the message, because that is where a browser
 * extension actually identifies itself. An injected script throws a perfectly
 * ordinary `TypeError: Cannot read properties of null` — the only thing
 * marking it as someone else's is the `chrome-extension://` frame in the
 * trace. Matching the message caught almost nothing while looking like
 * coverage.
 */
const FOREIGN_SOURCES = /(?:chrome|moz|safari|ms-browser)-extension:\/\//i;

/**
 * Extension errors that arrive with no usable stack, matched by message.
 *
 * This is the exception to the rule stated above `FOREIGN_SOURCES`, and it
 * exists because that rule has a hole: an extension error can reach the page
 * with NO stack at all, and there is then no frame to identify anyone by. Both
 * shapes below were seen in production and stored as though they were
 * application bugs.
 *
 * The bar for adding to this list is that the message NAMES a browser
 * extension API, so page code cannot produce it. `runtime.sendMessage` and the
 * message-port errors come from `chrome.runtime`, which is not exposed to the
 * page. That is what makes them safe to match on where a generic
 * `TypeError: Cannot read properties of null` is not — matching those on the
 * message is exactly the over-reach the comment above warns about.
 *
 * The Firefox pair is the same failure in a different disguise: an extension
 * hands React a privileged object, React's delegated event handler inspects the
 * property it always inspects, and Firefox refuses. The stack contains only
 * React frames, so `FOREIGN_SOURCES` cannot see it. They are anchored to the
 * two exact property names React's event system touches rather than to
 * "Permission denied", because a denied access to anything else may well be a
 * real cross-origin bug in the host's own code.
 */
const FOREIGN_MESSAGES: RegExp[] = [
  /Invalid call to runtime\.sendMessage\(\)/,
  /Extension context invalidated/,
  /The message port closed before a response was received/,
  /Could not establish connection\. Receiving end does not exist/,
  /^(?:Error: )?Permission denied to access property "correspondingUseElement"$/,
  /^(?:Error: )?Permission denied to access property "__react(?:Fiber|InternalInstance)\$[^"]+"$/,
];

interface State {
  options: Required<Omit<InitOptions, "capture" | "ignoreErrors" | "release" | "context">> & {
    release: string | null;
    capture: CaptureConfig;
    ignoreErrors: (string | RegExp)[];
    context: InitOptions["context"];
  };
  buffer: BreadcrumbBuffer;
  /**
   * Queued reports keep their signature so `flush` can attach whatever was
   * suppressed while they waited. Stripped before sending.
   */
  queue: Array<{ report: RawReport; signature: string }>;
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

function shouldIgnore(
  message: string,
  stack: string | null,
  patterns: (string | RegExp)[],
): boolean {
  if (stack !== null && FOREIGN_SOURCES.test(stack)) return true;

  // Message only, and only for these: the patterns name an extension API, so
  // the identifying detail is the message itself. Testing them against the
  // stack as well would let an application frame that merely quotes one of
  // these strings suppress a real error.
  for (const pattern of FOREIGN_MESSAGES) {
    if (pattern.test(message)) return true;
  }

  // Host patterns are tested against the stack too: a host filtering a
  // third-party widget has the same problem extensions do, in that the
  // identifying detail is the frame rather than the message.
  const haystacks = stack === null ? [message] : [message, stack];
  for (const pattern of [...DEFAULT_IGNORE, ...patterns]) {
    for (const haystack of haystacks) {
      const hit =
        typeof pattern === "string" ? haystack.includes(pattern) : pattern.test(haystack);
      if (hit) return true;
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

function drainQueue(): void {
  if (state === null) return;
  const { queue, options } = state;
  if (queue.length === 0) return;
  state.queue = [];
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  // Attach what was suppressed while these reports sat in the queue.
  //
  // Without this the count is very nearly useless: it can only ride along on
  // the NEXT report of the same signature, and the common case — a hot loop
  // that fires a few hundred times and then stops — has no next report, so
  // "and this happened 400 more times" is silently lost. The batching window
  // is exactly when the suppression happens, so flush is where it is known.
  const reports = queue.map(({ report, signature }) => {
    const pending = state?.suppressed.get(signature) ?? 0;
    if (pending > 0) state?.suppressed.delete(signature);
    return pending > 0 ? { ...report, suppressed: report.suppressed + pending } : report;
  });

  send(reports, options.endpoint);
}

function enqueue(report: Omit<RawReport, "v" | "suppressed" | "pageAgeMs">): void {
  if (state === null) return;
  const { options } = state;

  if (shouldIgnore(report.message, report.stack, options.ignoreErrors)) return;

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
    signature,
    report: {
      ...report,
      v: WIRE_VERSION,
      // Anything suppressed BEFORE this report was queued. Anything suppressed
      // while it waits is added by `flush`.
      suppressed: state.suppressed.get(signature) ?? 0,
      pageAgeMs: Date.now() - state.pageLoadedAt,
    },
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
    // Evaluated defensively: a host callback that throws must not cost the
    // report it was only decorating.
    let hostContext: Record<string, string | number | boolean> | undefined;
    try {
      hostContext = state.options.context?.();
    } catch {
      hostContext = undefined;
    }
    enqueue({
      message: isError ? `${error.name}: ${error.message}` : String(error),
      stack: isError ? (error.stack ?? null) : null,
      kind: context?.kind ?? "error",
      path: safePath(location.pathname),
      release: state.options.release,
      breadcrumbs: state.buffer.snapshot(),
      ...(hostContext === undefined ? {} : { context: hostContext }),
      ...(context?.componentStack === undefined
        ? {}
        : { componentStack: context.componentStack.slice(0, 4000) }),
    });
  } catch {
    // Reporting an error must never itself produce one.
  }
}

/** Records a breadcrumb by hand, for app events the recorders cannot see. */
export function addBreadcrumb(
  message: string,
  data?: Record<string, string | number | boolean>,
): void {
  try {
    state?.buffer.add("navigation", message, data);
  } catch {
    // Ignored by design.
  }
}

/**
 * Sends everything queued right now, instead of waiting out the batch window.
 *
 * Reports normally sit in a batch for `flushIntervalMs`, and the queue drains
 * on its own when the page is hidden or torn down. That covers the page going
 * away for reasons outside your control; it does not cover the page going away
 * because YOUR code decided so. An app that reloads itself — a stale bundle
 * refreshing, a recovery path retrying — destroys the queue mid-window unless
 * it flushes first, and loses exactly the report explaining why it reloaded.
 *
 * Delivery uses `sendBeacon`, which the browser completes independently of the
 * page, so calling this immediately before `location.reload()` is safe. It
 * returns void rather than a promise on purpose: there is no response to wait
 * for, and a promise would imply a delivery guarantee the transport cannot
 * make. A no-op before `init`, or with an empty queue.
 */
export function flush(): void {
  try {
    drainQueue();
  } catch {
    // Same contract as the rest of the surface: reporting never throws.
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
    if (document.visibilityState === "hidden") drainQueue();
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  // visibilitychange rather than unload: it is the only one that fires
  // reliably on mobile Safari, where a backgrounded tab may never unload.
  document.addEventListener("visibilitychange", onHidden);

  const teardown = () => {
    drainQueue();
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
      context: options.context,
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
