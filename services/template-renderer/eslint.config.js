import { config } from "@repo/eslint-config/base"

// `dist/` is the sandbox runtime bundle and `.wrangler/` is wrangler's build
// output: both generated, neither ours to lint.
export default [...config, { ignores: ["dist/**", ".wrangler/**"] }]
