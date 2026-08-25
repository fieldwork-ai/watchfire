/**
 * Stack-trace parsing for the three engines that matter.
 *
 * `error.stack` is not standardized and the three families disagree on
 * everything except containing a URL and two numbers:
 *
 *   V8     "    at fnName (https://host/a.js:1:2)"   header line, "at" prefix
 *   JSC    "fnName@https://host/a.js:1:2"            no header, "@" separator
 *   Gecko  "fnName@https://host/a.js:1:2"            no header, same shape
 *
 * JSC and Gecko share a shape but differ in what they put in the function slot
 * (Gecko emits "fn/<" for closures, JSC emits bare names and "eval code"), so
 * one parser handles both and normalizes the function name afterwards.
 *
 * The parser is deliberately total: an unrecognized line is skipped rather
 * than throwing, and a wholly unrecognized stack yields an empty frame list.
 * A reporting pipeline that throws while describing an error is worse than one
 * that degrades, and the raw string is retained on the event regardless.
 */
import type { Frame } from "../types.js";

/** V8: `at fn (url:line:col)`, `at url:line:col`, `at async fn (url:line:col)`. */
const V8_LINE = /^\s*at\s+(?:async\s+)?(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/;

/** JSC/Gecko: `fn@url:line:col`, `@url:line:col`, `url:line:col`. */
const AT_LINE = /^(?:(.*?)@)?(.+?):(\d+):(\d+)$/;

/**
 * Frames whose "file" is not a real location.
 *
 * The engines each invent their own pseudo-locations for code with no source:
 * V8 writes `eval at evaluate (:311:30), <anonymous>`, Gecko writes
 * `debugger eval code line 311 > eval`. Both were observed in the captured
 * fixtures. A real URL or path never contains a space, which catches the whole
 * family without an engine-specific list, and the named forms cover the rest.
 */
const NON_FILE = /^(?:<anonymous>|native|eval|unknown location|\[native code\])$/;
const PSEUDO_FILE = /\s/;

/**
 * Names the engines use for "no function here". Normalized to null so the same
 * frame from Chrome and Safari fingerprints identically.
 */
const ANONYMOUS = new Set(["", "<anonymous>", "Anonymous function", "global code", "eval code"]);

function normalizeFn(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let fn = raw.trim();
  // Gecko marks closures and generators with trailing "/<" or "/name".
  const slash = fn.indexOf("/");
  if (slash > 0) fn = fn.slice(0, slash);
  // V8 wraps constructor and object-method frames: "new Foo", "Object.bar".
  if (fn.startsWith("new ")) fn = fn.slice(4);
  if (ANONYMOUS.has(fn)) return null;
  return fn.length > 0 ? fn : null;
}

/**
 * Whether a line is V8's leading "TypeError: message" header rather than a
 * frame. Gecko and JSC omit the header entirely, which is why presence of the
 * header cannot be used to pick a parser.
 */
function isHeader(line: string): boolean {
  return !line.startsWith("at ") && !line.includes("@") && !/:\d+:\d+\)?$/.test(line);
}

export function parseStack(stack: string | null | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];

  for (const rawLine of stack.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || isHeader(line)) continue;

    const match = V8_LINE.exec(line) ?? AT_LINE.exec(line);
    if (match === null) continue;

    const [, fnRaw, fileRaw, lineNo, colNo] = match;
    if (fileRaw === undefined || lineNo === undefined || colNo === undefined) continue;

    const file = fileRaw.trim();
    if (file.length === 0 || NON_FILE.test(file) || PSEUDO_FILE.test(file)) continue;

    frames.push({
      fn: normalizeFn(fnRaw),
      file,
      line: Number.parseInt(lineNo, 10),
      column: Number.parseInt(colNo, 10),
      resolved: false,
    });
  }

  return frames;
}
