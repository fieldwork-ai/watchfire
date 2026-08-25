#!/usr/bin/env node
/**
 * The `watchfire` command. One subcommand today.
 */
import { runMaps } from "./maps.js";

const USAGE = `watchfire - self-hosted error tracking for Next.js

Usage:
  watchfire maps [options]     Move source maps out of the public output

Options:
  --release <id>   Build identifier (default: .next/BUILD_ID)
  --dir <path>     Project root containing .next (default: cwd)
  --dry-run        Report what would happen, change nothing
  -h, --help       Show this message

Add to your build script:
  "build": "next build && watchfire maps"
`;

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(USAGE);
    return;
  }

  if (command !== "maps") {
    process.stderr.write(`watchfire: unknown command "${command}"\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  await runMaps({
    dir: flag(argv, "dir") ?? process.cwd(),
    release: flag(argv, "release"),
    dryRun: argv.includes("--dry-run"),
    log: (message) => process.stdout.write(`${message}\n`),
  });
}

main().catch((error: unknown) => {
  // A build step that fails must fail the build: a silently skipped maps step
  // publishes source maps, which is the failure this command exists to prevent.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
