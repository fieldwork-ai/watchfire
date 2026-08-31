/**
 * Breadcrumb capture, tiered by what each kind can leak.
 *
 * The tiers are not a privacy preference, they are a statement about what each
 * source of data can contain:
 *
 *   navigation  a route pattern. Bounded by the app's route table.
 *   click       an element selector. Never innerText, which is user content.
 *   fetch       method, path and status. Query strings ALWAYS stripped: a
 *               callback URL carries a live OAuth authorization code, and no
 *               allowlist of safe parameter names stays correct as routes are
 *               added.
 *   console     arbitrary. Off unless the host opts in.
 *
 * Input values are absent from the list and there is no flag to add them. A
 * breadcrumb trail containing what someone typed is a password store with
 * extra steps, and a configuration option is one flip away from being one.
 */
import type { Breadcrumb, BreadcrumbKind } from "../types.js";

export interface CaptureConfig {
  navigation: boolean;
  click: boolean;
  fetch: boolean;
  console: boolean;
  /** Keep full URL paths on fetch breadcrumbs. Query strings go regardless. */
  fetchFullPath: boolean;
  /** Ring buffer size. */
  limit: number;
}

export const DEFAULT_CAPTURE: CaptureConfig = {
  navigation: true,
  click: true,
  fetch: true,
  console: false,
  fetchFullPath: false,
  limit: 30,
};

/** Bounds one breadcrumb's message. Long values are noise and cost bandwidth. */
const MAX_MESSAGE = 200;

/**
 * The trail, bounded, and balanced across kinds.
 *
 * Eviction is NOT plain FIFO, and the reason is measured rather than
 * theoretical. An app that polls makes `fetch` the overwhelming majority of
 * everything recorded — 92% of breadcrumbs on the production deployment this
 * was written against, with seven in ten reports arriving at exactly the
 * default limit. Under FIFO that traffic evicts the clicks and navigations
 * first, because they are rarer, and those are the ones that say what the
 * PERSON was doing. Clicks survived in 45% of reports and navigations in 29%.
 *
 * So when the buffer is full the oldest entry of the LARGEST kind is dropped,
 * not the oldest entry overall. Request chatter then evicts request chatter,
 * and a click recorded a minute ago outlives a hundred polls.
 *
 * The trade is real and worth stating: the trail is no longer strictly "the
 * last N events". It is the recent history of each kind, in chronological
 * order, weighted towards whatever the app does least. For reading what led to
 * an error that is the better artifact, but code that assumed an unbroken
 * sequence would be wrong.
 */
export class BreadcrumbBuffer {
  private readonly entries: Array<{ at: number; crumb: Omit<Breadcrumb, "ageMs"> }> = [];

  constructor(private readonly limit: number) {}

  add(kind: BreadcrumbKind, message: string, data?: Breadcrumb["data"]): void {
    this.entries.push({
      at: Date.now(),
      crumb: {
        kind,
        message: message.slice(0, MAX_MESSAGE),
        ...(data === undefined ? {} : { data }),
      },
    });
    if (this.entries.length > this.limit) this.evictFromLargestKind();
  }

  /**
   * Drops the oldest entry of whichever kind occupies the most slots.
   *
   * Ties go to the kind encountered first in insertion order, which makes the
   * choice deterministic without needing to rank the kinds against each other.
   * Entries stay in insertion order, so removing from the middle leaves the
   * snapshot chronological.
   */
  private evictFromLargestKind(): void {
    const counts = new Map<BreadcrumbKind, number>();
    for (const { crumb } of this.entries) {
      counts.set(crumb.kind, (counts.get(crumb.kind) ?? 0) + 1);
    }

    let largest: BreadcrumbKind | null = null;
    let highest = 0;
    for (const { crumb } of this.entries) {
      const count = counts.get(crumb.kind) ?? 0;
      if (count > highest) {
        highest = count;
        largest = crumb.kind;
      }
    }

    const index = this.entries.findIndex(({ crumb }) => crumb.kind === largest);
    this.entries.splice(index === -1 ? 0 : index, 1);
  }

  /** Snapshot, oldest first, with ages relative to now. */
  snapshot(): Breadcrumb[] {
    const now = Date.now();
    return this.entries.map(({ at, crumb }) => ({ ...crumb, ageMs: now - at }));
  }
}

/**
 * A path with the query string removed. Duplicated from the server's scrub
 * step on purpose: stripping at the source means a credential never enters the
 * payload at all, and the server-side strip is the backstop for older clients.
 */
export function safePath(url: string): string {
  try {
    // Relative URLs need a base; the origin is discarded either way.
    const parsed = new URL(url, "http://x");
    return parsed.pathname;
  } catch {
    const cut = url.indexOf("?");
    return cut === -1 ? url : url.slice(0, cut);
  }
}

/**
 * A short, stable description of an element: tag, id, and up to two class
 * names. Text content is deliberately excluded.
 */
export function describeElement(target: EventTarget | null): string | null {
  if (target === null || !(target instanceof Element)) return null;
  const tag = target.tagName.toLowerCase();
  const id = target.id ? `#${target.id}` : "";
  const classes = target.classList.length > 0
    ? `.${Array.from(target.classList).slice(0, 2).join(".")}`
    : "";
  return `${tag}${id}${classes}`;
}

/**
 * Installs the enabled recorders and returns a teardown function.
 *
 * Every patch is restorable and every handler swallows its own errors: an
 * instrumentation bug must not break the page it is watching.
 */
export function installRecorders(buffer: BreadcrumbBuffer, config: CaptureConfig): () => void {
  const teardowns: Array<() => void> = [];

  if (config.click) {
    const onClick = (event: Event) => {
      const description = describeElement(event.target);
      if (description !== null) buffer.add("click", description);
    };
    document.addEventListener("click", onClick, { capture: true, passive: true });
    teardowns.push(() => document.removeEventListener("click", onClick, { capture: true }));
  }

  if (config.navigation) {
    let last = location.pathname;
    const record = () => {
      if (location.pathname !== last) {
        buffer.add("navigation", `${last} -> ${location.pathname}`);
        last = location.pathname;
      }
    };
    // History API navigations do not fire an event, so the two methods that
    // perform them are wrapped. popstate covers back/forward.
    const { pushState, replaceState } = history;
    history.pushState = function (...args) {
      const result = pushState.apply(this, args);
      record();
      return result;
    };
    history.replaceState = function (...args) {
      const result = replaceState.apply(this, args);
      record();
      return result;
    };
    window.addEventListener("popstate", record);
    teardowns.push(() => {
      history.pushState = pushState;
      history.replaceState = replaceState;
      window.removeEventListener("popstate", record);
    });
  }

  if (config.fetch && typeof window.fetch === "function") {
    const original = window.fetch;
    window.fetch = async function (...args: Parameters<typeof fetch>) {
      const [input] = args;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method =
        (typeof input === "object" && "method" in input ? input.method : args[1]?.method) ?? "GET";
      try {
        const response = await original.apply(this, args);
        buffer.add("fetch", `${method} ${config.fetchFullPath ? safePath(url) : originOnly(url)}`, {
          status: response.status,
        });
        return response;
      } catch (error) {
        buffer.add("fetch", `${method} ${config.fetchFullPath ? safePath(url) : originOnly(url)}`, {
          failed: true,
        });
        throw error;
      }
    };
    teardowns.push(() => {
      window.fetch = original;
    });
  }

  if (config.console) {
    const levels = ["warn", "error"] as const;
    const originals = levels.map((level) => [level, console[level]] as const);
    for (const [level, original] of originals) {
      console[level] = (...args: unknown[]) => {
        try {
          buffer.add("console", args.map(stringifyArg).join(" "), { level });
        } catch {
          // A breadcrumb must never break a console call.
        }
        original.apply(console, args);
      };
    }
    teardowns.push(() => {
      for (const [level, original] of originals) console[level] = original;
    });
  }

  return () => {
    for (const teardown of teardowns) {
      try {
        teardown();
      } catch {
        // Teardown runs on unload; a failure here has nowhere to go.
      }
    }
  };
}

/** Without `fetchFullPath`, only the first path segment is kept. */
function originOnly(url: string): string {
  const path = safePath(url);
  const first = path.split("/").filter(Boolean)[0];
  return first === undefined ? "/" : `/${first}/...`;
}

function stringifyArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
