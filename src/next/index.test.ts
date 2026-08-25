import { describe, it, expect, afterEach } from "vitest";
import { withWatchfire } from "./index.js";

afterEach(() => {
  delete process.env.NEXT_PUBLIC_RELEASE;
});

describe("withWatchfire", () => {
  it("enables source maps and wires the release into the build id", async () => {
    const config = withWatchfire({ reactStrictMode: true }, { release: "20260825-1" });

    expect(config.productionBrowserSourceMaps).toBe(true);
    expect(config.reactStrictMode).toBe(true);
    expect(await config.generateBuildId?.()).toBe("20260825-1");
  });

  it("defaults the release from NEXT_PUBLIC_RELEASE", async () => {
    process.env.NEXT_PUBLIC_RELEASE = "env-release";
    const config = withWatchfire({});
    expect(await config.generateBuildId?.()).toBe("env-release");
  });

  it("returns null with no release, so local dev keeps Next's generated id", async () => {
    const config = withWatchfire({});
    expect(await config.generateBuildId?.()).toBeNull();
  });

  it("treats an empty release as absent", async () => {
    const config = withWatchfire({}, { release: "" });
    expect(await config.generateBuildId?.()).toBeNull();
  });

  it("never replaces a generateBuildId the host defines", async () => {
    const own = () => "host-id";
    const config = withWatchfire({ generateBuildId: own }, { release: "ignored" });
    expect(config.generateBuildId).toBe(own);
    expect(await config.generateBuildId?.()).toBe("host-id");
  });

  it("passes unrelated config through untouched", () => {
    const headers = async () => [];
    const config = withWatchfire({ headers, images: { unoptimized: true } });
    expect(config.headers).toBe(headers);
    expect(config.images).toEqual({ unoptimized: true });
  });
});
