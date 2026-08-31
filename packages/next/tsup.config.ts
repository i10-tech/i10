import { defineConfig } from "tsup"

// `@i10/node` stays EXTERNAL, unlike contracts in the SDK's own build. It is a
// published package with its own version, so bundling a copy here would mean a
// customer on both packages ships two clients and patches only one.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["@i10/node", "next", "react"],
  target: "node20",
})
