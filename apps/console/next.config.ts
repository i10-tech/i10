import type { NextConfig } from "next"

const config: NextConfig = {
  // `standalone` traces the exact file set the server needs, so the runtime
  // image carries no node_modules tree and no workspace symlinks. Without it a
  // workspace monorepo's Next image either breaks on a dangling symlink or ships
  // the whole store.
  output: "standalone",
  // The trace root is the REPO, not the app. Left to default, Next traces from
  // the app directory and silently omits the workspace packages it imports.
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  transpilePackages: ["@repo/ui"],
  reactStrictMode: true,
  poweredByHeader: false,
}

export default config
