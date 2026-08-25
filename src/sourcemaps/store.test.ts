import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesystemStore, layeredStore, type MapStore } from "./store.js";
import { registerMaps } from "./register.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "watchfire-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** An in-memory store, standing in for S3 in the registration tests. */
function memoryStore(): MapStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (release, file) => data.get(`${release}/${file}`) ?? null,
    put: async (release, file, contents) => {
      data.set(`${release}/${file}`, contents);
    },
    list: async (release) =>
      [...data.keys()]
        .filter((key) => key.startsWith(`${release}/`))
        .map((key) => key.slice(release.length + 1)),
  };
}

describe("filesystemStore", () => {
  it("round-trips a map", async () => {
    const store = filesystemStore(root);
    await store.put("rel-1", "a.js.map", '{"version":3}');
    expect(await store.get("rel-1", "a.js.map")).toBe('{"version":3}');
  });

  it("returns null for an unknown release or file", async () => {
    const store = filesystemStore(root);
    expect(await store.get("nope", "a.js.map")).toBeNull();
    expect(await store.list("nope")).toEqual([]);
  });

  it("lists what a release holds", async () => {
    const store = filesystemStore(root);
    await store.put("rel-1", "a.js.map", "{}");
    await store.put("rel-1", "b.js.map", "{}");
    expect((await store.list("rel-1")).sort()).toEqual(["a.js.map", "b.js.map"]);
  });

  it("refuses to escape the root via a traversing release id", async () => {
    // A release id reaches this straight from a client payload, so path
    // traversal here would be an arbitrary-file read.
    const store = filesystemStore(join(root, "maps"));
    await writeFile(join(root, "secret.txt"), "classified");
    expect(await store.get("../..", "secret.txt")).toBeNull();
    expect(await store.get("..%2f..", "secret.txt")).toBeNull();
  });

  it("refuses to escape the root via a traversing file name", async () => {
    const store = filesystemStore(join(root, "maps"));
    await writeFile(join(root, "secret.txt"), "classified");
    expect(await store.get("rel-1", "../../secret.txt")).toBeNull();
  });
});

describe("layeredStore", () => {
  it("prefers the local store", async () => {
    const local = memoryStore();
    const shared = memoryStore();
    await local.put("rel-1", "a.js.map", "local");
    await shared.put("rel-1", "a.js.map", "shared");
    expect(await layeredStore(local, shared).get("rel-1", "a.js.map")).toBe("local");
  });

  it("falls back to the shared store for another release", async () => {
    const local = memoryStore();
    const shared = memoryStore();
    await shared.put("rel-0", "a.js.map", "older release");
    // This is the stale-bundle case: a browser still on the previous deploy.
    expect(await layeredStore(local, shared).get("rel-0", "a.js.map")).toBe("older release");
  });

  it("writes only to the shared store", async () => {
    const local = memoryStore();
    const shared = memoryStore();
    await layeredStore(local, shared).put("rel-1", "a.js.map", "x");
    expect(local.data.size).toBe(0);
    expect(shared.data.size).toBe(1);
  });
});

describe("registerMaps", () => {
  async function localMaps(names: string[]): Promise<string> {
    const dir = join(root, "maps");
    await mkdir(dir, { recursive: true });
    for (const name of names) await writeFile(join(dir, name), `{"name":"${name}"}`);
    return dir;
  }

  it("pushes local maps that the shared store lacks", async () => {
    const store = memoryStore();
    const localDir = await localMaps(["a.js.map", "b.js.map"]);
    await registerMaps({ release: "rel-1", localDir, store });
    expect((await store.list("rel-1")).sort()).toEqual(["a.js.map", "b.js.map"]);
  });

  it("skips maps already present, so a restart is cheap", async () => {
    const store = memoryStore();
    const put = vi.spyOn(store, "put");
    const localDir = await localMaps(["a.js.map"]);
    await registerMaps({ release: "rel-1", localDir, store });
    put.mockClear();
    await registerMaps({ release: "rel-1", localDir, store });
    expect(put).not.toHaveBeenCalled();
  });

  it("is a no-op with no shared store configured", async () => {
    const localDir = await localMaps(["a.js.map"]);
    await expect(registerMaps({ release: "rel-1", localDir, store: null })).resolves.toBeUndefined();
  });

  it("stays silent when there are no local maps", async () => {
    // A dev server or a build that skipped the maps step. Normal, not an error.
    const logs: string[] = [];
    await registerMaps({
      release: "rel-1", localDir: join(root, "absent"), store: memoryStore(),
      onLog: (m) => logs.push(m),
    });
    expect(logs).toEqual([]);
  });

  it("ignores non-map files in the directory", async () => {
    const store = memoryStore();
    const dir = await localMaps(["a.js.map"]);
    await writeFile(join(dir, "README.txt"), "not a map");
    await registerMaps({ release: "rel-1", localDir: dir, store });
    expect(await store.list("rel-1")).toEqual(["a.js.map"]);
  });

  it("carries on after one map fails to upload", async () => {
    // A partial registration still resolves most frames, and the next boot
    // retries the gaps. Abandoning the batch would resolve none.
    const store = memoryStore();
    let calls = 0;
    store.put = async (release, file, contents) => {
      calls++;
      if (file === "b.js.map") throw new Error("upload failed");
      memoryStore().data.set(`${release}/${file}`, contents);
    };
    const localDir = await localMaps(["a.js.map", "b.js.map", "c.js.map"]);
    const logs: string[] = [];
    await registerMaps({ release: "rel-1", localDir, store, onLog: (m) => logs.push(m) });
    expect(calls).toBe(3);
    expect(logs.join(" ")).toContain("failed to register b.js.map");
  });

  it("never throws when the store is entirely broken", async () => {
    // Registration runs unawaited at boot; an unhandled rejection there would
    // crash the server it was meant to instrument.
    const broken: MapStore = {
      get: async () => null,
      put: async () => { throw new Error("down"); },
      list: async () => { throw new Error("down"); },
    };
    const localDir = await localMaps(["a.js.map"]);
    await expect(
      registerMaps({ release: "rel-1", localDir, store: broken }),
    ).resolves.toBeUndefined();
  });
});
