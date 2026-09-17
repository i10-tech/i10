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

  /*
   * Security headers for every response.
   *
   * ⚠ THE CONSOLE IS THE HIGHEST-VALUE PAGE IN THE PRODUCT — it mints API keys,
   * changes plans and removes sending domains — so the cheapest protections
   * belong on it whether or not anything is known to be wrong today.
   *
   * ⚠ AND THE CSP IS DELIBERATELY A SUBSET WITH NO `script-src`. A strict
   * script policy on Next's App Router needs a per-request nonce threaded
   * through the middleware, and a wrong one does not degrade — it blanks the
   * page. These four directives cannot break a page that works: they constrain
   * where a document may be FRAMED, what a `<base>` may rewrite, where a form
   * may post, and whether plugins may load. Adding `script-src` with a nonce is
   * the follow-up, written up in docs/decisions/console.md §7.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              // ⚠ CLICKJACKING. Without this, any site can put the console in an
              // invisible iframe over its own buttons and have somebody click
              // "Delete domain" while they think they are dismissing a cookie
              // banner. There is no legitimate embedder.
              "frame-ancestors 'none'",
              // ⚠ A `<base>` TAG INJECTED ANYWHERE REWRITES EVERY RELATIVE URL
              // ON THE PAGE, including the ones server actions post to.
              "base-uri 'self'",
              /*
               * ⚠ NO FORM MAY POST OFF-ORIGIN. Every mutation here is a server
               * action against this origin; anything else is exfiltration.
               *
               * ⚠ THIS IS THE ONE DIRECTIVE THAT COULD BREAK A PAGE, AND THE
               * PAGES TO WATCH ARE `/account` AND `/settings/team`. They embed
               * Clerk's `<UserProfile>` and `<OrganizationProfile>`, which talk
               * to Clerk's Frontend API with `fetch` — and `form-action` governs
               * native form SUBMISSION, not `fetch`, so it should not apply.
               * That reasoning cannot be confirmed without a live Clerk
               * instance, which preview mode deliberately does not have. If
               * either page ever reports a blocked submission in the browser
               * console, this line is the cause and the fix is to add Clerk's
               * frontend origin here rather than to drop the directive.
               */
              "form-action 'self'",
              "object-src 'none'",
            ].join("; "),
          },
          // ⚠ THE SAME CLICKJACKING RULE FOR ANYTHING THAT DOES NOT IMPLEMENT
          // `frame-ancestors`. Both, because "old browser" is not a threat model
          // we get to choose.
          { key: "X-Frame-Options", value: "DENY" },
          // ⚠ WITHOUT THIS, A BROWSER MAY SNIFF A JSON RESPONSE AS HTML and run
          // script it finds inside customer-controlled values.
          { key: "X-Content-Type-Options", value: "nosniff" },
          // ⚠ PATHS HERE CARRY IDS — a domain id, a message id — and a full
          // Referer would hand them to every third-party URL somebody follows.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // ⚠ NOTHING ON THIS SURFACE NEEDS A CAMERA, A MICROPHONE OR A
          // LOCATION, so nothing embedded in it should be able to ask.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
        ],
      },
    ]
  },
}

export default config
