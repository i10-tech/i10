import js from "@eslint/js"
import eslintConfigPrettier from "eslint-config-prettier"
import tseslint from "typescript-eslint"
import pluginReactHooks from "eslint-plugin-react-hooks"
import pluginReact from "eslint-plugin-react"
import globals from "globals"
import { config as baseConfig } from "./base.js"

/**
 * ESLint config for React libraries consumed by an app that bundles them.
 * @type {import("eslint").Linter.Config[]}
 */
export const config = [
  ...baseConfig,
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  pluginReact.configs.flat.recommended,
  {
    languageOptions: {
      ...pluginReact.configs.flat.recommended.languageOptions,
      globals: { ...globals.serviceworker, ...globals.browser },
    },
  },
  {
    plugins: { "react-hooks": pluginReactHooks },
    settings: { react: { version: "detect" } },
    rules: {
      ...pluginReactHooks.configs.recommended.rules,
      "react/react-in-jsx-scope": "off",
      // ⚠ BANNED (#189): the console renders what customers wrote, and HTML
      // set this way runs in our origin with the person's session. Emails
      // render in `EmailFrame`; source renders as text. The few uses of our
      // own generated markup carry a disable with the reason on the line.
      "react/no-danger": "error",
    },
  },
]
