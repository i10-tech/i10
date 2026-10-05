import { transform } from "sucrase"
import { messageOf } from "./sandbox.js"

/**
 * Webhook transformations (#302): a customer's function that reshapes one
 * webhook before it is signed and sent.
 *
 * ⚠ THE SAME BOUNDARY AS A TEMPLATE, TIGHTER. Each function gets its own
 * Dynamic Worker - no network, no bindings, no secrets - and a CPU ceiling a
 * twentieth of a template's, because this runs once per delivery rather than
 * once per version. Nothing it returns is believed here or in the API; the
 * API checks the shape, the method, the origin and the headers before a byte
 * is sent (apps/api/src/webhooks/transform.ts).
 *
 * ⚠ NOTHING CAN BE IMPORTED. A transformation reshapes JSON; it has no use for
 * a library, and an allowlist is attack surface with nothing to show for it.
 * `require` answers every specifier with a sentence.
 */

export const MAX_TRANSFORMATION_BYTES = 64 * 1024
/** The webhook handed in: the envelope, at most a little over the body cap. */
export const MAX_TRANSFORM_INPUT_BYTES = 1024 * 1024

export type PreparedTransform =
  | { ok: true; code: string; input: unknown }
  | { ok: false; status: 400 | 422; error: string }

export function prepareTransform(body: unknown, rawBytes: number): PreparedTransform {
  if (rawBytes > MAX_TRANSFORMATION_BYTES + MAX_TRANSFORM_INPUT_BYTES) {
    return { ok: false, status: 400, error: "too_large" }
  }
  if (!body || typeof body !== "object")
    return { ok: false, status: 400, error: "invalid_body" }
  const { code, input } = body as { code?: unknown; input?: unknown }
  if (typeof code !== "string" || code.trim() === "") {
    return { ok: false, status: 400, error: "missing_code" }
  }
  if (new TextEncoder().encode(code).byteLength > MAX_TRANSFORMATION_BYTES) {
    return {
      ok: false,
      status: 422,
      error: `The transformation is over ${MAX_TRANSFORMATION_BYTES / 1024}KB.`,
    }
  }
  if (!input || typeof input !== "object") {
    return { ok: false, status: 400, error: "missing_input" }
  }
  try {
    const out = transform(code, {
      transforms: ["typescript", "imports"],
      production: true,
      filePath: "transformation.ts",
    })
    return { ok: true, code: out.code, input }
  } catch (error) {
    return {
      ok: false,
      status: 422,
      error: `The transformation does not compile: ${messageOf(error)}`,
    }
  }
}

const HARNESS = `import handler from "./transformation.js";

export default {
  async fetch(request) {
    try {
      if (typeof handler !== "function") {
        throw new Error("Export a function: export default function handler(webhook) { ... return webhook }");
      }
      const webhook = await request.json();
      const value = await handler(webhook);
      return Response.json({ ok: true, value: value === undefined ? webhook : value });
    } catch (error) {
      return Response.json({ ok: false, error: String((error && error.message) || error).slice(0, 2000) });
    }
  },
};
`

/**
 * The sandbox's two modules. The customer's code runs as a CommonJS factory;
 * its default export (or a `handler` export) is the function.
 */
export function transformModules(code: string): Record<string, string> {
  return {
    "main.js": HARNESS,
    "transformation.js": `const module = { exports: {} };
(function (module, exports, require) {
${code}
})(module, module.exports, function (spec) {
  throw new Error("Transformations cannot import anything; \`" + spec + "\` is not available.");
});
const exported = module.exports;
export default typeof exported === "function"
  ? exported
  : exported && (exported.default || exported.handler);
`,
  }
}
