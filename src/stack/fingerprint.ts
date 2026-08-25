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
 * Third-party code: dependencies and framework internals.
 *
 * These frames must not reach the key, for a reason the cross-engine e2e made
 * unarguable. The engines disagree about which frames exist at all: for one
 * React click handler, V8 reports the handler frame that JSC elides. Any key
 * built from more than the application's own top frame therefore differs
 * between Chrome and Safari, and one bug becomes two issues.
 */
const THIRD_PARTY = /(?:^|\/)node_modules\/|(?:^|\/)\.pnpm\/|(?:^|\/)vendor-chunks?\//;

function isApplicationFrame(frame: Frame): boolean {
  return frame.resolved && !THIRD_PARTY.test(frame.file);
}

/**
 * The key's basis, in descending order of stability.
 *
 * Resolved application frames beat everything: original paths and line numbers
 * survive a rebuild, where a generated chunk name does not. Only the TOP one is
 * used, because the depth of the application's own frames also varies by
 * engine. The cost is that one helper throwing the same message for several
 * callers groups as one issue; the normalized message is what separates the
 * cases that genuinely differ.
 */
function basisFor(frames: Frame[]): string | null {
  const inApp = frames.find(isApplicationFrame);
  if (inApp !== undefined) return `${inApp.file}:${inApp.line}`;

  // No application frame resolved: an error thrown entirely inside a
  // dependency, or a release with no maps.
  const resolved = frames.find((frame) => frame.resolved);
  if (resolved !== undefined) return `${resolved.file}:${resolved.line}`;

  // Nothing resolved at all. Function names survive minification only when the
  // build keeps them (`keep_fnames`), so this over-groups without it, but it
  // never varies across deploys the way a chunk hash would.
  const named = frames.find((frame) => frame.fn !== null);
  return named?.fn ?? null;
}

export function fingerprint(frames: Frame[], message: string, kind: string): string {
  const basis = basisFor(frames);
  const signature =
    basis === null
      ? `${kind}|${normalizeMessage(message)}`
      : `${kind}|${basis}|${normalizeMessage(message)}`;

  return fnv1a64(signature);
}
