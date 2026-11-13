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
  // The fonts our own email templates load (apps/api/src/templates/shared.ts).
  // A font is only applied across origins when the response allows it, and a
  // mail client is always another origin, so without this header the files
  // would download and then be thrown away. They are public open-licence fonts
  // with fixed names, hence the open origin and the long cache.
  async headers() {
    return [
      {
        source: "/email/fonts/:file",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ]
  },
}

export default config
