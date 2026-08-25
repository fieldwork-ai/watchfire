import { defineConfig, devices } from "@playwright/test";

/**
 * The engine matrix is the point of this suite.
 *
 * `error.stack` is not standardized, and the three engines disagree on the
 * header line, the frame separator, how anonymous frames are written and how
 * closures are named. Unit tests run against captured fixtures; these specs
 * run against the live engines, so a browser update that changes the format
 * fails here rather than silently degrading every customer's stack traces.
 */
export default defineConfig({
  testDir: "./e2e/specs",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://127.0.0.1:3111",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: {
    // Serves the standalone output, so the specs exercise the same artifact a
    // deploy would ship, including the private maps directory the build moved.
    // Next nests standalone output by workspace path, so server.js is not at
    // the standalone root here. Running from its own directory is also what a
    // deploy does, and is what puts the maps at process.cwd().
    command: "node server.js",
    cwd: "./e2e/fixture-next/.next/standalone/e2e/fixture-next",
    port: 3111,
    reuseExistingServer: !process.env.CI,
    env: { PORT: "3111", HOSTNAME: "127.0.0.1" },
    stdout: "pipe",
  },
});
