import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // Without this Next emits no browser maps at all, and `watchfire maps` has
  // nothing to move. The fixture exists partly to prove this is the only
  // configuration change adopting the library requires.
  productionBrowserSourceMaps: true,
};

export default config;
