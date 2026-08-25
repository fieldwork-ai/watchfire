/**
 * What the browser SDK drops before anything leaves the page.
 *
 * Two rules, and the second is the one that was wrong at first:
 *
 * 1. The defaults hold only what is noise for EVERY app. A library cannot know
 *    whether chunk-load failures are routine or the most important signal a
 *    host has, so it must not decide.
 * 2. Extension noise is identified by the STACK, not the message. An injected
 *    script throws an ordinary-looking TypeError; the only marker is the
 *    `chrome-extension://` frame. Matching messages caught almost nothing
 *    while looking like coverage.
 *
 * Exercised through the public API rather than by exporting internals: the
 * question is whether a report leaves, and the transport is where that shows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureError, init } from "./index.js";

/**
 * @vitest-environment jsdom
 *
 * A real DOM rather than hand-stubbed globals: `init` no-ops without `window`,
 * and the recorders it installs touch `document`, `history` and `location`.
 * Stubbing those by hand tests the stubs.
 */

let sent: string[];
let teardown: () => void;

/** Every report the SDK actually handed to the transport. */
function reported(): Array<{ message: string }> {
  return sent.flatMap((body) => {
    try {
      return (JSON.parse(body) as { reports: Array<{ message: string }> }).reports;
    } catch {
      return [];
    }
  });
}

function errorWith(message: string, stack: string | null): Error {
  const error = new Error(message);
  if (stack === null) delete error.stack;
  else error.stack = stack;
  return error;
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  // jsdom implements neither sendBeacon nor fetch; this is the seam the SDK
  // reaches for first, so capturing it captures everything that would leave.
  vi.stubGlobal("navigator", {
    ...globalThis.navigator,
    sendBeacon: (_url: string, body: Blob) => {
      sent.push((body as unknown as { __parts: string[] }).__parts.join(""));
      return true;
    },
  });
  vi.stubGlobal(
    "Blob",
    class {
      __parts: string[];
      constructor(parts: string[]) {
        this.__parts = parts;
      }
    },
  );
  teardown = init({ endpoint: "/api/errors", flushIntervalMs: 10 });
});

afterEach(() => {
  teardown();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function flush(): void {
  vi.advanceTimersByTime(50);
}

describe("default ignore list", () => {
  it.each([
    ["ResizeObserver loop limit exceeded", "a benign browser notice"],
    ["Script error.", "a cross-origin error with no detail to act on"],
  ])("drops %s (%s)", (message) => {
    captureError(errorWith(message, "Error: x\n    at fn (https://app/a.js:1:2)"));
    flush();
    expect(reported()).toEqual([]);
  });

  it("drops the same notice when it arrives formatted as an Error", () => {
    // window.onerror gives the bare string; an explicit throw gives
    // "Error: <message>". Both must match, which anchoring broke.
    captureError(new Error("ResizeObserver loop completed with undelivered notifications"));
    flush();
    expect(reported()).toEqual([]);
  });
});

describe("chunk-load failures are NOT dropped by default", () => {
  /**
   * The library must not make this call. For a team deploying hourly these are
   * routine; for one deploying monthly they are alarming; for a team asking
   * why users lose their place mid-task they are the whole signal. A host that
   * wants them quiet can say so — the default cannot.
   */
  it.each([
    "ChunkLoadError: Loading chunk 4821 failed",
    "TypeError: Failed to fetch dynamically imported module",
    "TypeError: Importing a module script failed.",
    "TypeError: Failed to fetch",
    "AbortError: The user aborted a request.",
  ])("reports %s", (message) => {
    captureError(errorWith(message, "Error: x\n    at load (https://app/a.js:1:2)"));
    flush();
    expect(reported().map((report) => report.message)).toContain(`Error: ${message}`);
  });
});

describe("foreign sources are matched on the stack", () => {
  it("drops an ordinary-looking error thrown from an extension frame", () => {
    // The message is indistinguishable from one of ours. Only the frame says
    // otherwise, which is why the message-only match caught nothing.
    captureError(
      errorWith(
        "Cannot read properties of null (reading 'querySelector')",
        "TypeError: Cannot read properties of null\n" +
          "    at inject (chrome-extension://abcdefg/content.js:1:900)",
      ),
    );
    flush();
    expect(reported()).toEqual([]);
  });

  it.each(["chrome", "moz", "safari"])("drops %s-extension frames", (vendor) => {
    captureError(
      errorWith("TypeError: undefined is not a function", `    at x (${vendor}-extension://z/a.js:1:2)`),
    );
    flush();
    expect(reported()).toEqual([]);
  });

  it("keeps an error whose stack is entirely our own", () => {
    captureError(
      errorWith(
        "TypeError: Cannot read properties of null",
        "TypeError: x\n    at render (https://app.example/_next/static/chunks/a.js:1:2)",
      ),
    );
    flush();
    expect(reported()).toHaveLength(1);
  });

  it("keeps an error with no stack at all", () => {
    // Nothing to match against is not grounds for discarding a report.
    captureError(errorWith("TypeError: something went wrong", null));
    flush();
    expect(reported()).toHaveLength(1);
  });
});

describe("host patterns", () => {
  it("are matched against the stack as well as the message", () => {
    teardown();
    teardown = init({
      endpoint: "/api/errors",
      flushIntervalMs: 10,
      // A third-party widget has the same shape of problem an extension does.
      ignoreErrors: [/widget\.vendor\.example/],
    });
    captureError(
      errorWith("TypeError: t is not a function", "    at w (https://widget.vendor.example/w.js:1:2)"),
    );
    flush();
    expect(reported()).toEqual([]);
  });

  it("accept plain substrings as well as patterns", () => {
    teardown();
    teardown = init({
      endpoint: "/api/errors",
      flushIntervalMs: 10,
      ignoreErrors: ["quota exceeded"],
    });
    captureError(errorWith("QuotaExceededError: quota exceeded", null));
    flush();
    expect(reported()).toEqual([]);
  });
});
