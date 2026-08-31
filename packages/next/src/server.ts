import { I10 } from "@i10/node"

let cached: I10 | undefined

/**
 * The server-side client, built once per process from `I10_API_KEY`.
 *
 * Lazy rather than module-scope so that importing this module in a file that
 * also runs at build time does not throw when the key is absent — Next
 * evaluates module scope during `next build`, where secrets are correctly not
 * present. The error arrives on first use, in a request, where it is
 * actionable.
 */
export function i10(): I10 {
  if (cached) return cached

  const apiKey = process.env.I10_API_KEY
  if (!apiKey) {
    throw new Error(
      "I10_API_KEY is not set. Add it to the server environment — never to a NEXT_PUBLIC_ variable, which ships the key to every browser.",
    )
  }

  cached = new I10(apiKey, { baseUrl: process.env.I10_BASE_URL })
  return cached
}
