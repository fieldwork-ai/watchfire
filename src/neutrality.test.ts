import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * The boundary that keeps "first-class Next support" and "framework-neutral
 * runtime" both true at once. Framework knowledge is allowed in exactly two
 * places: the `watchfire/next` conveniences and the CLI's Next preset. If it
 * leaks anywhere else, the neutral runtime quietly stops being neutral, and
 * nothing else in the build would notice. Enforced mechanically because
 * intentions do not survive convenience.
 */

const SRC = join(import.meta.dirname, ".");

const ALLOWED_NEXT_IMPORTERS = new Set([
  join("next", "index.ts"),
  join("next", "index.test.ts"),
  join("cli", "presets", "next.ts"),
]);

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("framework neutrality", () => {
  it("nothing outside the Next seam imports from next", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (ALLOWED_NEXT_IMPORTERS.has(rel)) continue;
      const contents = await readFile(file, "utf8");
      if (/from\s+["']next(?:["'/])/.test(contents) || /require\(["']next["']\)/.test(contents)) {
        offenders.push(rel.split(sep).join("/"));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the neutral entry points load in a bare Node context", async () => {
    // Importing is the test: a stray window/document touch at module scope,
    // or a transitive framework dependency, throws here.
    await import("./browser/index.js");
    await import("./ingest/index.js");
    await import("./stack/index.js");
    await import("./sourcemaps/index.js");
  });
});
