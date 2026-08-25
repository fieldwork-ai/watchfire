/**
 * Boot-time map registration.
 *
 * Every server instance pushes its own release's maps to the shared store on
 * startup, if they are not already there. This is push-if-absent rather than a
 * deploy-pipeline step for three reasons: the credentials are the runtime's,
 * which already exist, rather than new CI secrets; a wiped or restored bucket
 * repopulates itself on the next restart; and a step that must run on every
 * deploy but fails silently when skipped is a trap, whereas shipping the code
 * IS the registration here.
 *
 * The push is safe to be slow and safe to fail. Nothing in the current release
 * needs the shared store: local maps resolve it. The upload only matters to
 * the NEXT release, hours or days away, which is why this never blocks boot.
 */
import type { MapStore } from "./store.js";

export interface RegisterMapsOptions {
  release: string;
  /** Directory the build step wrote maps into. */
  localDir: string;
  /** Shared store to push to. Pass null to make registration a no-op. */
  store: MapStore | null;
  /** Called with a one-line summary, or an error. Defaults to silence. */
  onLog?: (message: string, error?: unknown) => void;
}

/**
 * Copies any local maps missing from the shared store. Resolves when done;
 * callers should NOT await it during startup.
 */
export async function registerMaps(options: RegisterMapsOptions): Promise<void> {
  const { release, localDir, store, onLog } = options;
  if (store === null) return;

  try {
    const [{ readdir, readFile }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);

    let names: string[];
    try {
      names = (await readdir(localDir)).filter((name) => name.endsWith(".map"));
    } catch {
      // No local maps: a dev server, or a build that skipped the maps step.
      // Not an error, and not worth a log line on every boot.
      return;
    }
    if (names.length === 0) return;

    const present = new Set(await store.list(release));
    const missing = names.filter((name) => !present.has(name));
    if (missing.length === 0) {
      onLog?.(`watchfire: ${names.length} maps already registered for ${release}`);
      return;
    }

    let pushed = 0;
    for (const name of missing) {
      try {
        await store.put(release, name, await readFile(join(localDir, name), "utf8"));
        pushed++;
      } catch (error) {
        // One failed map must not abandon the rest: a partial registration
        // still resolves most frames, and the next boot retries the gaps.
        onLog?.(`watchfire: failed to register ${name}`, error);
      }
    }
    onLog?.(`watchfire: registered ${pushed}/${missing.length} maps for ${release}`);
  } catch (error) {
    onLog?.("watchfire: map registration failed", error);
  }
}
