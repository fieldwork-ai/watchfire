# Using watchfire without Next.js

The runtime is framework neutral; only the build tooling and the documented setup path are Next-specific. This page states the contract those neutral pieces implement, so you can wire them into any stack. It documents the seam, not a promise of presets: if you want first-class support for another bundler, open an issue.

## What works as-is

- `watchfire/browser`: `init`, `captureError`, breadcrumbs. Plain browser APIs, no framework assumptions. Call `init` from whatever runs earliest on your pages.
- `watchfire/ingest`: `createIngestHandler` returns a web-standard `(Request) => Response` function. Mount it on any framework that speaks fetch semantics (Hono, Bun, Deno, SvelteKit endpoints); for Express, adapt with a small `Request`/`Response` bridge.
- `watchfire/stack` and `watchfire/sourcemaps`: pure functions and stores, no framework anywhere.

## What you must replicate: the maps step

`watchfire maps` is Next-only because it knows Next's output layout. For another bundler, replicate its contract with a script of your own:

1. After your production build, find every `.map` file in the publicly served output.
2. Move each map into `<server working directory>/.watchfire/maps/<release>/`, named `<chunk basename>.map`. The chunk's own `sourceMappingURL` comment is the authoritative chunk-to-map link; do not assume `<chunk>.js.map` naming, which only some bundlers follow.
3. Strip the `//# sourceMappingURL=` comment from each served chunk.
4. Fail the build if any `.map` remains under the public output. This verification is the point: a public map serves your source to anyone who asks, and nothing else will tell you.

`<release>` is any string that is identical in three places: this directory name, the `release` your pages pass to `init`, and stable for the lifetime of the build. A deploy tag or git SHA works.

## Resolution at runtime

`filesystemStore(defaultMapsDir())` reads `<cwd>/.watchfire/maps`; pass your own path if your server runs elsewhere. For resolving stacks from browsers still on an older build, use a shared store and `registerMaps` on boot, exactly as the README describes for Next.
