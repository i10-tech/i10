import type { NextConfig } from "next"

const config: NextConfig = {
  // See apps/console/next.config.ts — the same two settings, for the same two
  // reasons: `standalone` so the runtime image carries no workspace symlink tree,
  // and a REPO-rooted trace so the workspace packages it imports are traced at
  // all.
  output: "standalone",
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  transpilePackages: ["@repo/ui"],
  reactStrictMode: true,
  poweredByHeader: false,
}

export default config
