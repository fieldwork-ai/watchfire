/**
 * End-to-end: a real error in a real browser, through a real Next.js build,
 * arriving at the server resolved to original source.
 *
 * These run on Chromium, WebKit and Firefox. Everything asserted here must
 * hold identically on all three, because a fingerprint that varies by engine
 * turns one bug into three issues.
 */
import { expect, test, type Page } from "@playwright/test";
import type { WatchfireEvent } from "watchfire/ingest";

/**
 * The fingerprint every engine must produce for the fixture's `#throw` error.
 * Derived from the top in-app frame (src/broken.ts:10), the error kind and the
 * normalized message, none of which vary by browser.
 */
const EXPECTED_FINGERPRINT = "10c19b7e9f41f759";

/** Clears the server's record, so each test reads only its own events. */
async function reset(page: Page): Promise<void> {
  const response = await page.request.delete("/api/received");
  expect(response.status()).toBe(204);
}

/** Polls until the server has recorded at least `count` events. */
async function received(page: Page, count = 1): Promise<WatchfireEvent[]> {
  let events: WatchfireEvent[] = [];
  await expect
    .poll(
      async () => {
        events = await (await page.request.get("/api/received")).json();
        return events.length;
      },
      { timeout: 15_000, message: `waiting for ${count} event(s)` },
    )
    .toBeGreaterThanOrEqual(count);
  return events;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await reset(page);
});

test("an uncaught error reaches the server", async ({ page }) => {
  await page.click("#throw");
  const [event] = await received(page);

  expect(event?.message).toContain("watchfire e2e failure");
  expect(event?.kind).toBe("error");
  expect(event?.path).toBe("/");
  expect(event?.release).toBe("e2e-release");
  expect(event?.fingerprint).toHaveLength(16);
  expect(event?.reportId).toBeTruthy();
});

test("the stack resolves back to original TypeScript source", async ({ page }) => {
  // The single most valuable thing the library does, and the hardest to fake:
  // the browser only ever saw minified chunk names like `3rf7vuwqjn2o9.js`.
  await page.click("#throw");
  const [event] = await received(page);

  const resolved = event?.frames.filter((frame) => frame.resolved) ?? [];
  expect(resolved.length).toBeGreaterThan(0);

  const top = resolved[0];
  expect(top?.file).toBe("e2e/fixture-next/src/broken.ts");
  // The line `innerFailure` throws on. Asserted exactly, because an off-by-one
  // in the VLQ decoder is the failure mode that still looks plausible.
  expect(top?.line).toBe(10);

  // The generated chunk is gone from the resolved frame entirely, and so is
  // the bundler's `[project]/` prefix.
  expect(top?.file).not.toContain("chunks/");
  expect(top?.file).not.toContain("[project]");
  expect(top?.file).not.toMatch(/\.js$/);
});

test("application frames are separable from dependency frames", async ({ page }) => {
  // Deliberately not asserting a full innerFailure -> middleLayer ->
  // triggerError chain, nor the presence of the calling component: a
  // production build inlines the first, and the engines disagree about the
  // second (V8 reports the React onClick frame, JSC elides it). Both would be
  // testing the bundler and the engine rather than this library, and the
  // second is exactly why the fingerprint uses only the top in-app frame.
  await page.click("#throw");
  const [event] = await received(page);

  const resolved = (event?.frames ?? []).filter((frame) => frame.resolved);
  const app = resolved.filter((frame) => !frame.file.includes("node_modules"));
  const deps = resolved.filter((frame) => frame.file.includes("node_modules"));

  // The application's own code is at the top, where a reader looks first.
  expect(app[0]?.file).toBe("e2e/fixture-next/src/broken.ts");
  // And the framework's internals resolved too, rather than being dropped.
  expect(deps.length).toBeGreaterThan(0);
});

test("the same error fingerprints identically across engines", async ({ page }, testInfo) => {
  // The property that decides whether one bug is one issue or three. It is
  // asserted against a value committed to the repo rather than compared
  // between projects at runtime, because Playwright runs each project in its
  // own worker with no shared state, and a test that silently passes when the
  // other engines did not run would be worse than no test.
  //
  // Regenerate with `pnpm e2e:fingerprint` if the fixture's throw site moves.
  await page.click("#throw");
  const [event] = await received(page);

  expect(
    event?.fingerprint,
    `${testInfo.project.name} disagreed on the fingerprint; deep frames vary by engine, ` +
      `so only the top in-app frame may feed the key`,
  ).toBe(EXPECTED_FINGERPRINT);
});

test("an unhandled promise rejection is captured", async ({ page }) => {
  await page.click("#reject");
  const [event] = await received(page);

  expect(event?.kind).toBe("unhandledrejection");
  expect(event?.message).toContain("watchfire e2e rejection");
});

test("breadcrumbs record the click that preceded the error", async ({ page }) => {
  await page.click("#throw");
  const [event] = await received(page);

  const clicks = (event?.breadcrumbs ?? []).filter((crumb) => crumb.kind === "click");
  expect(clicks.length).toBeGreaterThan(0);
  expect(clicks.at(-1)?.message).toContain("button#throw");
});

test("breadcrumbs never carry element text content", async ({ page }) => {
  await page.click("#throw");
  const [event] = await received(page);

  // The button's visible label must not appear: selectors only, never text.
  const serialized = JSON.stringify(event?.breadcrumbs ?? []);
  expect(serialized).not.toContain(">throw<");
});

test("a hot loop is suppressed rather than sending fifty reports", async ({ page }) => {
  await page.click("#loop");
  await received(page, 1);
  await page.waitForTimeout(1000);
  const settled: WatchfireEvent[] = await (await page.request.get("/api/received")).json();

  // Fifty throws, at most three sends.
  expect(settled.length).toBeGreaterThan(0);
  expect(settled.length).toBeLessThanOrEqual(3);

  // And the discarded ones are COUNTED, not lost. Before this was attached at
  // flush time, the count could only ride along on the next report of the same
  // signature — so a loop that fires and stops, which is the usual shape,
  // reported three errors and silently dropped the other forty-seven.
  const counted = settled.reduce((total, event) => total + event.suppressed, 0);
  expect(counted).toBeGreaterThan(0);
});

test("known-noise errors are dropped client-side", async ({ page }) => {
  await page.click("#ignored");
  await page.waitForTimeout(1000);
  const events: WatchfireEvent[] = await (await page.request.get("/api/received")).json();
  expect(events).toEqual([]);
});

test("source maps are not publicly served", async ({ page }) => {
  // The build step moved them; this proves it from the outside, over HTTP,
  // which is the only view that matters. A 200 here is a source-code leak.
  const scripts = await page.evaluate(() =>
    Array.from(document.querySelectorAll("script[src]")).map((s) => (s as HTMLScriptElement).src),
  );
  expect(scripts.length).toBeGreaterThan(0);

  for (const src of scripts) {
    const response = await page.request.get(`${src}.map`);
    expect(response.status(), `${src}.map must not be served`).toBe(404);
  }
});

test("chunks carry no sourceMappingURL pointer", async ({ page }) => {
  const scripts = await page.evaluate(() =>
    Array.from(document.querySelectorAll("script[src]")).map((s) => (s as HTMLScriptElement).src),
  );
  for (const src of scripts) {
    const body = await (await page.request.get(src)).text();
    expect(body, `${src} still points at a map`).not.toContain("sourceMappingURL");
  }
});
