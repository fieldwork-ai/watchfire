/**
 * Base64-VLQ `mappings` decoder.
 *
 * Only the lookup this library needs is implemented: given a generated
 * (line, column), which original (source, line, column, name) produced it.
 * The source-map format is small and frozen, so a dependency would cost more
 * than it saves, and the alternative (`source-map`, which is WASM-backed in
 * current versions) needs async init and a multi-megabyte install for this.
 */

export interface ParsedSourceMap {
  sources: string[];
  sourcesContent?: (string | null)[];
  names?: string[];
  mappings: string;
  sourceRoot?: string;
}

export interface OriginalPosition {
  source: string;
  line: number;
  column: number;
  name: string | null;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CHAR_TO_INT = new Map([...BASE64].map((c, i) => [c.charCodeAt(0), i]));

/**
 * Resolve a 1-based generated position to a 1-based original position.
 *
 * Picks the last segment at or before the target column on the target line:
 * that is the segment the position falls inside. Returns null when the line
 * carries no mappings (blank lines, bundler wrapper syntax) or the decoded
 * source index is out of range, which happens with truncated maps.
 */
export function originalPositionFor(
  map: ParsedSourceMap,
  line: number,
  column: number | null,
): OriginalPosition | null {
  if (line < 1) return null;
  const targetLine = line - 1;
  const targetCol = column === null || column < 1 ? Number.MAX_SAFE_INTEGER : column - 1;

  const { mappings } = map;
  let genLine = 0;
  let genCol = 0;
  // Source index, source line, source column and name index are all deltas
  // that persist across segments and across lines; only genCol resets.
  let srcIndex = 0;
  let srcLine = 0;
  let srcCol = 0;
  let nameIndex = 0;
  let best: { source: number; line: number; column: number; name: number | null } | null = null;

  let i = 0;
  const n = mappings.length;
  const fields = new Int32Array(5);

  while (i < n && genLine <= targetLine) {
    const ch = mappings.charCodeAt(i);
    if (ch === 59 /* ; */) {
      genLine++;
      genCol = 0;
      i++;
      continue;
    }
    if (ch === 44 /* , */) {
      i++;
      continue;
    }

    let fieldCount = 0;
    while (i < n) {
      let result = 0;
      let shift = 0;
      let cont = true;
      while (cont) {
        const digit = CHAR_TO_INT.get(mappings.charCodeAt(i));
        // A character outside the alphabet means a malformed map. Stop and
        // return whatever was resolved before it rather than throwing.
        if (digit === undefined) return best === null ? null : finish(best);
        i++;
        cont = (digit & 32) !== 0;
        result += (digit & 31) << shift;
        shift += 5;
      }
      fields[fieldCount++] = result & 1 ? -(result >> 1) : result >> 1;
      const next = i < n ? mappings.charCodeAt(i) : 59;
      if (next === 44 || next === 59 || fieldCount === 5) break;
    }

    genCol += fields[0] ?? 0;
    if (fieldCount >= 4) {
      srcIndex += fields[1] ?? 0;
      srcLine += fields[2] ?? 0;
      srcCol += fields[3] ?? 0;
      if (fieldCount === 5) nameIndex += fields[4] ?? 0;

      if (genLine === targetLine && genCol <= targetCol) {
        best = {
          source: srcIndex,
          line: srcLine,
          column: srcCol,
          name: fieldCount === 5 ? nameIndex : null,
        };
      }
      // Past the target on the right line: the previous hit was the one.
      if (genLine === targetLine && genCol > targetCol && best !== null) {
        return finish(best);
      }
    }
  }

  return best === null ? null : finish(best);

  function finish(hit: NonNullable<typeof best>): OriginalPosition | null {
    const source = map.sources[hit.source];
    if (source === undefined) return null;
    const name = hit.name === null ? null : (map.names?.[hit.name] ?? null);
    const root = map.sourceRoot;
    return {
      source: root ? `${root.replace(/\/$/, "")}/${source.replace(/^\//, "")}` : source,
      line: hit.line + 1,
      column: hit.column + 1,
      name,
    };
  }
}

/**
 * Strip the bundler prefixes that make a resolved path unreadable.
 * Turbopack and webpack both emit protocol-ish prefixes and long relative
 * climbs that carry no information once the repo root is implied.
 */
export function tidySourcePath(source: string): string {
  return source
    .replace(/^webpack:\/\/(?:_N_E)?\/?/, "")
    .replace(/^turbopack:\/\/(?:\[project\])?\/?/, "")
    // Turbopack also emits a bare `[project]/` prefix with no protocol, which
    // is what a real Next 16 build produces in `sources`.
    .replace(/^\[project\]\/?/, "")
    .replace(/^(?:\.\.\/)+/, "")
    .replace(/^\.\//, "");
}
