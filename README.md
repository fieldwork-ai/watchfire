# Watchfire

Self-hosted error tracking for Next.js. A library, not a service.

[![CI](https://github.com/fieldwork-ai/watchfire/actions/workflows/ci.yml/badge.svg)](https://github.com/fieldwork-ai/watchfire/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/watchfire)](https://www.npmjs.com/package/watchfire)
[![license](https://img.shields.io/npm/l/watchfire)](LICENSE)

Watchfire captures JavaScript errors in your users' browsers, resolves the minified stack traces back to your original source using privately held source maps, gives each error a stable fingerprint for grouping, and hands the result to a callback in your code. Error data stays on your infrastructure, and there's no extra service to run.

```
npm install watchfire
```

## Why

Hosted error tracking sends stack traces and user context to a third party, which for many teams means a subprocessor agreement and a vendor review. Self-hosting a full platform (Sentry's stack is Kafka, ClickHouse, Redis, and Postgres) is a lot of infrastructure for what is usually a few dozen events a day.

The hard part of error tracking is resolving minified stack traces against source maps without making the maps public. That fits in a library. Storage, alerting, and dashboards are left to the tools you already run: watchfire delivers each error as a structured event, and you decide what to store and when to alert.

There's no UI, no issue workflow, and no analytics.

## How it works

```
browser error ──POST──▶ /api/errors (a route in your app)
                              │
                              ▼
                validate → rate-limit → scrub → parse → resolve → fingerprint
                              │
                              ▼
                        onEvent(event)   ← your code: a DB insert, a log line
```

One package, five subpath exports and a CLI:

| Import | Contents |
| --- | --- |
| `watchfire/browser` | Client SDK: capture, breadcrumbs, batching, repeat suppression. 5 kB minified, 2.3 kB gzipped |
| `watchfire/ingest` | The route handler, a standard `(Request) => Response` function |
| `watchfire/react` | `reportBoundaryError`, for error boundaries |
| `watchfire/stack` | Stack parsing (Chrome, Safari, and Firefox formats) and fingerprinting |
| `watchfire/sourcemaps` | Map stores, the runtime resolver, boot-time registration |

The build tooling targets Next.js; the runtime is framework-neutral.

## Setup

### 1. The build

In `next.config.ts`, enable source map generation:

```ts
const nextConfig = {
  productionBrowserSourceMaps: true,
};
```

In `package.json`, run `watchfire maps` after the build:

```json
"scripts": {
  "build": "next build && watchfire maps"
}
```

`next build` writes a `.map` file beside every chunk. `watchfire maps` moves the maps into a private directory inside the server output, removes the public pointers, and fails the build if any map remains publicly reachable. Maps are stored under a release id, which defaults to Next's build id.

### 2. The route

Create `app/api/errors/route.ts`:

```ts
import { createIngestHandler, filesystemStore, defaultMapsDir } from "watchfire/ingest";

export const POST = createIngestHandler({
  maps: filesystemStore(defaultMapsDir()),
  onEvent: async (event) => {
    await db.insertInto("client_errors").values({
      fingerprint: event.fingerprint,
      message: event.message,
      frames: JSON.stringify(event.frames),
    }).execute();
  },
});
```

`onEvent` receives the finished event: parsed, resolved to original source, fingerprinted.

### 3. The client

Create `instrumentation-client.ts` at the project root. Next runs any file with that name in the browser before your app code starts, so nothing needs to import it:

```ts
import { init } from "watchfire/browser";

init({ endpoint: "/api/errors", release: process.env.NEXT_PUBLIC_RELEASE });
```

`release` must match the id the maps were stored under in step 1. A report with an unknown release is still delivered, but without resolved source positions. The simplest arrangement is one env var used in both places: return it from `generateBuildId` so it becomes the build id, and pass it to `init`:

```ts
// next.config.ts
generateBuildId: () => process.env.NEXT_PUBLIC_RELEASE ?? null,
```

Returning `null` falls back to Next's generated id, so local development needs no configuration.

## Source maps at runtime

Resolution reads maps from local disk, which always matches the release the server is running. This covers errors from browsers on the current bundle.

Browsers on an older bundle (tabs opened before your last deploy) produce stacks that reference the previous build. To resolve those too, configure a shared store and register each release's maps on boot:

```ts
import { layeredStore, s3Store, filesystemStore, registerMaps, defaultMapsDir } from "watchfire/sourcemaps";

const shared = s3Store({ bucket: "my-app-maps", client, commands });
void registerMaps({ release, localDir: `${defaultMapsDir()}/${release}`, store: shared });
```

`registerMaps` only uploads what's missing, so every server can call it on every boot. Without a shared store, stale-bundle errors fall back to function names instead of source positions.

## Default filtering

The default ignore list contains only errors that are noise in any application: `ResizeObserver loop` notices, cross-origin `Script error` events (which carry no usable information), and errors thrown from browser-extension code, identified by extension URLs in the stack.

Chunk-load failures, network errors, and aborted requests are reported, since they're often signal: a chunk-load spike measures how many open tabs a deploy broke, and a network-error spike can indicate an outage. To drop or reroute them, use `ignoreErrors` (substrings or regexes, matched against both message and stack) or classify them in `onEvent`.

## Privacy defaults

- Route changes and clicks: recorded as path patterns and CSS selectors, never text content
- Network breadcrumbs: method, origin, and status; `fetchFullPath: true` adds the path, and query strings are always stripped (callback URLs can contain OAuth codes)
- Console breadcrumbs: off by default
- Input values: never captured; there's no option to enable this

## Grouping

Every event carries a `fingerprint`; grouping by it gives an issue list. Two properties are enforced by tests:

- **Stable across deploys.** The fingerprint is built from resolved source paths and lines, not generated chunk names, so a rebuild doesn't split an issue. Variable parts of the message (ids, numbers, quoted strings, URLs) are normalized out.
- **Stable across engines.** Only the top application frame contributes. Engines disagree about deeper framework frames (V8 reports frames JSC elides), which would split one bug into several issues.

Repeat suppression runs in the browser: at most three reports per distinct error per page load, with the suppressed count attached to the next flush.

## Status

v1.0.0. Covered by 141 unit tests and 33 end-to-end tests that run Chromium, WebKit, and Firefox against a Next 16 build. Parser fixtures are captured from the engines rather than written by hand; the source map decoder is tested against real bundler output. Watchfire is in production at [Fieldwork](https://getfieldwork.ai).

Out of scope: a hosted UI and Sentry protocol compatibility, both of which would turn the library into a service.

## License

MIT
