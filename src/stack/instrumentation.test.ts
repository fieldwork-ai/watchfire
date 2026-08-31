/**
 * Watchfire must not appear in the stack it reports.
 *
 * The frames these tests describe are real: `breadcrumbs.js` patches
 * `window.fetch`, so on a production deployment EVERY network error arrived
 * with `node_modules/watchfire/dist/browser/breadcrumbs.js` as frame 0, ahead
 * of the application code that made the call.
 */
import { describe, expect, it } from "vitest";
import { isInstrumentationFrame, stripInstrumentationFrames } from "./instrumentation.js";
import type { Frame } from "../types.js";

const frame = (over: Partial<Frame> = {}): Frame => ({
  fn: "handleSubmit",
  file: "src/checkout.ts",
  line: 214,
  column: 9,
  resolved: true,
  ...over,
});

/** The exact path seen in production, under pnpm's store layout. */
const PNPM_OWN = frame({
  fn: "window.fetch",
  file:
    "node_modules/.pnpm/watchfire@1.2.1_@aws-sdk+client-s3@3.1085.0_react@19.2.3/" +
    "node_modules/watchfire/dist/browser/breadcrumbs.js",
  line: 117,
});

const NPM_OWN = frame({
  fn: "window.fetch",
  file: "node_modules/watchfire/dist/browser/breadcrumbs.js",
  line: 117,
});

describe("isInstrumentationFrame", () => {
  it.each([
    ["pnpm", PNPM_OWN],
    ["npm", NPM_OWN],
  ])("recognizes this package under the %s layout", (_layout, own) => {
    expect(isInstrumentationFrame(own)).toBe(true);
  });

  it("leaves the host's own code alone", () => {
    expect(isInstrumentationFrame(frame())).toBe(false);
  });

  it("leaves a host directory that merely shares the name", () => {
    // A host wrapping this library in `src/watchfire/` owns that code, and its
    // frames are exactly the ones someone debugging the wrapper needs.
    expect(isInstrumentationFrame(frame({ file: "src/watchfire/report.ts" }))).toBe(false);
  });

  it("leaves other dependencies alone", () => {
    expect(isInstrumentationFrame(frame({ file: "node_modules/react-dom/cjs/react-dom.js" }))).toBe(
      false,
    );
  });

  it("ignores unresolved frames whatever their file says", () => {
    // Unresolved means a generated chunk URL, and this library is bundled into
    // the host's chunks: the file name cannot attribute the frame to anyone.
    const unresolved = frame({
      file: "https://app.example/_next/static/chunks/node_modules/watchfire/dist/browser/x.js",
      resolved: false,
    });
    expect(isInstrumentationFrame(unresolved)).toBe(false);
  });
});

describe("stripInstrumentationFrames", () => {
  it("removes the fetch wrapper from the top of a network error", () => {
    const app = frame({ file: "src/app/login/page.tsx", line: 183 });
    const dependency = frame({ file: "node_modules/@better-fetch/fetch/dist/index.js" });

    const kept = stripInstrumentationFrames([PNPM_OWN, dependency, app]);

    expect(kept).toEqual([dependency, app]);
  });

  it("preserves the order of what remains", () => {
    const a = frame({ file: "src/a.ts" });
    const b = frame({ file: "src/b.ts" });
    expect(stripInstrumentationFrames([a, PNPM_OWN, b])).toEqual([a, b]);
  });

  it("keeps a stack made entirely of our own frames", () => {
    // That stack is evidence of a bug in this library. Emptying it would
    // discard the only report able to prove one.
    const own = [PNPM_OWN, NPM_OWN];
    expect(stripInstrumentationFrames(own)).toEqual(own);
  });

  it("returns an empty stack unchanged", () => {
    expect(stripInstrumentationFrames([])).toEqual([]);
  });

  it("is a no-op for a stack that never touched this library", () => {
    const frames = [frame(), frame({ file: "src/other.ts" })];
    expect(stripInstrumentationFrames(frames)).toEqual(frames);
  });
});
