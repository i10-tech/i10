/**
 * Bundles what a template sandbox imports into one module, `dist/runtime.txt`,
 * and records exactly which versions went into it in `dist/runtime.json`.
 *
 * ⚠ THE PARENT WORKER CARRIES THIS AS TEXT, NOT AS CODE IT RUNS. It is passed to
 * the Worker Loader as a module of every sandbox; the parent itself never
 * imports it (see the `Text` rule in wrangler.jsonc).
 *
 * ⚠ THE RUNTIME ID IS STORED ON EVERY VERSION. A version is rendered once, so
 * its skeleton is the record of what was sent; the id says which React and
 * React Email produced it, which is what anybody asking "why does v3 look
 * different from v4" needs first. It is also part of the sandbox's cache id,
 * so a deploy with new versions never reuses an isolate built on old ones.
 */
import { mkdir } from "node:fs/promises"

const root = new URL("..", import.meta.url).pathname

const result = await Bun.build({
  entrypoints: [`${root}src/runtime/entry.ts`],
  target: "browser",
  format: "esm",
  minify: true,
  conditions: ["workerd", "worker", "browser"],
  define: { "process.env.NODE_ENV": '"production"' },
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const pinned = ["react", "react-dom", "react-email"] as const
const versions = await Promise.all(
  pinned.map(async (name) => {
    const manifest = (await Bun.file(
      Bun.resolveSync(`${name}/package.json`, root),
    ).json()) as { version: string }
    return `${name}@${manifest.version}`
  }),
)

await mkdir(`${root}dist`, { recursive: true })
const code = await result.outputs[0]!.text()
await Bun.write(`${root}dist/runtime.txt`, code)
await Bun.write(
  `${root}dist/runtime.json`,
  `${JSON.stringify({ id: versions.join("+") })}\n`,
)
console.log(`runtime ${versions.join(" ")} - ${(code.length / 1024).toFixed(0)} KiB`)
