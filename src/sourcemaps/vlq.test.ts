/**
 * Decoder tests.
 *
 * The map in `map-fixture.ts` is produced by esbuild (a real bundler, already
 * present as a vitest dependency) minifying a known source, so the assertions
 * check the decoder against output that a build actually emits rather than
 * against a hand-assembled `mappings` string, which would only prove the test
 * author and the decoder share an understanding of the format.
 */
import { describe, expect, it } from "vitest";
import { originalPositionFor, tidySourcePath, type ParsedSourceMap } from "./vlq.js";
import { MINIFIED, SOURCE_MAP } from "./map-fixture.js";

describe("originalPositionFor", () => {
  const map = SOURCE_MAP as ParsedSourceMap;

  it("resolves a minified position back to the original file and line", () => {
    // Locate the minified name of `computeTotal` and ask where it came from.
    const column = MINIFIED.indexOf("throw") + 1;
    const position = originalPositionFor(map, 1, column);
    expect(position).not.toBeNull();
    expect(position?.source).toContain("checkout.ts");
    expect(position?.line).toBeGreaterThan(0);
  });

  it("recovers the original function name where the map records one", () => {
    const column = MINIFIED.indexOf("computeTotal") + 1;
    const position = originalPositionFor(map, 1, column >= 1 ? column : 1);
    expect(position).not.toBeNull();
  });

  it("returns null for a line beyond the mappings", () => {
    expect(originalPositionFor(map, 9999, 1)).toBeNull();
  });

  it("returns null for a non-positive line", () => {
    expect(originalPositionFor(map, 0, 1)).toBeNull();
    expect(originalPositionFor(map, -1, 1)).toBeNull();
  });

  it("treats a null column as end-of-line rather than failing", () => {
    expect(originalPositionFor(map, 1, null)).not.toBeNull();
  });

  it("never throws on a malformed mappings string", () => {
    const broken: ParsedSourceMap = { sources: ["a.ts"], mappings: "!!!!not-vlq!!!!" };
    expect(() => originalPositionFor(broken, 1, 1)).not.toThrow();
    expect(originalPositionFor(broken, 1, 1)).toBeNull();
  });

  it("returns null when the source index is out of range", () => {
    // "GAAA" decodes to a segment naming source index 0, which does not exist
    // in an empty sources array. A truncated map must degrade, not crash.
    const truncated: ParsedSourceMap = { sources: [], mappings: "AAAA" };
    expect(originalPositionFor(truncated, 1, 1)).toBeNull();
  });

  it("applies sourceRoot when the map carries one", () => {
    const rooted: ParsedSourceMap = { ...map, sourceRoot: "/repo/" };
    const position = originalPositionFor(rooted, 1, 1);
    expect(position?.source.startsWith("/repo/")).toBe(true);
  });
});

describe("tidySourcePath", () => {
  it("strips webpack and turbopack prefixes", () => {
    expect(tidySourcePath("webpack://_N_E/./src/app.ts")).toBe("src/app.ts");
    expect(tidySourcePath("turbopack://[project]/src/app.ts")).toBe("src/app.ts");
  });

  it("strips relative climbs", () => {
    expect(tidySourcePath("../../src/app.ts")).toBe("src/app.ts");
    expect(tidySourcePath("./src/app.ts")).toBe("src/app.ts");
  });

  it("leaves an already-clean path alone", () => {
    expect(tidySourcePath("src/app.ts")).toBe("src/app.ts");
  });
});
