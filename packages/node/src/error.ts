import type { ApiError, ErrorName } from "@repo/contracts"

/**
 * Thrown for any non-2xx response.
 *
 * `name` carries the API's machine-readable error name, which is what callers
 * branch on. `retryable` is derived here rather than left to the caller
 * because the rate-limit / quota distinction is easy to get wrong and
 * expensive when you do: retrying a `daily_quota_exceeded` forever is a hot
 * loop against a billing state that will not change on its own.
 */
export class I10Error extends Error {
  readonly statusCode: number
  readonly errorName: ErrorName
  readonly retryable: boolean

  constructor(payload: ApiError) {
    super(payload.message)
    this.name = "I10Error"
    this.statusCode = payload.statusCode
    this.errorName = payload.name
    this.retryable =
      payload.name === "rate_limit_exceeded" || payload.name === "internal_server_error"
  }
}
