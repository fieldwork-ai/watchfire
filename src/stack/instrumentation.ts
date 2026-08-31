/**
 * Removing Watchfire's own frames from a resolved stack.
 *
 * Breadcrumb capture patches `window.fetch`, so Watchfire's wrapper is the
 * caller of every request the page makes. When one of those requests rejects,
 * the wrapper is frame 0 of the resulting stack — ahead of the application code
 * that actually made the call. Every network error in a instrumented app
 * therefore appears, on first reading, to have happened inside Watchfire.
 *
 * Grouping was never affected (the fingerprint skips dependency frames), but
 * the stack is the thing a person reads, and this one lies about where the
 * error came from. It cost the author an hour of misdiagnosis against real
 * production data, which is the entire argument for the module.
 *
 * Two restrictions keep the removal honest:
 *   - only RESOLVED frames are considered. An unresolved frame carries a
 *     generated chunk URL, and Watchfire's code is bundled into the host's
 *     chunks, so an unresolved frame cannot be attributed to anyone.
 *   - the last non-Watchfire frame is never removed. A stack made entirely of
 *     Watchfire frames is a bug in Watchfire, and dropping it would hide the
 *     one report that could prove it.
 */
import type { Frame } from "../types.js";

/**
 * This package's own source, under either installed layout.
 *
 * `node_modules/watchfire/dist/` matches npm and Yarn directly, and pnpm too:
 * its store path ends in the same two segments
 * (`.pnpm/watchfire@1.2.1_.../node_modules/watchfire/dist/browser/...`).
 *
 * Anchoring on `node_modules/` is what keeps it narrow. A host with its own
 * `src/watchfire/` wrapper owns that code, and its frames must survive.
 */
const OWN_SOURCE = /(?:^|\/)node_modules\/watchfire\/dist\//;

export function isInstrumentationFrame(frame: Frame): boolean {
  return frame.resolved && OWN_SOURCE.test(frame.file);
}

/**
 * The stack as the application sees it.
 *
 * Returns the input unchanged when nothing would survive the filter, so the
 * caller never has to handle an empty result that used to hold frames.
 */
export function stripInstrumentationFrames(frames: Frame[]): Frame[] {
  const kept = frames.filter((frame) => !isInstrumentationFrame(frame));
  return kept.length === 0 ? frames : kept;
}
