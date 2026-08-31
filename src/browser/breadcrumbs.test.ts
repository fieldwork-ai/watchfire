/**
 * What the buffer keeps when it cannot keep everything.
 *
 * The interesting behavior is entirely in the eviction rule, and it is not
 * FIFO. A polling app makes requests overwhelmingly the most common
 * breadcrumb, so plain FIFO discards the rarer clicks and navigations first —
 * exactly the ones that say what the person was doing. These tests pin the
 * balance, because a "simplification" back to `shift()` would pass every other
 * test in the suite.
 */
import { describe, expect, it } from "vitest";
import { BreadcrumbBuffer } from "./breadcrumbs.js";

function kindsIn(buffer: BreadcrumbBuffer): string[] {
  return buffer.snapshot().map((crumb) => crumb.kind);
}

describe("BreadcrumbBuffer", () => {
  it("keeps everything below the limit, oldest first", () => {
    const buffer = new BreadcrumbBuffer(5);
    buffer.add("click", "button#a");
    buffer.add("fetch", "GET /a");
    buffer.add("navigation", "/a -> /b");
    expect(buffer.snapshot().map((crumb) => crumb.message)).toEqual([
      "button#a",
      "GET /a",
      "/a -> /b",
    ]);
  });

  it("never exceeds the limit", () => {
    const buffer = new BreadcrumbBuffer(10);
    for (let i = 0; i < 500; i++) buffer.add("fetch", `GET /poll/${i}`);
    expect(buffer.snapshot()).toHaveLength(10);
  });

  it("evicts request chatter rather than the click that preceded it", () => {
    // The production shape: one deliberate action, then a flood of polling.
    const buffer = new BreadcrumbBuffer(10);
    buffer.add("click", "button#checkout");
    buffer.add("navigation", "/cart -> /checkout");
    for (let i = 0; i < 200; i++) buffer.add("fetch", `GET /poll/${i}`);

    const messages = buffer.snapshot().map((crumb) => crumb.message);
    expect(messages).toContain("button#checkout");
    expect(messages).toContain("/cart -> /checkout");
  });

  it("keeps the most recent entries within the evicted kind", () => {
    const buffer = new BreadcrumbBuffer(4);
    buffer.add("click", "button#a");
    for (let i = 0; i < 20; i++) buffer.add("fetch", `GET /poll/${i}`);

    const messages = buffer.snapshot().map((crumb) => crumb.message);
    expect(messages).toContain("GET /poll/19");
    expect(messages).not.toContain("GET /poll/0");
  });

  it("balances rather than starving whichever kind arrives last", () => {
    // A burst of one kind after the buffer is already full must not clear it.
    const buffer = new BreadcrumbBuffer(9);
    for (let i = 0; i < 50; i++) buffer.add("fetch", `GET /poll/${i}`);
    for (let i = 0; i < 50; i++) buffer.add("click", `button#${i}`);

    const kinds = kindsIn(buffer);
    expect(kinds.filter((kind) => kind === "fetch").length).toBeGreaterThan(0);
    expect(kinds.filter((kind) => kind === "click").length).toBeGreaterThan(0);
  });

  it("degrades to dropping the oldest when every entry is one kind", () => {
    const buffer = new BreadcrumbBuffer(3);
    for (const message of ["a", "b", "c", "d"]) buffer.add("fetch", message);
    expect(buffer.snapshot().map((crumb) => crumb.message)).toEqual(["b", "c", "d"]);
  });

  it("reports ages relative to the snapshot, not wall-clock time", () => {
    const buffer = new BreadcrumbBuffer(3);
    buffer.add("click", "button#a");
    for (const crumb of buffer.snapshot()) {
      expect(crumb.ageMs).toBeGreaterThanOrEqual(0);
    }
  });
});
