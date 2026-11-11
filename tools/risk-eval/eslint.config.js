import { config } from "@repo/eslint-config/base"

export default [
  ...config,
  {
    rules: {
      // The cache location is a runtime knob of this CLI, not a build input,
      // and this directory is not a turbo task, so declaring it in turbo.json
      // would only add noise to the repo-wide passthrough list.
      "turbo/no-undeclared-env-vars": ["error", { allowList: ["^I10_RISK_EVAL_"] }],
    },
  },
]
