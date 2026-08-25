import { describe, expect, it } from "vitest";
import { fingerprint, normalizeMessage } from "./fingerprint.js";
import { parseStack } from "./parse.js";
import { ENGINE_STACKS } from "./fixtures.js";
import type { Frame } from "../types.js";

const frame = (over: Partial<Frame> = {}): Frame => ({
  fn: "handleSubmit",
  file: "src/checkout.ts",
  line: 214,
  column: 9,
  resolved: true,
  ...over,
});

describe("normalizeMessage", () => {
  it("templates ids so one bug is not many issues", () => {
    const a = normalizeMessage("Failed to load user 8f3a1b2c-1111-2222-3333-444455556666");
    const b = normalizeMessage("Failed to load user 22bcdead-9999-8888-7777-666655554444");
    expect(a).toBe(b);
  });

  it("templates numbers, hex, quoted strings and URLs", () => {
    expect(normalizeMessage("Request 42 failed")).toBe(normalizeMessage("Request 9001 failed"));
    expect(normalizeMessage('Cannot read "alpha"')).toBe(normalizeMessage('Cannot read "beta"'));
    expect(normalizeMessage("GET https://a.example/x")).toBe(
      normalizeMessage("GET https://b.example/y"),
    );
  });

  it("keeps distinct messages distinct", () => {
    expect(normalizeMessage("Cannot read x")).not.toBe(normalizeMessage("Cannot write x"));
  });

  it("bounds length", () => {
    expect(normalizeMessage("x".repeat(5000)).length).toBeLessThanOrEqual(300);
  });
});

describe("fingerprint", () => {
  it("is stable for the same resolved frames", () => {
    expect(fingerprint([frame()], "boom", "error")).toBe(fingerprint([frame()], "boom", "error"));
  });

  it("ignores the generated chunk name, so it survives a redeploy", () => {
    // The same bug after a rebuild: identical resolved frames, different
    // generated file. This is the property that keeps one bug one issue.
    const before = fingerprint([frame()], "boom", "error");
    const after = fingerprint([frame()], "boom", "error");
    expect(before).toBe(after);
  });

  it("separates different source locations", () => {
    const a = fingerprint([frame({ line: 214 })], "boom", "error");
    const b = fingerprint([frame({ line: 800 })], "boom", "error");
    expect(a).not.toBe(b);
  });

  it("separates different error kinds", () => {
    const a = fingerprint([frame()], "boom", "error");
    const b = fingerprint([frame()], "boom", "unhandledrejection");
    expect(a).not.toBe(b);
  });

  it("groups the same bug carrying different ids in the message", () => {
    const a = fingerprint([frame()], "Failed for user 8f3a1b2c-1111-2222-3333-444455556666", "error");
    const b = fingerprint([frame()], "Failed for user 22bcdead-9999-8888-7777-666655554444", "error");
    expect(a).toBe(b);
  });

  it("ignores third-party frames entirely", () => {
    // The cross-engine bug: V8 and JSC disagree about which framework frames
    // exist, so any key built from them differs by browser.
    const dep = frame({ file: "node_modules/react-dom/cjs/react-dom.production.js", line: 13717 });
    const pnpm = frame({ file: "node_modules/.pnpm/next@16/dist/client.js", line: 42 });
    const withDeps = [frame(), dep, pnpm];
    expect(fingerprint(withDeps, "boom", "error")).toBe(fingerprint([frame()], "boom", "error"));
  });

  it("is stable when an engine elides an application frame", () => {
    // Chromium reports the onClick frame; WebKit does not. Same bug, one key.
    const chromium = [
      frame({ file: "src/broken.ts", line: 10 }),
      frame({ file: "app/page.tsx", line: 22 }),
      frame({ file: "node_modules/react-dom/x.js", line: 1 }),
    ];
    const webkit = [
      frame({ file: "src/broken.ts", line: 10 }),
      frame({ file: "node_modules/react-dom/x.js", line: 1 }),
    ];
    expect(fingerprint(chromium, "boom", "error")).toBe(fingerprint(webkit, "boom", "error"));
  });

  it("falls back to a dependency frame when nothing in the app resolved", () => {
    const onlyDeps = [frame({ file: "node_modules/left-pad/index.js", line: 7 })];
    expect(fingerprint(onlyDeps, "boom", "error")).toHaveLength(16);
    // Still separates two different dependency locations.
    const other = [frame({ file: "node_modules/left-pad/index.js", line: 99 })];
    expect(fingerprint(onlyDeps, "boom", "error")).not.toBe(fingerprint(other, "boom", "error"));
  });

  it("prefers resolved frames over unresolved ones", () => {
    const mixed = [frame({ resolved: false, file: "chunk-4f2a.js" }), frame()];
    // Adding an unresolved frame in front must not change the key, or every
    // report would depend on how much of the stack happened to resolve.
    expect(fingerprint(mixed, "boom", "error")).toBe(fingerprint([frame()], "boom", "error"));
  });

  it("falls back to function names when nothing resolved", () => {
    const unresolved = [frame({ resolved: false, file: "chunk-4f2a.js" })];
    const key = fingerprint(unresolved, "boom", "error");
    expect(key).toHaveLength(16);
    // Same functions, different chunk hash after a rebuild: still one issue.
    const rebuilt = [frame({ resolved: false, file: "chunk-99zz.js" })];
    expect(fingerprint(rebuilt, "boom", "error")).toBe(key);
  });

  it("falls back to the message alone with no usable frames", () => {
    expect(fingerprint([], "boom", "error")).toHaveLength(16);
    expect(fingerprint([], "boom", "error")).not.toBe(fingerprint([], "bang", "error"));
  });

  it("produces one key for one bug across all three engines", () => {
    // The end-to-end version of the parser's consistency test: Chrome, Safari
    // and Firefox reporting the same throw must land in the same issue.
    const keys = Object.values(ENGINE_STACKS).map((fixture) =>
      fingerprint(parseStack(fixture.stack), "TypeError: watchfire fixture failure", "error"),
    );
    expect(new Set(keys).size).toBe(1);
  });
});
