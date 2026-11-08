import { describe, expect, it } from "bun:test"
import { slowClerkLogged } from "../src/identity/clerk.js"
import type { ClerkIdentity } from "../src/identity/ports.js"

function recorder() {
  const warned: Array<{ o: object; m: string }> = []
  const log = {
    info: () => {},
    warn: (o: object, m: string) => warned.push({ o, m }),
    error: () => {},
  }
  return { log, warned }
}

describe("slowClerkLogged", () => {
  it("names a call that takes longer than the limit, and passes its answer through", async () => {
    const { log, warned } = recorder()
    const api = {
      user: async (id: string) => {
        await Bun.sleep(30)
        return { id }
      },
    } as unknown as ClerkIdentity
    const user = await slowClerkLogged(api, log, 10).user("user_1")
    expect(user).toEqual({ id: "user_1" } as never)
    expect(warned).toHaveLength(1)
    expect(warned[0]!.m).toBe("slow Clerk call")
    expect(warned[0]!.o).toMatchObject({ call: "user" })
  })

  it("says nothing about a fast call, and still logs a slow one that fails", async () => {
    const { log, warned } = recorder()
    const api = {
      user: async () => null,
      ban: async () => {
        await Bun.sleep(30)
        throw new Error("clerk down")
      },
    } as unknown as ClerkIdentity
    const timed = slowClerkLogged(api, log, 10)
    await timed.user("user_1")
    expect(warned).toHaveLength(0)
    const failed = await timed.ban("user_1").then(
      () => null,
      (error: Error) => error.message,
    )
    expect(failed).toBe("clerk down")
    expect(warned.map((w) => w.o)).toEqual([expect.objectContaining({ call: "ban" })])
  })
})
