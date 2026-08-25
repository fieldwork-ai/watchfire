/**
 * Grouping keys.
 *
 * Two properties matter and they pull against each other: the same bug must
 * hash the same across deploys (so a release cannot fragment an issue), and
 * two different bugs must not collide. The resolution is to hash only things
 * that survive a rebuild — original file paths, original line numbers, and
 * function names — and never the generated chunk name, which changes whenever
 * anything in the bundle does.
 *
 * When no frame resolved (no source maps configured, or a stale release), the
 * fallback hashes function names plus the normalized message. Function names
 * survive minification only when the build keeps them, which is why the docs
 * ask for `keep_fnames`; without it the fallback degrades to the message
 * alone, which over-groups but never crashes.
 */
import type { Frame } from "../types.js";

/**
 * Variable parts of a message, templated out before hashing. Without this,
 * "Failed to load user 8f3a" and "Failed to load user 22bc" are two issues
 * forever, which is the single most common complaint about naive grouping.
 */
const VARIABLE_PATTERNS: Array<[RegExp, string]> = [
  // UUIDs first: they would otherwise be partly eaten by the hex rule.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/\b0x[0-9a-f]+\b/gi, "<hex>"],
  [/\b[0-9a-f]{16,}\b/gi, "<hash>"],
  [/\bhttps?:\/\/[^\s"')]+/gi, "<url>"],
  [/\b\d+(?:\.\d+)?\b/g, "<n>"],
  [/"[^"]*"/g, '"<s>"'],
  [/'[^']*'/g, "'<s>'"],
];

export function normalizeMessage(message: string): string {
  let out = message;
  for (const [pattern, replacement] of VARIABLE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** FNV-1a, 64-bit, as 16 lowercase hex characters. No dependency, stable forever. */
function fnv1a64(input: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * How many frames feed the key. Deep frames are shared by unrelated bugs (the
 * framework's dispatch machinery), so including all of them under-groups;
 * including only one over-groups when a single helper throws for many callers.
 */
const SIGNIFICANT_FRAMES = 3;

export function fingerprint(frames: Frame[], message: string, kind: string): string {
  const resolved = frames.filter((f) => f.resolved);
  const basis = resolved.length > 0 ? resolved : frames;

  const parts = basis
    .slice(0, SIGNIFICANT_FRAMES)
    .map((f) => (f.resolved ? `${f.file}:${f.line}:${f.fn ?? "?"}` : (f.fn ?? "?")))
    .filter((part) => part !== "?");

  // No usable frame data at all: the message carries the whole signature.
  const signature =
    parts.length > 0
      ? `${kind}|${parts.join("|")}|${normalizeMessage(message)}`
      : `${kind}|${normalizeMessage(message)}`;

  return fnv1a64(signature);
}
