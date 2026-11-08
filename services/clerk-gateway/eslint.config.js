import { config } from "@repo/eslint-config/base"

// `.wrangler/` is wrangler's local build output: generated, not ours to lint.
export default [...config, { ignores: [".wrangler/**"] }]
