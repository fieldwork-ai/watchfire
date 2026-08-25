# Watchfire

Self-hosted error tracking for Next.js. A library, not a service.

Watchfire catches the JavaScript errors your users hit, turns minified stack traces back into your original file names and line numbers, groups repeats under a stable fingerprint, and hands each event to a callback in your own code. Your source maps stay private and your error data never leaves your infrastructure. There is no vendor and nothing new to operate: errors land in whatever database and alert channel you already have.

```
npm install watchfire
```

## Why

Error tracking today means choosing between two heavy options. Send stack traces and user context to a hosted service and you have acquired a subprocessor, a data processing agreement, a vendor review, and a per-event bill. Self-host a full platform instead and you are operating Kafka, ClickHouse, Redis, and Postgres to store what is, for most teams, a few dozen events a day.

Watchfire exists because the hard part of error tracking is small. Turning `chunk-4f2a.js:1:88213` back into `checkout.ts:214` without publishing your source maps takes a stack parser and a source map decoder, plus somewhere private to keep the maps. It does not take a running system. Your existing stack already handles the rest: storage, alerting, retention, and dashboards belong in the tools you actually watch.

The trade is real. You get no hosted UI, no issue-assignment workflow, no release-health graphs, and no chart you didn't write the query for. What you get instead is that error data stays on your own machines, which for many teams ends the compliance conversation before it starts.

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

One npm package, five subpath exports and a CLI:

| Import | What it is |
| --- | --- |
| `watchfire/browser` | The client: capture, breadcrumbs, batching, per-page suppression. 5 kB minified, 2.3 kB gzipped |
| `watchfire/ingest` | The route handler, a web-standard `(Request) => Response` function |
| `watchfire/react` | `reportBoundaryError`, so error boundaries feed the same pipeline |
| `watchfire/stack` | Stack parsing (Chrome, Safari, and Firefox formats) and fingerprinting |
| `watchfire/sourcemaps` | Map stores, the runtime resolver, and boot-time registration |

The handler is a plain fetch-style function, so it drops into a Next.js route handler unchanged. The build tooling targets Next.js today. The runtime pieces are framework-neutral.

## Setup

The integration is three changes. First, the build step, with `productionBrowserSourceMaps: true` in `next.config.ts`:

```json
"build": "next build && watchfire maps"
```

Second, a route:

```ts
// app/api/errors/route.ts
import { createIngestHandler, filesystemStore, defaultMapsDir } from "watchfire/ingest";

export const POST = createIngestHandler({
  maps: filesystemStore(defaultMapsDir()),
  onEvent: async (event) => {
    // Yours: a row, a log line.
    await db.insertInto("client_errors").values({
      fingerprint: event.fingerprint,
      message: event.message,
      frames: JSON.stringify(event.frames),
    }).execute();
  },
});
```

Third, start the client:

```ts
import { init } from "watchfire/browser";

init({ endpoint: "/api/errors", release: process.env.NEXT_PUBLIC_RELEASE });
```

That is the whole integration. The `release` value must be the same string your build ran under, because it names the directory the maps were stored in.

To attribute reports to a tenant, pass a `context` callback. It runs per report, so a value that changes mid-session (the active organization, say) stays current:

```ts
init({
  endpoint: "/api/errors",
  release: process.env.NEXT_PUBLIC_RELEASE,
  context: () => ({ org: currentOrgId() }),
});
```

This exists because reports leave via `sendBeacon`, which cannot set request headers. The values arrive at `onEvent` as `event.context`, bounded to a dozen scalars but not verified: they are a claim from the browser, so check them against the authenticated caller before storing anything you intend to trust.

## Source maps

`watchfire maps` moves the generated `.map` files out of the public static directory into a private folder inside your server output, strips the `sourceMappingURL` pointers from the chunks, and then verifies that nothing minified-to-source remains fetchable. If a map is still publicly served, the build fails. No uploads happen during the build and no credentials sit in CI.

At runtime, resolution reads those maps from local disk, which by construction matches the version the server is running. That covers every error from a browser on the current bundle, with zero configuration.

The gap is the browser that loaded your app last week and is still running the old bundle. To resolve those, give the handler a shared store and register each release on boot:

```ts
import { layeredStore, s3Store, filesystemStore, registerMaps, defaultMapsDir } from "watchfire/sourcemaps";

const shared = s3Store({ bucket: "my-app-maps", client, commands });
void registerMaps({ release, localDir: `${defaultMapsDir()}/${release}`, store: shared });
```

`registerMaps` pushes only what is absent, so every server can call it on every boot. Skip the shared store entirely and stale-bundle errors degrade to function names instead of exact lines. Nothing breaks either way.

## What gets dropped

Only what is noise for every app: `ResizeObserver loop`, contentless cross-origin `Script error`, and anything thrown from a browser-extension frame.

**Chunk-load failures, network errors, and aborted requests are not filtered**, deliberately. For a team deploying hourly they are routine. For a team deploying monthly they are alarming, and for a team asking why users lose their place mid-session they are the whole signal. A library cannot know which team you are, so it does not decide. Filter them yourself with `ignoreErrors`, or better, classify them in `onEvent` so they are still counted.

Extension noise is matched against the stack rather than the message, because an injected script throws an ordinary-looking `TypeError` and the frame URL is the only thing that identifies it. Your own `ignoreErrors` patterns (substrings or regexes) are matched against both, so a noisy third-party widget can be silenced by its script URL.

## Privacy defaults

Capture is tiered, and the defaults sit at the safe end of each tier:

- Route changes and clicked elements: on, recorded as path patterns and CSS selectors, never text content
- Network breadcrumbs: on, as method plus origin and status. Opt in to full paths with `fetchFullPath`; query strings are stripped even then, because callback URLs carry live OAuth codes
- Console breadcrumbs: off until you opt in
- Input values: never captured, and there is no flag to change that

Hosts that want richer capture turn the dials up in one config object. The library ships the floor and your risk appetite sets the ceiling.

## Grouping

Every event carries a `fingerprint`, so `GROUP BY fingerprint` is your issue list. Two properties are enforced by tests:

- **Stable across deploys.** The key is built from resolved original paths and lines, never from generated chunk names, so a rebuild does not split an issue in two. Variable parts of the message (ids, numbers, quoted strings, URLs) are templated out, and `Failed to load user 8f3a` groups with `Failed to load user 22bc`.
- **Stable across engines.** Only the top application frame feeds the key. Deeper frames are framework internals, and the engines disagree about which of those exist: V8 reports a React handler frame that JSC elides. Including them would turn one bug into three issues.

Repeat suppression happens in the browser. A hot loop sends at most three reports per signature per page load, and the suppressed count rides along on the next flush, so a storm still reads as a storm.

## Status

v0.3.0 covers browser capture, stack parsing, the ingest pipeline, and the source map build step and resolver, with 141 unit tests and 33 end-to-end tests driving real Chromium, WebKit, and Firefox against a Next 16 Turbopack build. The stack parser's fixtures are captured from the engines themselves rather than written from memory, and the source map decoder is tested against real bundler output.

Watchfire's first production deployment is [Fieldwork](https://getfieldwork.ai), where it is being built.

Two things are out of scope for good: a hosted UI, and compatibility with the Sentry wire protocol. Either would make this a second service to run, which is the thing it exists to avoid.

## License

MIT
