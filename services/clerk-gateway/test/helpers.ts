import type { EdgeCache } from "../src/cache.js"
import type { Env } from "../src/config.js"
import { handle, type GatewayDeps } from "../src/gateway.js"
import { NOT_MANAGED, type ManagedAccounts } from "../src/managed.js"
import type { Body, PolicyRequest } from "../src/policy.js"

/** A value for each `:param` kind, shaped like the real ids. */
export const SAMPLE: Record<string, string> = {
  sess: "sess_2xYz9AbCdEfGhIjKlMnOpQrStUv",
  sia: "sia_2xYz9AbCdEfGhIjKlMnOpQrStUv",
  sua: "sua_2xYz9AbCdEfGhIjKlMnOpQrStUv",
  org: "org_2xYz9AbCdEfGhIjKlMnOpQrStUv",
  orginv: "orginv_2xYz9AbCdEfGhIjKlMnOpQrStUv",
  idn: "idn_2xYz9AbCdEfGhIjKlMnOpQrStUv",
  eac: "eac_2xYz9AbCdEfGhIjKlMnOpQrStUv",
  client: "AbC123dEf456",
  version: "6",
  file: "clerk.browser.js",
  any: "anything",
}

/** `/v1/client/sessions/:sess/touch` with real-looking values filled in. */
export function sample(template: string): string {
  return template
    .replace(/\/\*\*$/, "")
    .replace(/:([a-z]+)/g, (_, name: string) => SAMPLE[name] ?? "x")
}

export const SESSION = SAMPLE.sess as string

export function request(
  method: string,
  rawPath: string,
  overrides: Partial<PolicyRequest> = {},
): PolicyRequest {
  return {
    method,
    rawPath,
    search: "",
    preflightMethod: null,
    body: { kind: "none" } as Body,
    ...overrides,
  }
}

export function form(fields: Record<string, string> | [string, string][]): Body {
  return { kind: "form", form: new URLSearchParams(fields) }
}

export const SECRET = "sk_live_supersecretvalue0123456789"

export const ENV: Env = {
  CLERK_SECRET_KEY: SECRET,
  INSTANCE: "production",
  UPSTREAM_ORIGIN: "https://frontend-api.clerk.dev",
  PROXY_URL: "https://clerk.i10.tech",
  ALLOWED_ORIGINS: "https://auth.i10.tech,https://dash.i10.tech",
  UPSTREAM_TIMEOUT_MS: "1000",
}

export interface Seen {
  url: string
  init: RequestInit
  headers: Headers
  body: string | null
}

/**
 * `caches.default` in memory: what was put, by key, read back as a fresh copy
 * each time. It never expires anything itself; the gateway decides freshness.
 */
export class MemoryCache implements EdgeCache {
  readonly entries = new Map<
    string,
    { status: number; headers: Headers; body: string }
  >()
  matches: string[] = []

  async match(key: string): Promise<Response | undefined> {
    this.matches.push(key)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    return new Response(entry.body, { status: entry.status, headers: entry.headers })
  }

  async put(key: string, response: Response): Promise<void> {
    this.entries.set(key, {
      status: response.status,
      headers: new Headers(response.headers),
      body: await response.text(),
    })
  }
}

/** The gateway in-process, with a fake Clerk, an in-memory cache and a captured log. */
export function harness(
  options: {
    env?: Partial<Env>
    managed?: ManagedAccounts
    upstream?: (seen: Seen) => Response | Promise<Response>
    cache?: MemoryCache
  } = {},
) {
  const calls: Seen[] = []
  const logs: string[] = []
  const cache = options.cache ?? new MemoryCache()
  const deferred: Promise<unknown>[] = []
  const clock = { now: 0 }
  const deps: GatewayDeps = {
    env: { ...ENV, ...options.env },
    managed: options.managed ?? NOT_MANAGED,
    log: (line) => logs.push(line),
    now: () => clock.now,
    cache,
    defer: (work) => deferred.push(work),
    fetch: async (url, init) => {
      const raw = init.body
      let body: string | null = null
      if (raw instanceof Uint8Array) body = new TextDecoder().decode(raw)
      else if (raw instanceof ReadableStream) body = await new Response(raw).text()
      const seen: Seen = { url, init, headers: new Headers(init.headers), body }
      calls.push(seen)
      return options.upstream
        ? options.upstream(seen)
        : new Response("{}", { status: 200 })
    },
  }
  return {
    calls,
    logs,
    cache,
    clock,
    /** Wait for the cache writes the gateway left running. */
    settle: () => Promise.all(deferred.splice(0)),
    send: (input: string, init?: RequestInit) =>
      handle(new Request(`https://clerk.i10.tech${input}`, init), deps),
    /** For URLs the WHATWG parser would normalise. */
    sendRaw: (req: Request) => handle(req, deps),
    lastLog: () => JSON.parse(logs.at(-1) ?? "{}") as Record<string, unknown>,
  }
}
