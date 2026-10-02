import { defineConfig } from "tsup"

// `@i10/node` stays EXTERNAL, unlike contracts in the SDK's own build. It is a
// published package with its own version, so bundling a copy here would mean a
// customer on both packages ships two clients and patches only one.
//
// No `clean` under `--watch`, for the reason in packages/node/tsup.config.ts:
// the console's dev server imports this dist/ while the watcher rebuilds it.
export default defineConfig((options) => ({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: !options.watch,
  sourcemap: true,
  external: ["@i10/node", "next", "react"],
  target: "node20",
}))
