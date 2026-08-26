/**
 * Build-step tests.
 *
 * The assertion that matters most is the leak check: a `.map` left under the
 * public output means the app is serving its own source, and that failure is
 * silent in every other respect. It is tested here against a real directory
 * tree rather than mocked file operations, because the bug it guards against
 * would be a mistake in exactly the path a mock replaces.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMaps } from "./maps.js";
import { MAPS_DIR } from "../constants.js";

let root: string;

/** Builds a plausible `.next` tree: chunks, their maps, and a BUILD_ID. */
async function fakeBuild(options: { standalone?: boolean; buildId?: string } = {}) {
  const nextDir = join(root, ".next");
  const chunks = join(nextDir, "static", "chunks");
  await mkdir(chunks, { recursive: true });
  if (options.standalone !== false) {
    await mkdir(join(nextDir, "standalone"), { recursive: true });
  }
  await writeFile(join(nextDir, "BUILD_ID"), options.buildId ?? "build-abc123");

  await writeFile(join(chunks, "main.js"), 'console.log(1)\n//# sourceMappingURL=main.js.map');
  await writeFile(join(chunks, "main.js.map"), '{"version":3,"sources":["src/a.ts"],"mappings":""}');
  await writeFile(join(chunks, "page.js"), 'console.log(2)\n//# sourceMappingURL=page.js.map');
  await writeFile(join(chunks, "page.js.map"), '{"version":3,"sources":["src/b.ts"],"mappings":""}');
  return { nextDir, chunks };
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "watchfire-cli-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runMaps", () => {
  it("moves every map out of the public static directory", async () => {
    const { chunks } = await fakeBuild();
    const result = await runMaps({ dir: root });

    expect(result.moved).toBe(2);
    const remaining = await readdir(chunks);
    expect(remaining.filter((name) => name.endsWith(".map"))).toEqual([]);
  });

  it("leaves NO map anywhere under the public output", async () => {
    // The whole point of the command. A single survivor publishes the source.
    await fakeBuild();
    await runMaps({ dir: root });
    const public_ = await walk(join(root, ".next", "static"));
    expect(public_.filter((file) => file.endsWith(".map"))).toEqual([]);
  });

  it("places maps inside standalone, where existing Dockerfiles already copy", async () => {
    await fakeBuild();
    const result = await runMaps({ dir: root });
    expect(result.destination).toContain(join(".next", "standalone", MAPS_DIR));
    const stored = await readdir(result.destination);
    expect(stored.sort()).toEqual(["main.js.map", "page.js.map"]);
  });

  it("falls back to .next when there is no standalone output", async () => {
    await fakeBuild({ standalone: false });
    const result = await runMaps({ dir: root });
    expect(result.destination).toContain(MAPS_DIR);
    expect(result.destination).not.toContain("standalone");
  });

  it("strips the sourceMappingURL pointer from each chunk", async () => {
    const { chunks } = await fakeBuild();
    const result = await runMaps({ dir: root });

    expect(result.stripped).toBe(2);
    const main = await readFile(join(chunks, "main.js"), "utf8");
    expect(main).not.toContain("sourceMappingURL");
    // The code itself must survive the edit.
    expect(main).toContain("console.log(1)");
  });

  it("strips CSS pointers and moves CSS maps out of public serving", async () => {
    // CSS declares its map in a block comment (/*# ... */), which the strip
    // pass originally missed: the map moved but the stylesheet kept pointing
    // at it, so any DevTools session requested a map that 404s.
    await fakeBuild();
    const cssDir = join(root, ".next", "static", "css");
    await mkdir(cssDir, { recursive: true });
    await writeFile(join(cssDir, "app.css"), "body{color:red}\n/*# sourceMappingURL=app.css.map */");
    await writeFile(join(cssDir, "app.css.map"), '{"version":3,"sources":["src/app.css"],"mappings":""}');

    const result = await runMaps({ dir: root });

    expect(result.moved).toBe(3);
    expect(result.stripped).toBe(3);
    const css = await readFile(join(cssDir, "app.css"), "utf8");
    expect(css).not.toContain("sourceMappingURL");
    // The styles themselves must survive the edit.
    expect(css).toContain("body{color:red}");
    const stored = await readdir(result.destination);
    expect(stored).toContain("app.css.map");
    const leftover = (await walk(join(root, ".next", "static"))).filter((f) => f.endsWith(".map"));
    expect(leftover).toEqual([]);
  });

  it("uses BUILD_ID as the release when none is given", async () => {
    await fakeBuild({ buildId: "build-xyz789" });
    const result = await runMaps({ dir: root });
    expect(result.release).toBe("build-xyz789");
    expect(result.destination).toContain("build-xyz789");
  });

  it("prefers an explicit release over BUILD_ID", async () => {
    await fakeBuild({ buildId: "ignored" });
    const result = await runMaps({ dir: root, release: "git-sha-1234" });
    expect(result.release).toBe("git-sha-1234");
  });

  it("changes nothing on a dry run", async () => {
    const { chunks } = await fakeBuild();
    const result = await runMaps({ dir: root, dryRun: true });
    expect(result.moved).toBe(0);
    const remaining = await readdir(chunks);
    expect(remaining.filter((name) => name.endsWith(".map"))).toHaveLength(2);
  });

  it("fails loudly when there is no .next directory", async () => {
    await expect(runMaps({ dir: root })).rejects.toThrow(/No .next directory/);
  });

  it("fails when no release can be determined", async () => {
    await mkdir(join(root, ".next", "static"), { recursive: true });
    await expect(runMaps({ dir: root })).rejects.toThrow(/BUILD_ID/);
  });

  it("warns rather than failing when the build produced no maps", async () => {
    // A build without `productionBrowserSourceMaps` is a misconfiguration to
    // report, not a reason to break someone's build.
    await mkdir(join(root, ".next", "static"), { recursive: true });
    await writeFile(join(root, ".next", "BUILD_ID"), "b1");
    const logs: string[] = [];
    const result = await runMaps({ dir: root, log: (m) => logs.push(m) });
    expect(result.moved).toBe(0);
    expect(logs.join(" ")).toContain("productionBrowserSourceMaps");
  });

  it("is idempotent across repeated runs", async () => {
    await fakeBuild();
    await runMaps({ dir: root });
    const second = await runMaps({ dir: root });
    expect(second.moved).toBe(0);
    expect(second.stripped).toBe(0);
  });
});

describe("map-to-chunk association", () => {
  /**
   * Turbopack does NOT name a map after its chunk: a real Next 16 build emits
   * `3rf7vuwqjn2o9.js` pointing at `436du6w0scwwt.js.map`. Webpack's
   * `<chunk>.js.map` convention holds only by accident, so the sourceMappingURL
   * comment is the only authoritative link. Getting this wrong resolves nothing
   * while looking exactly like "this release has no maps".
   */
  it("follows sourceMappingURL when the map name differs from the chunk", async () => {
    const nextDir = join(root, ".next");
    const chunks = join(nextDir, "static", "chunks");
    await mkdir(chunks, { recursive: true });
    await writeFile(join(nextDir, "BUILD_ID"), "turbo-build");
    await writeFile(join(chunks, "3rf7vuwqjn2o9.js"), 'x=1\n//# sourceMappingURL=436du6w0scwwt.js.map');
    await writeFile(join(chunks, "436du6w0scwwt.js.map"), '{"version":3,"sources":["src/page.tsx"],"mappings":""}');

    const result = await runMaps({ dir: root });

    // Stored under the CHUNK name, which is what a stack frame carries.
    const stored = await readdir(result.destination);
    expect(stored).toContain("3rf7vuwqjn2o9.js.map");
    const contents = await readFile(join(result.destination, "3rf7vuwqjn2o9.js.map"), "utf8");
    expect(contents).toContain("src/page.tsx");
  });

  it("moves orphan maps out of the public output too", async () => {
    const nextDir = join(root, ".next");
    const chunks = join(nextDir, "static", "chunks");
    await mkdir(chunks, { recursive: true });
    await writeFile(join(nextDir, "BUILD_ID"), "b1");
    // A map no chunk points at. Unlookupable, but it must not stay public.
    await writeFile(join(chunks, "orphan.js.map"), "{}");

    await runMaps({ dir: root });
    expect(await readdir(chunks)).toEqual([]);
  });

  it("leaves a chunk with an inline data: map alone", async () => {
    const nextDir = join(root, ".next");
    const chunks = join(nextDir, "static", "chunks");
    await mkdir(chunks, { recursive: true });
    await writeFile(join(nextDir, "BUILD_ID"), "b1");
    await writeFile(join(chunks, "a.js"), "x=1\n//# sourceMappingURL=data:application/json;base64,e30=");

    const result = await runMaps({ dir: root });
    expect(result.moved).toBe(0);
    // The pointer still goes: an inline map is the source shipped verbatim.
    expect(await readFile(join(chunks, "a.js"), "utf8")).not.toContain("sourceMappingURL");
  });
});

describe("standalone output layouts", () => {
  /**
   * Next nests standalone output by workspace-relative path when it detects a
   * monorepo, so `server.js` can sit several directories below the standalone
   * root. The runtime resolves maps at `process.cwd()/.watchfire/maps`, and
   * cwd is wherever server.js is, so maps written to the root would silently
   * never be found. Every frame would stay unresolved and look exactly like
   * "no maps for this release", which is why this is tested rather than
   * assumed.
   */
  it("places maps beside a nested server.js", async () => {
    await fakeBuild();
    const nested = join(root, ".next", "standalone", "packages", "web");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "server.js"), "// entry point");

    const result = await runMaps({ dir: root });
    expect(result.destination).toBe(join(nested, MAPS_DIR, "build-abc123"));
  });

  it("places maps at the standalone root for a plain app", async () => {
    await fakeBuild();
    const standalone = join(root, ".next", "standalone");
    await writeFile(join(standalone, "server.js"), "// entry point");

    const result = await runMaps({ dir: root });
    expect(result.destination).toBe(join(standalone, MAPS_DIR, "build-abc123"));
  });

  it("ignores a server.js vendored inside node_modules", async () => {
    await fakeBuild();
    const standalone = join(root, ".next", "standalone");
    const vendored = join(standalone, "node_modules", "some-dep");
    await mkdir(vendored, { recursive: true });
    await writeFile(join(vendored, "server.js"), "// not the entry point");
    await writeFile(join(standalone, "server.js"), "// the real one");

    const result = await runMaps({ dir: root });
    expect(result.destination).toBe(join(standalone, MAPS_DIR, "build-abc123"));
  });
});
