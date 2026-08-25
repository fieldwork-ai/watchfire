"use client";

import { useEffect } from "react";
import { init } from "watchfire/browser";
import { triggerError, triggerRejection } from "../src/broken";

export default function Page() {
  useEffect(() => {
    init({
      endpoint: "/api/errors",
      release: "e2e-release",
      // Errors must reach the server before the spec asserts, so the batch
      // window is short here. Production defaults to 3000ms.
      flushIntervalMs: 300,
      capture: { console: true, fetchFullPath: true },
    });
  }, []);

  return (
    <main>
      <h1>watchfire fixture</h1>
      <button id="throw" onClick={() => triggerError()}>
        throw
      </button>
      <button id="reject" onClick={() => triggerRejection()}>
        reject
      </button>
      {/* Each throw goes in its own task: calling triggerError() directly in a
          loop exits on the first throw, producing one error rather than fifty. */}
      <button id="loop" onClick={() => { for (let i = 0; i < 50; i++) setTimeout(triggerError, 0); }}>
        loop
      </button>
      <button id="ignored" onClick={() => { throw new Error("ResizeObserver loop limit exceeded"); }}>
        ignored
      </button>
    </main>
  );
}
