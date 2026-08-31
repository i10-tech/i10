import type { BatchSend, SendEmail, SendEmailResponse } from "@repo/contracts"
import { I10Error } from "./error.js"

const DEFAULT_BASE_URL = "https://api.i10.tech"

export interface I10Options {
  /** Override for self-hosted or staging. Trailing slash is tolerated. */
  baseUrl?: string
  /** Passed straight to fetch. Lets callers wire their own timeout/abort. */
  fetch?: typeof globalThis.fetch
}

export interface RequestOptions {
  /**
   * Replays with the same key return the FIRST result rather than sending
   * again. Supply one for anything a retry could duplicate — a password reset
   * loop that fires twice is the failure this exists to prevent.
   */
  idempotencyKey?: string
  signal?: AbortSignal
}

export class I10 {
  readonly #apiKey: string
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch

  constructor(apiKey: string, options: I10Options = {}) {
    if (!apiKey) {
      throw new Error("An API key is required. Get one at https://i10.tech")
    }
    this.#apiKey = apiKey
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  readonly emails = {
    send: (payload: SendEmail, options?: RequestOptions) =>
      this.#post<SendEmailResponse>("/emails", payload, options),

    batch: (payload: BatchSend, options?: RequestOptions) =>
      this.#post<{ data: SendEmailResponse[] }>("/emails/batch", payload, options),
  }

  async #post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    const headers: Record<string, string> = {
      // ⚠ `Authorization: Bearer` is NOT ours to restyle. The whole migration
      // pitch is that a customer changes one import and nothing else, so the
      // transport must match byte for byte. Only the key format is ours.
      Authorization: `Bearer ${this.#apiKey}`,
      "Content-Type": "application/json",
    }
    if (options?.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey
    }

    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    if (!response.ok) {
      // A gateway or proxy can return a non-JSON body on 5xx. Falling back to
      // a synthetic error keeps the thrown type stable, so callers never have
      // to handle "sometimes it's an I10Error and sometimes it's a SyntaxError".
      const payload = await response.json().catch(() => ({
        statusCode: response.status,
        name: "internal_server_error" as const,
        message: response.statusText || "Unexpected response from i10.",
      }))
      throw new I10Error(payload)
    }

    return (await response.json()) as T
  }
}
