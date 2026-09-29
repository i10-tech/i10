/**
 * Bundles the parent Worker into one file, `dist/worker.js`, for celld.
 *
 * ⚠ celld IS A STOPGAP FOR CLOUDFLARE'S DYNAMIC WORKERS, which need the Workers
 * Paid plan (decided 2026-09-30, see docs/decisions/templates.md). The code is
 * the same; only where it runs differs, and `wrangler.jsonc` still deploys it
 * to Cloudflare unchanged.
 *
 * ⚠ PRE-BUNDLED SO THE IMAGE CARRIES NO TOOLCHAIN. celld bundles with esbuild
 * unless the config says `no_bundle`, which would put esbuild and the whole
 * `node_modules` tree in a production image to be used once at start-up. One
 * file, bundled here with the sandbox runtime inlined as text, needs neither.
 *
 * Run `build-runtime.ts` first: `dist/runtime.txt` is inlined from disk.
 */
const root = new URL("..", import.meta.url).pathname

const result = await Bun.build({
  entrypoints: [`${root}src/index.ts`],
  target: "browser",
  format: "esm",
  minify: false,
  conditions: ["workerd", "worker", "browser"],
  loader: { ".txt": "text" },
  outdir: `${root}dist`,
  naming: "worker.js",
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log(`worker ${(result.outputs[0]!.size / 1024).toFixed(0)} KiB`)
