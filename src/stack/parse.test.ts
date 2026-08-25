/**
 * Parser tests.
 *
 * The stacks in `fixtures.ts` are CAPTURED, not written: `e2e/capture-stacks`
 * throws known errors in real Chromium, WebKit and Firefox and writes what the
 * engines actually produced. Hand-written fixtures would test the parser
 * against the same assumptions that produced it, which is not a test.
 */
import { describe, expect, it } from "vitest";
import { parseStack } from "./parse.js";
import { ENGINE_STACKS } from "./fixtures.js";

describe("parseStack", () => {
  it("returns no frames for absent stacks", () => {
    expect(parseStack(null)).toEqual([]);
    expect(parseStack(undefined)).toEqual([]);
    expect(parseStack("")).toEqual([]);
  });

  it("never throws on malformed input", () => {
    const nonsense = ["at", "@@@@", ":::", "at (((", "\n\n\n", "a".repeat(5000)];
    for (const input of nonsense) {
      expect(() => parseStack(input)).not.toThrow();
    }
  });

  describe.each(Object.entries(ENGINE_STACKS))("%s", (engine, fixture) => {
    const frames = parseStack(fixture.stack);

    it("extracts at least one frame", () => {
      expect(frames.length).toBeGreaterThan(0);
    });

    it("drops the header line rather than parsing it as a frame", () => {
      // Every frame must have a real position; a header has none.
      for (const frame of frames) {
        expect(frame.line).not.toBeNull();
        expect(frame.column).not.toBeNull();
      }
    });

    it("finds the throwing function in the top frames", () => {
      const names = frames.slice(0, 3).map((frame) => frame.fn);
      expect(names).toContain(fixture.expectedTopFunction);
    });

    it("parses positive line and column numbers", () => {
      for (const frame of frames) {
        expect(frame.line).toBeGreaterThan(0);
        expect(frame.column).toBeGreaterThan(0);
      }
    });

    it(`identifies the source file (${engine})`, () => {
      expect(frames[0]?.file).toContain(fixture.expectedFileFragment);
    });
  });

  it("normalizes anonymous frames to null across engines", () => {
    const v8 = parseStack("Error: x\n    at https://h/a.js:1:2");
    const jsc = parseStack("@https://h/a.js:1:2");
    expect(v8[0]?.fn).toBeNull();
    expect(jsc[0]?.fn).toBeNull();
  });

  it("strips Gecko closure suffixes so names match V8", () => {
    const gecko = parseStack("handleClick/<@https://h/a.js:1:2");
    expect(gecko[0]?.fn).toBe("handleClick");
  });

  it("strips the V8 `new` prefix from constructor frames", () => {
    const frames = parseStack("Error: x\n    at new Widget (https://h/a.js:3:4)");
    expect(frames[0]?.fn).toBe("Widget");
  });

  it("skips native and eval pseudo-frames", () => {
    const frames = parseStack(
      ["Error: x", "    at fn (https://h/a.js:1:2)", "    at Array.map (native)"].join("\n"),
    );
    expect(frames).toHaveLength(1);
  });

  it("handles V8 async frames", () => {
    const frames = parseStack("Error: x\n    at async load (https://h/a.js:9:1)");
    expect(frames[0]).toMatchObject({ fn: "load", line: 9, column: 1 });
  });
});

describe("cross-engine consistency", () => {
  /**
   * The property the whole design rests on: one bug thrown in three engines
   * must produce the same top frames, because the fingerprint is computed
   * from them. If Chrome and Safari disagree here, every issue is three
   * issues.
   */
  const parsed = Object.entries(ENGINE_STACKS).map(
    ([engine, fixture]) => [engine, parseStack(fixture.stack)] as const,
  );

  it("agrees on the top three function names", () => {
    const signatures = parsed.map(([, frames]) => frames.slice(0, 3).map((f) => f.fn).join(">"));
    expect(new Set(signatures).size).toBe(1);
    expect(signatures[0]).toBe("innerThrow>middleCall>handleClick");
  });

  it("agrees on the top three source files and lines", () => {
    const signatures = parsed.map(([, frames]) =>
      frames.slice(0, 3).map((f) => `${f.file}:${f.line}`).join(">"),
    );
    expect(new Set(signatures).size).toBe(1);
  });

  it("rejects engine pseudo-locations from eval and debugger frames", () => {
    for (const [engine, frames] of parsed) {
      const pseudo = frames.filter((f) => /\s|debugger|eval at/.test(f.file));
      expect(pseudo, `${engine} kept a pseudo-location frame`).toEqual([]);
    }
  });
});
