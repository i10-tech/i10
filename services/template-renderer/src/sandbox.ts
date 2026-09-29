import { transform } from "sucrase"

/**
 * Turning an uploaded `.tsx` file into the modules of one sandbox.
 *
 * ⚠ TRANSPILED, NEVER BUNDLED. Sucrase strips types and compiles JSX and
 * `import` to CommonJS; it resolves nothing, fetches nothing and evaluates
 * nothing, so parsing a hostile file here costs CPU and no trust. Every
 * `require` the output makes is answered inside the sandbox by the runtime's
 * allowlist - see `resolve` in runtime/entry.ts.
 *
 * ⚠ AND THE WRAPPER IS NOT A BOUNDARY. The customer's code is spliced into a
 * function in `template.js`; code that closes that function early only
 * reaches the rest of its own isolate, which it already had. The boundary is
 * the isolate: no network (`globalOutbound: null`), no bindings, a CPU limit -
 * and a parent that believes nothing it is told.
 */

export const MAX_SOURCE_BYTES = 256 * 1024

export type Transpiled = { ok: true; code: string } | { ok: false; error: string }

export function transpile(source: string): Transpiled {
  try {
    const { code } = transform(source, {
      transforms: ["typescript", "jsx", "imports"],
      jsxRuntime: "automatic",
      production: true,
      filePath: "template.tsx",
    })
    return { ok: true, code }
  } catch (error) {
    return { ok: false, error: `The template does not compile: ${messageOf(error)}` }
  }
}

const HARNESS = `import { answer } from "./runtime.js";
import template from "./template.js";

export default {
  async fetch(request) {
    try {
      return Response.json({ ok: true, value: await answer(template, await request.json()) });
    } catch (error) {
      return Response.json({ ok: false, error: String((error && error.message) || error).slice(0, 2000) });
    }
  },
};
`

export function sandboxModules(code: string, runtime: string): Record<string, string> {
  return {
    "main.js": HARNESS,
    "runtime.js": runtime,
    "template.js": `import { resolve } from "./runtime.js";
const module = { exports: {} };
(function (module, exports, require) {
${code}
})(module, module.exports, resolve);
export default module.exports;
`,
  }
}

export function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000)
}
