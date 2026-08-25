/**
 * The Next.js preset: `.next/static` is the public output, `.next/BUILD_ID`
 * names the release, and the destination is wherever `server.js` will run
 * from inside standalone output.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BundlePreset } from "./types.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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

export const nextPreset: BundlePreset = {
  name: "next",

  async detect(root: string): Promise<boolean> {
    return exists(join(root, ".next"));
  },

  publicDir(root: string): string {
    return join(root, ".next", "static");
  },

  async defaultRelease(root: string): Promise<string> {
    try {
      return (await readFile(join(root, ".next", "BUILD_ID"), "utf8")).trim();
    } catch {
      throw new Error("Could not read .next/BUILD_ID. Pass --release explicitly.");
    }
  },

  async destinationRoot(root: string): Promise<string> {
    const nextDir = join(root, ".next");
    const standaloneDir = join(nextDir, "standalone");
    // Maps must land where the SERVER's working directory will be, because the
    // runtime resolves them at `process.cwd()/.watchfire/maps`. For a plain app
    // that is the standalone root, but Next nests the output by workspace-
    // relative path when it detects a monorepo, putting server.js several
    // directories down. Locating server.js is the only rule correct for both.
    if (await exists(standaloneDir)) {
      return (await findServerDir(standaloneDir)) ?? standaloneDir;
    }
    return nextDir;
  },

  missingMapsHint:
    "watchfire: no .map files found under .next/static. " +
    "Set `productionBrowserSourceMaps: true` in next.config.",
};
