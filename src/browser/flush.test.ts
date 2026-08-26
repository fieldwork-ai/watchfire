/**
 * `flush` — sending the batch before the page goes away on purpose.
 *
 * The batch window and the hidden-page drain between them cover a page going
 * away for reasons outside the app's control. They do not cover the app
 * destroying its own page: a bundle that reloads itself loses whatever sits in
 * the queue, which is reliably the report explaining the reload. That is the
 * gap this closes, so the test that matters is "queued, then flushed, without
 * the timer ever firing".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureError, flush, init } from "./index.js";

/** @vitest-environment jsdom */

let sent: string[];
let teardown: () => void;

function reported(): Array<{ message: string }> {
  return sent.flatMap((body) => {
    try {
      return (JSON.parse(body) as { reports: Array<{ message: string }> }).reports;
    } catch {
      return [];
    }
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
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
  // A long window, so anything that arrives did so because flush sent it.
  teardown = init({ endpoint: "/api/errors", flushIntervalMs: 60_000 });
});

afterEach(() => {
  teardown();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("flush", () => {
  it("sends queued reports without waiting for the batch window", () => {
    captureError(new Error("about to reload"));
    expect(reported()).toHaveLength(0);

    flush();

    expect(reported().map((r) => r.message)).toEqual(["Error: about to reload"]);
  });

  it("sends everything queued, not just the newest", () => {
    captureError(new Error("first"));
    captureError(new Error("second"));

    flush();

    expect(reported()).toHaveLength(2);
  });

  it("does not re-send what it already sent", () => {
    captureError(new Error("once"));
    flush();
    flush();
    vi.advanceTimersByTime(120_000);

    expect(reported()).toHaveLength(1);
  });

  it("is a no-op with an empty queue", () => {
    flush();
    expect(sent).toEqual([]);
  });

  it("is a no-op before init, rather than throwing", () => {
    teardown();
    expect(() => flush()).not.toThrow();
    expect(sent).toEqual([]);
  });

  it("never throws when the transport does", () => {
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      sendBeacon: () => {
        throw new Error("beacon exploded");
      },
    });
    vi.stubGlobal("fetch", () => {
      throw new Error("fetch exploded");
    });
    captureError(new Error("unsendable"));

    expect(() => flush()).not.toThrow();
  });
});
