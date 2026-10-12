import { config } from "@repo/eslint-config/react-internal"

/*
 * Arc's components (everything under src/components except i10/ and
 * deprecated/) are vendored from the Arc registry and kept as installed, so
 * updates can be re-pulled with the shadcn CLI. They carry disable comments
 * for a Next.js rule this package does not load; those comments, and Arc's
 * own control-character regex in the rich text editor, are not ours to edit.
 */
export default [
  ...config,
  {
    files: ["src/components/**/*.tsx"],
    ignores: ["src/components/i10/**", "src/components/deprecated/**"],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    plugins: { "@next/next": { rules: { "no-img-element": { create: () => ({}) } } } },
    rules: { "no-control-regex": "off" },
  },
]
