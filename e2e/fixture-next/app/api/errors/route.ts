/**
 * The fixture's ingest route. This is the whole server-side integration a host
 * writes, which is the point: if it needs more than this, the library's
 * interface is wrong.
 *
 * Events are appended to a file so the Playwright specs can read what the
 * server actually received. A real host would insert a row and log a line.
 */
import { createIngestHandler, filesystemStore, defaultMapsDir } from "watchfire/ingest";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const RECEIVED = join(process.cwd(), "received.jsonl");

const handler = createIngestHandler({
  maps: filesystemStore(defaultMapsDir()),
  onEvent: async (event) => {
    await appendFile(RECEIVED, `${JSON.stringify(event)}\n`, "utf8");
  },
  onLog: (message, error) => {
    console.error("[watchfire]", message, error);
  },
});

export const POST = handler;
export const dynamic = "force-dynamic";
