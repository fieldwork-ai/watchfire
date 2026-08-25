/**
 * The seam where framework knowledge lives.
 *
 * `watchfire maps` itself is bundler-neutral: it moves maps out of a public
 * directory, strips the pointers, and verifies nothing stayed public. What it
 * cannot know generically is WHERE those directories are and what names a
 * release: that is bundler output layout, and it is the one place framework
 * specificity is unavoidable. A preset answers exactly those questions and
 * nothing else, so supporting a new bundler is one new file here, not a new
 * package.
 */
export interface BundlePreset {
  name: string;
  /** Whether this preset applies to the project at `root`. */
  detect(root: string): Promise<boolean>;
  /** The public output directory whose maps must move out and verify clean. */
  publicDir(root: string): string;
  /** Release id when `--release` is not passed. Throws with guidance if underivable. */
  defaultRelease(root: string): Promise<string>;
  /**
   * The directory that will be the server's working directory at runtime,
   * which is where the private maps directory is created: the runtime
   * resolver reads `process.cwd()` relative paths.
   */
  destinationRoot(root: string): Promise<string>;
  /** Logged when the build produced no maps at all. */
  missingMapsHint: string;
}
