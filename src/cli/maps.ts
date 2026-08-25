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
  // Standalone output is the deployable; without it the maps still need a home
  // the server can read, so they go under .next directly.
  const destinationRoot = (await exists(standaloneDir)) ? standaloneDir : nextDir;
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

  let moved = 0;
  for (const map of maps) {
    // Flattened to the basename: chunk names are unique within a release, and
    // a flat directory is what the runtime resolver looks up by.
    const name = map.split("/").pop();
    if (name === undefined) continue;
    await rename(map, join(destination, name));
    moved++;
  }

  // Strip the pointer comment. Left in place, every browser would request a
  // map that now 404s, which is noise in the access log and a slow devtools
  // experience for anyone who opens it.
  let stripped = 0;
  for (const script of scripts) {
    const contents = await readFile(script, "utf8");
    const cleaned = contents.replace(/\n?\/\/# sourceMappingURL=.*\.map\s*$/, "\n");
    if (cleaned !== contents) {
      await writeFile(script, cleaned, "utf8");
      stripped++;
    }
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
