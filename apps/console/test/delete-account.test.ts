import { describe, expect, it, mock } from "bun:test"

/**
 * The console's account deletion (#336): our API's route, not Clerk's
 * `user.delete()`, which the Clerk gateway refuses. A sole owner's refusal
 * keeps the names of the workspaces in its body for the dialog's toast.
 */

class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: { statusCode: number; name: string; message: string },
  ) {
    super(body.message)
  }
}

const sent: { path: string; init: unknown }[] = []
let answer: () => Promise<unknown> = async () => ({ deleted: true })

mock.module("next/cache", () => ({ refresh: () => {}, revalidatePath: () => {} }))
mock.module("@/lib/api", () => ({
  ApiRequestError,
  api: (path: string, init: unknown) => {
    sent.push({ path, init })
    return answer()
  },
}))
mock.module("@/lib/onboarding-skip", () => ({ forgetOnboardingSkip: async () => {} }))
mock.module("@/lib/preview", () => ({ PREVIEW: false }))
mock.module("@/lib/failure", () => ({
  safeFailure: () => ({
    statusCode: 500,
    name: "internal",
    message: "Something failed.",
  }),
}))

/*
 * ⚠ A FRESH COPY OF THE MODULE, NOT `@/lib/actions`: domain-activation.test.ts
 * replaces that specifier with a stub for the whole run (bun's module mocks
 * are process-wide), and this file needs the real actions over mocked I/O.
 */
const fresh: string = "../lib/actions.ts?delete-account"
const { deleteAccount } = (await import(fresh)) as typeof import("../lib/actions")

describe("deleteAccount", () => {
  it("asks our API, not Clerk, to delete the account", async () => {
    sent.length = 0
    answer = async () => ({ deleted: true })
    expect(await deleteAccount()).toEqual({ ok: true, data: { deleted: true } })
    expect(sent).toEqual([{ path: "/console/me/account", init: { method: "DELETE" } }])
  })

  it("passes a sole owner's refusal through with the workspaces named", async () => {
    answer = async () => {
      throw new ApiRequestError(409, {
        statusCode: 409,
        name: "sole_owner",
        message: "Make someone else an owner of Acme, or delete it, first.",
        workspaces: ["Acme"],
      } as never)
    }
    const result = await deleteAccount()
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      name: "sole_owner",
      error: "Make someone else an owner of Acme, or delete it, first.",
      body: { workspaces: ["Acme"] },
    })
  })
})
