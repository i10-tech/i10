import { EDGE_HEADER } from "../src/identity/edge.js"

/** What a request through our Cloudflare zone carries; tests of the edge proof use their own. */
export const EDGE_SECRET = "edge-secret-for-tests-0123456789abcdef"
export const EDGE_PROOF = { [EDGE_HEADER]: EDGE_SECRET }
