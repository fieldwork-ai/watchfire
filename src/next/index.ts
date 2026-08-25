/**
 * Next.js conveniences. This is the ONLY module in the package that is
 * allowed to know about Next config shapes; the runtime stays framework
 * neutral (enforced by src/neutrality.test.ts).
 *
 * `withWatchfire` absorbs the two next.config edits from the setup guide:
 * source map generation, and wiring the release id into the build id so
 * `watchfire maps` stores maps under the same name the browser reports.
 *
 * Deliberately NOT absorbed: the `"build": "next build && watchfire maps"`
 * script line. Next under Turbopack has no supported post-build hook, which
 * is why the CLI step exists. The wrapper reduces setup from three steps to
 * two, not to one.
 */

/**
 * The subset of Next config this wrapper touches, typed structurally so the
 * package needs no dependency on `next` itself. Pass a real `NextConfig`;
 * everything else on it flows through untouched. Deliberately NO index
 * signature: a parameter type with one rejects interfaces such as
 * `NextConfig`, which is exactly the argument every caller passes.
 */
export interface WatchfireNextConfig {
  productionBrowserSourceMaps?: boolean;
  generateBuildId?: () => string | null | Promise<string | null>;
}

export interface WithWatchfireOptions {
  /**
   * The release id inlined into this build, shared by the browser (`init`'s
   * `release`) and the maps directory. Defaults to
   * `process.env.NEXT_PUBLIC_RELEASE`. When absent, `generateBuildId`
   * returns null and Next falls back to its own generated id, so local
   * development needs no configuration.
   */
  release?: string | null;
}

// Constrained on `object`, not on WatchfireNextConfig: an all-optional
// interface is a "weak type", and TypeScript rejects any argument sharing no
// properties with it (TS2559) — which is exactly an inline config literal
// that sets neither of the two fields this wrapper owns. The interface is
// still the contract; it is read through a cast internally.
export function withWatchfire<C extends object>(
  config: C,
  options?: WithWatchfireOptions,
): C & Required<Pick<WatchfireNextConfig, "productionBrowserSourceMaps" | "generateBuildId">> {
  const release = options?.release ?? process.env.NEXT_PUBLIC_RELEASE ?? null;
  const hostBuildId = (config as WatchfireNextConfig).generateBuildId;

  return {
    ...config,
    productionBrowserSourceMaps: true,
    // A generateBuildId the host already defines wins: silently replacing an
    // explicit choice is how two tools end up fighting over one field. Hosts
    // with their own build id should pass the same value to `init` themselves.
    generateBuildId:
      hostBuildId ?? (() => (release !== null && release !== "" ? release : null)),
  };
}
