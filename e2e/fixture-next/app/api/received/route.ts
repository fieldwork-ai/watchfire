/** Test-only read-back of what the ingest route received. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

const RECEIVED = join(process.cwd(), "received.jsonl");

export async function GET() {
  try {
    const raw = await readFile(RECEIVED, "utf8");
    return Response.json(raw.split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  } catch {
    return Response.json([]);
  }
}

export async function DELETE() {
  await writeFile(RECEIVED, "", "utf8");
  return new Response(null, { status: 204 });
}
