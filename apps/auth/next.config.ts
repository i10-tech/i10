import type { NextConfig } from "next"

const config: NextConfig = {
  // See apps/console/next.config.ts - the same two settings, for the same two
  // reasons: `standalone` so the runtime image carries no workspace symlink tree,
  // and a REPO-rooted trace so the workspace packages it imports are traced at
  // all.
  output: "standalone",
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  transpilePackages: ["@repo/ui"],
  reactStrictMode: true,
  poweredByHeader: false,
  /*
   * ⚠ THE SETUP-LINK PAGE (#340) CARRIES A CREDENTIAL IN ITS ADDRESS, so it is
   * sent with no `Referer` to anything it loads or links to, and is never
   * cached or stored. The page also moves the token out of the URL at once
   * (app/sso/setup/token.ts); these headers cover the request that brought it.
   */
  async headers() {
    return [
      {
        source: "/sso/setup/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ]
  },
}

export default config
