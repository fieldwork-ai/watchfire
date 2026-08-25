/**
 * Turning parsed frames into readable ones.
 *
 * Every step here is best-effort by design. A frame that cannot be resolved
 * keeps its generated location and is marked `resolved: false`, because a
 * partly-readable stack is worth far more than a failed report, and the most
 * common reason for failure is entirely normal: a browser still running the
 * previous release after a deploy.
 */
import type { Frame } from "../types.js";
import type { MapStore } from "./store.js";
import { originalPositionFor, tidySourcePath, type ParsedSourceMap } from "./vlq.js";

/** Bounded so one report cannot pull an unbounded number of maps. */
const MAX_MAPS_PER_REPORT = 8;

/**
 * Parsed maps live here for the process lifetime, keyed by release and file.
 * Decoding is the expensive part and the same handful of chunks account for
 * nearly every frame, so a plain Map with a cap beats an LRU's bookkeeping.
 */
const CACHE_LIMIT = 64;
const cache = new Map<string, ParsedSourceMap | null>();

function remember(key: string, value: ParsedSourceMap | null): ParsedSourceMap | null {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

/** Test hook. Resolution caches across calls, which unit tests must not inherit. */
export function clearSourceMapCache(): void {
  cache.clear();
}

/**
 * The generated file name a map is stored under: the basename of the frame's
 * URL plus `.map`. Chunk names are unique within a release, so the path the
 * browser fetched from adds nothing and would make keys deploy-specific.
 */
function mapNameFor(file: string): string | null {
  const withoutQuery = file.split("?")[0] ?? file;
  const base = withoutQuery.split("/").pop();
  if (base === undefined || base.length === 0) return null;
  if (!base.endsWith(".js") && !base.endsWith(".mjs")) return null;
  return `${base}.map`;
}

async function loadMap(
  store: MapStore,
  release: string,
  mapName: string,
): Promise<ParsedSourceMap | null> {
  const key = `${release}/${mapName}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  // A store that throws (S3 unreachable, disk gone) must degrade to an
  // unresolved frame, never abort the report. Losing the line number is a
  // nuisance; losing the error is the failure this library exists to prevent.
  let raw: string | null;
  try {
    raw = await store.get(release, mapName);
  } catch {
    // Deliberately not cached: a transient outage must not poison the entry
    // for the life of the process.
    return null;
  }
  if (raw === null) return remember(key, null);

  try {
    const parsed = JSON.parse(raw) as ParsedSourceMap;
    // A map with no mappings string resolves nothing; treat it as absent so
    // the negative result is cached rather than re-parsed on every report.
    if (typeof parsed.mappings !== "string" || !Array.isArray(parsed.sources)) {
      return remember(key, null);
    }
    return remember(key, parsed);
  } catch {
    return remember(key, null);
  }
}

export async function resolveFrames(
  frames: Frame[],
  release: string | null,
  store: MapStore | null,
): Promise<Frame[]> {
  if (store === null || release === null || frames.length === 0) return frames;

  const loaded = new Set<string>();
  const out: Frame[] = [];

  for (const frame of frames) {
    const mapName = frame.line === null ? null : mapNameFor(frame.file);
    if (mapName === null || (!loaded.has(mapName) && loaded.size >= MAX_MAPS_PER_REPORT)) {
      out.push(frame);
      continue;
    }
    loaded.add(mapName);

    const map = await loadMap(store, release, mapName);
    if (map === null) {
      out.push(frame);
      continue;
    }

    const position = originalPositionFor(map, frame.line as number, frame.column);
    if (position === null) {
      out.push(frame);
      continue;
    }

    out.push({
      // The map's name for the position beats the engine's: minification
      // renames functions, and the map records what they were called.
      fn: position.name ?? frame.fn,
      file: tidySourcePath(position.source),
      line: position.line,
      column: position.column,
      resolved: true,
    });
  }

  return out;
}
