import { MAPS_DIR } from "../constants.js";

/**
 * Where a running server finds the maps its build produced.
 *
 * The build step places them beside `server.js`, which is the process working
 * directory in standalone output, so this is simply cwd-relative. Exposed as a
 * function rather than documented as a path because getting it wrong fails
 * silently: every frame just stays unresolved, which looks exactly like "no
 * maps for this release".
 */
export function defaultMapsDir(cwd: string = process.cwd()): string {
  return `${cwd.replace(/\/$/, "")}/${MAPS_DIR}`;
}
