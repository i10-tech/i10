import { feedbackIdKey } from "../send/feedback-id.js"
import { keyringFromEnv } from "./keyring.js"
import { local } from "./wrap-local.js"

/**
 * Opens the key variables that Doppler holds wrapped, once, before `loadEnv`.
 *
 *   wrap1.<provider>.<provider's own parts>
 *
 * For `local` the provider's parts are `<kid>.<iv>.<tag>.<ciphertext>`
 * (wrap-local.ts). The plaintext is the variable's whole plain value, and the
 * associated data is `i10/wrap/v1/<NAME>`, so a value wrapped for one variable
 * does not unwrap as another. See docs/decisions/encryption.md.
 */

/**
 * The variables that may be wrapped, each with the parser its plain value must
 * pass. `loadEnv`, the wrap script and the docs check all read this one table.
 */
export const KEY_VARIABLES = {
  SEAL_KEYS: (value: string) => keyringFromEnv("SEAL_KEYS", value),
  TOKEN_KEYS: (value: string) => keyringFromEnv("TOKEN_KEYS", value),
  CONTENT_KEYS: (value: string) => keyringFromEnv("CONTENT_KEYS", value),
  FEEDBACK_ID_KEY: (value: string) => feedbackIdKey(value),
} as const satisfies Record<string, (value: string) => unknown>

export type Wrappable = keyof typeof KEY_VARIABLES
export const WRAPPABLE = Object.keys(KEY_VARIABLES) as Wrappable[]

export const WRAP_PREFIX = "wrap1."

/**
 * One way to open a wrapped value. `payload` is everything after
 * `wrap1.<provider>.`. Errors say what went wrong and never hold key material
 * or the value; the caller puts the variable's name in front.
 *
 * ⚠ ASYNC BECAUSE A KEY SERVICE IS. `local` never waits, but a KMS provider is
 * a network call, and it slots in here without changing any caller.
 */
export interface WrapProvider {
  wrap(plain: string, context: string, source: NodeJS.ProcessEnv): Promise<string>
  unwrap(payload: string, context: string, source: NodeJS.ProcessEnv): Promise<string>
}

const PROVIDERS: Readonly<Record<string, WrapProvider>> = { local }

/** The provider new values are wrapped with. Switching to KMS changes this line. */
const WRAP_WITH = "local"

const contextFor = (name: Wrappable) => `i10/wrap/v1/${name}`

export const isWrapped = (value: string) => value.trim().startsWith(WRAP_PREFIX)

/** Something to warn through: a pino logger or `console`. */
export interface Warns {
  warn(message: string): void
}

/** Opens one wrapped value. Throws an error that names `name` and not the value. */
export async function unwrapValue(
  name: Wrappable,
  value: string,
  source: NodeJS.ProcessEnv,
): Promise<string> {
  const rest = value.trim().slice(WRAP_PREFIX.length)
  const dot = rest.indexOf(".")
  const id = rest.slice(0, dot)
  const provider = dot > 0 && Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : undefined
  if (!provider) {
    const shown = /^[a-z0-9-]{1,16}$/.test(id) ? ` "${id}"` : ""
    throw new Error(`${name}: is wrapped by an unknown provider${shown}`)
  }
  try {
    return await provider.unwrap(rest.slice(dot + 1), contextFor(name), source)
  } catch (error) {
    throw new Error(`${name}: ${(error as Error).message}`)
  }
}

/** Wraps `plain` for `name` with the current provider and key. */
export async function wrapValue(
  name: Wrappable,
  plain: string,
  source: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const payload = await PROVIDERS[WRAP_WITH]!.wrap(plain, contextFor(name), source)
    return `${WRAP_PREFIX}${WRAP_WITH}.${payload}`
  } catch (error) {
    throw new Error(`${name}: ${(error as Error).message}`)
  }
}

/**
 * A copy of `source` with every wrapped key variable replaced by its plain
 * value. Absent stays absent and plain passes through.
 *
 * ⚠ A COPY, NEVER `process.env` ITSELF. Child processes and crash dumps read
 * `process.env`; the plain keys must only live in the object `loadEnv` parses.
 *
 * ⚠ A PLAIN KEY IN PRODUCTION IS ALLOWED, AND LOUD. It is the break-glass
 * path: when the unwrap key is lost or KMS is down, the owner pastes the paper
 * copy into Doppler and the process must still start.
 */
export async function unlockEnv(
  log: Warns,
  source: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const env = { ...source }
  const plain: Wrappable[] = []
  for (const name of WRAPPABLE) {
    const value = source[name]
    if (value === undefined) continue
    if (isWrapped(value)) env[name] = await unwrapValue(name, value, source)
    else plain.push(name)
  }
  if (source.NODE_ENV === "production" && plain.length > 0) {
    log.warn(
      `KEYS NOT WRAPPED: ${plain.join(", ")} reached this process in plain form. ` +
        `That is only right during break-glass. Wrap them again (docs/decisions/encryption.md).`,
    )
  }
  return env
}
