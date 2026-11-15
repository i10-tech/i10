/**
 * Wraps one key variable for Doppler under the current `KEY_WRAP_KEYS` key.
 *
 *   <plain value> | bun run wrap-keys <NAME>              wrap a plain value
 *   <wrapped>     | bun run wrap-keys <NAME> --rewrap     move it to the current wrap key
 *
 * Reads the value from stdin and prints only the wrapped value, so Doppler can
 * be piped into Doppler and no key reaches a terminal. The steps are in
 * docs/decisions/encryption.md.
 */
import {
  isWrapped,
  KEY_VARIABLES,
  unwrapValue,
  WRAPPABLE,
  wrapValue,
  type Wrappable,
} from "../src/crypto/unlock.js"

const isWrappable = (name: string): name is Wrappable =>
  (WRAPPABLE as string[]).includes(name)

/** The wrapped value for `input`, after checking it opens again. Throws with a reason. */
export async function wrapKeys(
  args: string[],
  input: string,
  source: NodeJS.ProcessEnv,
): Promise<string> {
  const rewrap = args.includes("--rewrap")
  const [name, ...extra] = args.filter((a) => a !== "--rewrap")
  if (!name || extra.length > 0 || !isWrappable(name)) {
    throw new Error(`usage: wrap-keys <${WRAPPABLE.join("|")}> [--rewrap]`)
  }
  const value = input.trim()
  if (!value) throw new Error(`${name}: stdin is empty`)

  let plain = value
  if (isWrapped(value)) {
    if (!rewrap) throw new Error(`${name}: the input is already wrapped (use --rewrap)`)
    plain = await unwrapValue(name, value, source)
  } else if (rewrap) {
    throw new Error(`${name}: --rewrap needs a wrapped input`)
  }

  try {
    KEY_VARIABLES[name](plain)
  } catch (error) {
    const message = (error as Error).message
    throw new Error(message.startsWith(name) ? message : `${name}: ${message}`)
  }

  const wrapped = await wrapValue(name, plain, source)
  if ((await unwrapValue(name, wrapped, source)) !== plain) {
    throw new Error(`${name}: the wrapped value does not unwrap to the input`)
  }
  return wrapped
}

if (import.meta.main) {
  try {
    if (process.stdin.isTTY) throw new Error("pipe the value in; do not type a key")
    const wrapped = await wrapKeys(
      process.argv.slice(2),
      await Bun.stdin.text(),
      process.env,
    )
    process.stdout.write(`${wrapped}\n`)
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 2
  }
}
