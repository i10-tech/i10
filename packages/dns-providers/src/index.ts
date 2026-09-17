/**
 * Where a customer's DNS lives, and what we can do about it.
 *
 * ⚠ THIS PACKAGE HAS NO RUNTIME DEPENDENCIES AND MUST KEEP NONE. It is imported
 * by the API (bun), by the console's server components, and by the browser — the
 * provider picker and the detection result both render client-side. A dependency
 * here lands in a customer's bundle.
 */
export * from "./types.js"
export { PROVIDERS, BY_SLUG } from "./registry.js"
export {
  detectProvider,
  providerFor,
  providerBySlug,
  selectableProviders,
  resolverProviders,
  matchesPattern,
  normaliseNameserver,
} from "./detect.js"
