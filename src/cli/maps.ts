/**
 * `watchfire maps` - the build step.
 *
 * Three things happen, in this order, and the order is load-bearing:
 *
 *   1. MOVE every `.map` out of the public static directory into a private
 *      directory inside the server output.
 *   2. STRIP the `//# sourceMappingURL=` comment from each chunk, so browsers
 *      stop requesting a file that is no longer served.
 *   3. VERIFY no `.map` remains anywhere under the public output.
 *
 * Doing this as a post-build file move rather than a bundler plugin is a
 * deliberate bet. A plugin binds to webpack's or Turbopack's internals, and
 * Next is mid-migration between them; a file move cares only that a directory
 * exists. It also means the build needs no credentials and no network, so it
 * behaves identically in CI, in a fork PR, and on a laptop.
 *
 * The destination sits INSIDE `.next/standalone`, which existing Dockerfiles
 * already copy wholesale. That is why adopting Watchfire needs no Dockerfile
 * change: the maps ride along with the server that reads them.
 */
import { readdir, readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { MAPS_DIR } from "../constants.js";

export interface MapsOptions {
  /** Project root containing `.next`. Defaults to cwd. */
  dir: string;
  /** Release id. Defaults to the contents of `.next/BUILD_ID`. */
  release?: string | undefined;
  /** Report what would happen without moving anything. */
  dryRun?: boolean;
  log?: (message: string) => void;
}

export interface MapsResult {
  release: string;
  moved: number;
  stripped: number;
  destination: string;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

/**
 * The directory holding `server.js` inside standalone output, which is the
 * working directory the server will run from. Breadth-first and shallow: the
 * nesting mirrors the workspace path, which is never deep, and the first match
 * from the top is the entry point rather than a vendored copy in node_modules.
 */
async function findServerDir(standaloneDir: string, maxDepth = 5): Promise<string | null> {
  let frontier = [standaloneDir];
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of frontier) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.some((entry) => entry.isFile() && entry.name === "server.js")) return dir;
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== "node_modules") next.push(join(dir, entry.name));
      }
    }
    frontier = next;
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function runMaps(options: MapsOptions): Promise<MapsResult> {
  const log = options.log ?? (() => {});
  const root = options.dir;
  const nextDir = join(root, ".next");

  if (!(await exists(nextDir))) {
    throw new Error(`No .next directory at ${nextDir}. Run this after \`next build\`.`);
  }

  let release = options.release;
  if (release === undefined || release.length === 0) {
    try {
      release = (await readFile(join(nextDir, "BUILD_ID"), "utf8")).trim();
    } catch {
      throw new Error(
        "Could not read .next/BUILD_ID. Pass --release explicitly.",
      );
    }
  }

  const staticDir = join(nextDir, "static");
  const standaloneDir = join(nextDir, "standalone");

  // Maps must land where the SERVER's working directory will be, because the
  // runtime resolves them at `process.cwd()/.watchfire/maps`. For a plain app
  // that is the standalone root, but Next nests the output by workspace-
  // relative path when it detects a monorepo, putting server.js several
  // directories down. Locating server.js is the only rule correct for both.
  const destinationRoot = (await exists(standaloneDir))
    ? ((await findServerDir(standaloneDir)) ?? standaloneDir)
    : nextDir;
  const destination = join(destinationRoot, MAPS_DIR, release);

  const files = await walk(staticDir);
  const maps = files.filter((file) => file.endsWith(".map"));
  const scripts = files.filter((file) => file.endsWith(".js") || file.endsWith(".mjs"));

  if (maps.length === 0) {
    log(
      "watchfire: no .map files found under .next/static. " +
        "Set `productionBrowserSourceMaps: true` in next.config.",
    );
  }

  if (options.dryRun === true) {
    log(`watchfire: would move ${maps.length} maps to ${relative(root, destination)}`);
    return { release, moved: 0, stripped: 0, destination };
  }

  await mkdir(destination, { recursive: true });

  // Each chunk's own `sourceMappingURL` is the authoritative link to its map,
  // and it is the ONLY one that holds across bundlers. Webpack names a map
  // after its chunk, so `<chunk>.js.map` works there by accident; Turbopack
  // does not, and emits e.g. `3rf7vuwqjn2o9.js` -> `436du6w0scwwt.js.map`.
  // Assuming the naming convention silently resolves nothing on a Turbopack
  // build, which looks identical to "this release has no maps".
  //
  // Maps are therefore stored under the CHUNK's basename, which is what a
  // stack frame carries and what the runtime resolver looks up by.
  let moved = 0;
  let stripped = 0;
  const claimed = new Set<string>();

  for (const script of scripts) {
    const contents = await readFile(script, "utf8");
    const pointer = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(contents);

    if (pointer?.[1] !== undefined && !pointer[1].startsWith("data:")) {
      const dir = script.slice(0, script.lastIndexOf("/"));
      const mapPath = join(dir, pointer[1]);
      const chunkName = script.split("/").pop();
      if (chunkName !== undefined && (await exists(mapPath))) {
        await rename(mapPath, join(destination, `${chunkName}.map`));
        claimed.add(mapPath);
        moved++;
      }
    }

    // Strip the pointer. Left in place, every browser requests a map that now
    // 404s: noise in the access log, and a broken devtools experience.
    const cleaned = contents.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, "\n");
    if (cleaned !== contents) {
      await writeFile(script, cleaned, "utf8");
      stripped++;
    }
  }

  // Maps no chunk pointed at. They cannot be looked up, but they must not stay
  // public, so they move under their own names rather than being deleted:
  // removing build output on a guess is worse than carrying a few unused KB.
  for (const map of maps) {
    if (claimed.has(map)) continue;
    const name = map.split("/").pop();
    if (name === undefined) continue;
    await rename(map, join(destination, name));
  }

  // The verification is the point of the whole command. A map left under the
  // public directory means the app is serving its own source, and that failure
  // is silent in every other respect.
  const leftover = (await walk(staticDir)).filter((file) => file.endsWith(".map"));
  if (leftover.length > 0) {
    throw new Error(
      `watchfire: ${leftover.length} source map(s) still public under .next/static: ` +
        `${leftover.slice(0, 3).map((file) => relative(root, file)).join(", ")}`,
    );
  }

  log(
    `watchfire: release ${release} - moved ${moved} maps, stripped ${stripped} pointers, ` +
      `wrote ${relative(root, destination)}`,
  );

  return { release, moved, stripped, destination };
}
