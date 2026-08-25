/**
 * The one path the build step and the runtime must agree on.
 *
 * `watchfire maps` writes here, `filesystemStore` reads from here, and
 * `registerMaps` pushes from here. A literal in three files would be a
 * silent-failure bug the first time one of them changed.
 */
export const MAPS_DIR = ".watchfire/maps";
