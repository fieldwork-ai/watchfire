# Watchfire

Self-hosted error tracking for Next.js. A library, not a service.

Watchfire catches JavaScript errors in your users' browsers, translates the minified stack traces back to your original source, groups repeats into single issues, and hands each event to a callback in your own code. Your source maps stay private on your own infrastructure. There is no vendor, no dashboard to deploy, and no second service to operate: errors land in whatever database, log stream, or Slack channel you already have.

## Why

Error tracking today means choosing between two heavy options. Send your stack traces and user context to a third party, and you have acquired a subprocessor, a DPA, and a per-event bill. Self-host a platform instead, and you are operating Kafka, ClickHouse, Redis, and Postgres to store what is, for most teams, a few dozen events a day.

Watchfire takes a third position: the only genuinely hard part of error tracking is turning `chunk-4f2a.js:1:88213` back into `checkout.ts:214` without publishing your source maps to the world. That is a library problem, not a service problem. Everything else (storage and alerting) your stack already does better than a bundled UI would, because it is wired into the tools you actually watch.

What you give up is real: no hosted UI, no issue-assignment workflow, no release-health graphs. What you get is that error data never leaves your infrastructure, which for many teams ends the compliance conversation before it starts.

## How it works

```
browser error ──POST──▶ /api/errors (a route in your app)
                              │
                              ▼
                validate → rate-limit → scrub → parse → resolve → fingerprint
                              │
                              ▼
                        onEvent(event)  ← your code: a DB insert, a log line
```

One npm package, four subpath exports:

| Import | What it does |
| --- | --- |
| `watchfire/browser` | ~3 kB client script: `window.onerror`, unhandled rejections, breadcrumbs, batching, per-session dedupe |
| `watchfire/ingest` | The route handler: a web-standard `(Request) => Response` function |
| `watchfire/stack` | Stack-trace parsing (Chrome, Safari, Firefox formats) and stable fingerprinting |
| `watchfire/sourcemaps` | The build command and the runtime resolver |

The handler is a plain fetch-style function, so it drops into a Next.js route handler unchanged. Hono, Bun, and Express (via a small adapter) follow later; the v0.1 build tooling targets Next.js only.

## The source map story

`watchfire maps` runs as one extra step in your build script:

```json
"build": "next build && watchfire maps"
```

It moves the generated `.map` files out of the public static directory into a private folder inside your server output, strips the public pointers from the chunks, and verifies nothing minified-to-source remains fetchable. No uploads during the build, no credentials in CI.

At runtime, resolution reads those maps from local disk, which always matches the version the server is running. Configure a shared store (S3-compatible, or a filesystem path) and each server registers its own maps on startup, so errors from browsers still running last week's bundle resolve too. Skip the store and those stale-bundle errors degrade to function names rather than exact lines. Nothing breaks either way.

## Privacy defaults

Capture is tiered, and the defaults are the safe end of each tier:

- Route changes and clicked elements: on, recorded as patterns and selectors, never text content
- Network breadcrumbs: on, as method + path + status; query strings are always stripped, because callback URLs carry live OAuth codes
- Console breadcrumbs: off until you opt in
- Input values: never captured, and there is no configuration flag to change that

Hosts that want richer capture turn the dials up in one config object. The library ships the floor; your risk appetite sets the ceiling.

## Status

Under active development; v0.0.1 on npm is a name-holding stub. The v0.1.0 milestone is: browser capture, ingest pipeline, source map build step and resolver, and an end-to-end test suite that runs real Chromium, WebKit, and Firefox against a fixture Next.js app. Watchfire's first production deployment will be [Fieldwork](https://getfieldwork.ai), where it is being built.

## License

MIT
