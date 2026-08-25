/**
 * Where a release's source maps live.
 *
 * Two implementations ship. The filesystem store reads the maps the build step
 * placed inside the server output, and is the whole story for a single-release
 * lookup: a running server always has its own maps on disk. A shared store
 * (S3 or anything with the same two methods) exists only so that a server can
 * resolve stacks from OTHER releases, which is what a browser sitting on a
 * stale bundle produces after a deploy.
 *
 * The interface is deliberately two methods. Anything with get and put can be
 * a store, which keeps R2, GCS, a database blob column and a test double all
 * first-class without an adapter package each.
 */

export interface MapStore {
  /** Returns the raw `.map` JSON, or null when this release/file is unknown. */
  get(release: string, file: string): Promise<string | null>;
  /** Writes a map. Implementations should be idempotent. */
  put(release: string, file: string, contents: string): Promise<void>;
  /** Names the maps already stored for a release, for push-if-absent on boot. */
  list(release: string): Promise<string[]>;
}

/**
 * Reads and writes under a directory. Used for the maps baked into the server
 * output, and as the zero-infrastructure option for a shared volume.
 */
export function filesystemStore(rootDir: string): MapStore {
  const load = async () => {
    const [fs, path] = await Promise.all([import("node:fs/promises"), import("node:path")]);
    return { fs, path };
  };

  // A release id reaches this from the client payload, so it must never be
  // able to climb out of the root. Anything but a plain segment is refused.
  const safe = (segment: string): string => segment.replace(/[^A-Za-z0-9._-]/g, "_");

  return {
    async get(release, file) {
      const { fs, path } = await load();
      try {
        return await fs.readFile(path.join(rootDir, safe(release), safe(file)), "utf8");
      } catch {
        return null;
      }
    },
    async put(release, file, contents) {
      const { fs, path } = await load();
      const dir = path.join(rootDir, safe(release));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, safe(file)), contents, "utf8");
    },
    async list(release) {
      const { fs, path } = await load();
      try {
        return await fs.readdir(path.join(rootDir, safe(release)));
      } catch {
        return [];
      }
    },
  };
}

export interface S3StoreOptions {
  bucket: string;
  /** Key prefix. Defaults to "watchfire-maps". */
  prefix?: string;
  /**
   * An `@aws-sdk/client-s3` S3Client. Passed in rather than constructed so the
   * library never owns credential resolution or the region, and so the SDK
   * stays an optional peer dependency for hosts that use a different store.
   *
   * `any` is deliberate at this boundary and cannot be tightened. `S3Client.send`
   * is a set of overloads over the SDK's own union of command types, so a
   * narrower signature here (`(command: unknown) => Promise<unknown>`) is not
   * assignable FROM the real client: parameters are contravariant, and a
   * function accepting specific commands cannot stand in for one accepting
   * anything. Typing it properly would mean importing the SDK, which is exactly
   * what keeping it an optional peer forbids. Every value read back out of
   * these calls is narrowed before use.
   */
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  client: { send: (command: any) => Promise<any> };
  /** The three command constructors from `@aws-sdk/client-s3`. See above. */
  /* eslint-disable @typescript-eslint/no-explicit-any */
  commands: {
    GetObjectCommand: new (input: any) => any;
    PutObjectCommand: new (input: any) => any;
    ListObjectsV2Command: new (input: any) => any;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * S3-compatible store. Works against MinIO and R2 unchanged, since it uses
 * only Get, Put and ListObjectsV2.
 */
export function s3Store(options: S3StoreOptions): MapStore {
  const prefix = (options.prefix ?? "watchfire-maps").replace(/\/$/, "");
  const key = (release: string, file: string) => `${prefix}/${release}/${file}`;
  const { client, commands } = options;

  return {
    async get(release, file) {
      try {
        const response = (await client.send(
          new commands.GetObjectCommand({ Bucket: options.bucket, Key: key(release, file) }),
        )) as { Body?: { transformToString?: () => Promise<string> } };
        const body = response.Body;
        if (!body?.transformToString) return null;
        return await body.transformToString();
      } catch {
        // A missing key is the common case, not an error worth propagating:
        // an unresolvable frame degrades, it does not fail the report.
        return null;
      }
    },
    async put(release, file, contents) {
      await client.send(
        new commands.PutObjectCommand({
          Bucket: options.bucket,
          Key: key(release, file),
          Body: contents,
          ContentType: "application/json",
        }),
      );
    },
    async list(release) {
      const response = (await client.send(
        new commands.ListObjectsV2Command({
          Bucket: options.bucket,
          Prefix: `${prefix}/${release}/`,
        }),
      )) as { Contents?: Array<{ Key?: string }> };
      return (response.Contents ?? [])
        .map((object) => object.Key?.split("/").pop())
        .filter((name): name is string => typeof name === "string" && name.length > 0);
    },
  };
}

/**
 * Reads from the first store that has the map, writes to the last.
 *
 * This is the shape every real deployment wants: local disk answers for the
 * running release with no network call, the shared store answers for stale
 * releases, and boot registration pushes to the shared store only.
 */
export function layeredStore(local: MapStore, shared: MapStore): MapStore {
  return {
    async get(release, file) {
      return (await local.get(release, file)) ?? (await shared.get(release, file));
    },
    put: (release, file, contents) => shared.put(release, file, contents),
    list: (release) => shared.list(release),
  };
}
