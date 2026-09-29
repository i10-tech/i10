/**
 * Downloads the pinned embedding model into apps/api/models/minilm (#170).
 *
 *   bun scripts/fetch-models.ts            # dev checkout
 *   bun scripts/fetch-models.ts /app/models/minilm   # what the image build runs
 *
 * ⚠ PINNED BY COMMIT AND CHECKED BY SHA-256 - see MINILM in src/content/
 * embed.ts. A model file that changed under a moving tag would change every
 * vector we store without anything saying so; this refuses instead.
 */
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { MINILM } from "../src/content/embed.js"

const dir = process.argv[2] ?? join(import.meta.dir, "..", "models", "minilm")
await mkdir(dir, { recursive: true })

for (const [name, { path, sha256 }] of Object.entries(MINILM.files)) {
  const url = `https://huggingface.co/${MINILM.repo}/resolve/${MINILM.revision}/${path}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const digest = createHash("sha256").update(bytes).digest("hex")
  if (digest !== sha256)
    throw new Error(`${name}: sha256 ${digest}, expected ${sha256}`)
  await writeFile(join(dir, name), bytes)
  console.log(`${name}  ${bytes.length} bytes  ok`)
}
