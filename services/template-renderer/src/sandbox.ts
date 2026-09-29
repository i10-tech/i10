import { transform } from "sucrase"

/**
 * Turning a template's files into the modules of one sandbox.
 *
 * ⚠ TRANSPILED, NEVER BUNDLED. Sucrase strips types and compiles JSX and
 * `import` to CommonJS; it resolves nothing, fetches nothing and evaluates
 * nothing, so parsing a hostile file here costs CPU and no trust. Every
 * `require` the output makes is answered inside the sandbox: a relative one
 * through the link table this process computed (see `closureOf` in
 * @repo/templates), anything else by the runtime's allowlist - see `resolve`
 * in runtime/entry.ts.
 *
 * ⚠ AND THE WRAPPER IS NOT A BOUNDARY. Each file's code is spliced into a
 * function in `template.js`; code that closes that function early only
 * reaches the rest of its own isolate - the other files of the same template,
 * from the same author - which it already had. The boundary is the isolate:
 * no network (`globalOutbound: null`), no bindings, a CPU limit - and a parent
 * that believes nothing it is told.
 */

/** The single-file form, `{ source }`, which predates file sets (#234). */
export const MAX_SOURCE_BYTES = 256 * 1024

export type Transpiled = { ok: true; code: string } | { ok: false; error: string }

export function transpile(source: string, filePath = "template.tsx"): Transpiled {
  try {
    const { code } = transform(source, {
      transforms: ["typescript", "jsx", "imports"],
      jsxRuntime: "automatic",
      production: true,
      filePath,
    })
    return { ok: true, code }
  } catch (error) {
    const what = filePath === "template.tsx" ? "The template" : `\`${filePath}\``
    return { ok: false, error: `${what} does not compile: ${messageOf(error)}` }
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

/**
 * The sandbox's modules: the harness, the runtime, and `template.js`, which
 * holds every file of the template as a CommonJS factory and exports the
 * entry's `module.exports`.
 *
 * ⚠ A RELATIVE SPECIFIER THE LINK TABLE DOES NOT NAME IS REFUSED BY NAME, never
 * passed to the allowlist, so `./react` cannot be answered with React and a
 * file the scan missed fails with a sentence rather than resolving to
 * something else.
 */
export function sandboxModules(input: {
  entry: string
  code: Record<string, string>
  links: Record<string, Record<string, string>>
  runtime: string
}): Record<string, string> {
  const factories = Object.entries(input.code)
    .map(
      ([
        path,
        code,
      ]) => `FILES[${JSON.stringify(path)}] = function (module, exports, require) {
${code}
};`,
    )
    .join("\n")

  return {
    "main.js": HARNESS,
    "runtime.js": input.runtime,
    "template.js": `import { resolve } from "./runtime.js";
const LINKS = ${JSON.stringify(input.links)};
const FILES = Object.create(null);
${factories}
const CACHE = Object.create(null);
function load(path) {
  const cached = CACHE[path];
  if (cached) return cached.exports;
  const module = { exports: {} };
  CACHE[path] = module;
  FILES[path](module, module.exports, function (spec) {
    const own = LINKS[path];
    if (own && Object.prototype.hasOwnProperty.call(own, spec)) return load(own[spec]);
    if (spec.startsWith(".")) {
      throw new Error("\`" + spec + "\`, imported by \`" + path + "\`, is not one of the template's files.");
    }
    return resolve(spec);
  });
  return module.exports;
}
export default load(${JSON.stringify(input.entry)});
`,
  }
}

export function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000)
}
