// `dist/runtime.txt` reaches the Worker as TEXT (the `Text` rule in
// wrangler.jsonc): it is handed to each sandbox as a module, never run here.
//
// ⚠ `.txt`, NOT `.js`, BECAUSE celld ONLY TAKES EXTENSION GLOBS. Wrangler would
// accept a rule naming this one file; celld refuses any glob but `**/*.ext`,
// since esbuild picks a loader by extension. A `.js` rule would turn every
// module in the Worker into text.
declare module "*.txt" {
  const source: string
  export default source
}
