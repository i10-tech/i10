import { describe, expect, it } from "bun:test"
import {
  MAX_LOCAL_PART,
  addressesByOwner,
  gigabytesToBytes,
  localPartProblem,
  mailboxRefusal,
  storageField,
  storageProblem,
} from "../lib/mailbox-create"

const GB = 1024 ** 3
const fmt = (bytes: number) => `${bytes / GB} GB`

describe("the local part rule", () => {
  it("accepts the shapes people use", () => {
    for (const ok of ["alice", "alice.smith", "a-b", "a_b", "Alice", "x1", "j.r.r"]) {
      expect(localPartProblem(ok)).toBeNull()
    }
  })

  it("refuses what the API would never derive", () => {
    for (const bad of [".alice", "alice.", "a..b", "-a", "a b", "a@b", "ali ce", "é"]) {
      expect(localPartProblem(bad)).not.toBeNull()
    }
  })

  it("says what to do about a space and about an at sign", () => {
    expect(localPartProblem("a b")).toContain("No spaces")
    expect(localPartProblem("a@acme.dev")).toContain("before the @")
  })

  it("stops at the length RFC 5321 allows", () => {
    expect(localPartProblem("a".repeat(MAX_LOCAL_PART))).toBeNull()
    expect(localPartProblem("a".repeat(MAX_LOCAL_PART + 1))).not.toBeNull()
  })
})

describe("storage", () => {
  it("is required on a pool, optional on pay as you go, and never a member's", () => {
    expect(storageField({ kind: "pool", remaining: GB }, "admin")).toBe("required")
    expect(storageField({ kind: "uncapped", remaining: null }, "admin")).toBe(
      "optional",
    )
    expect(storageField({ kind: "pool", remaining: GB }, "self")).toBe("none")
    expect(storageField({ kind: "uncapped", remaining: null }, "self")).toBe("none")
  })

  it("turns gigabytes into whole bytes", () => {
    expect(gigabytesToBytes("5")).toBe(5 * GB)
    expect(gigabytesToBytes(" 0,5 ")).toBe(GB / 2)
    expect(gigabytesToBytes("1.5")).toBe(1.5 * GB)
  })

  it("refuses zero, negatives and words, which the API reads as no value", () => {
    for (const bad of ["", "0", "0.0", "-1", "five", "1e3", "1..2"]) {
      expect(gigabytesToBytes(bad)).toBeNull()
    }
  })

  it("refuses more than the pool has left, and names what is left", () => {
    expect(storageProblem("3", 2 * GB, fmt)).toBe(
      "That is more than is left in your pool (2 GB).",
    )
    expect(storageProblem("2", 2 * GB, fmt)).toBeNull()
    expect(storageProblem("999", null, fmt)).toBeNull()
  })
})

describe("a refusal in words", () => {
  const refusal = (name: string, status: number, error: string) => ({
    name,
    status,
    error,
  })

  it("never shows a status code", () => {
    const cases = [
      refusal("mailbox_already_exists", 409, "That address is already taken."),
      refusal("password_required", 409, "This person has no password."),
      refusal("mail_signin_off", 409, "Mail sign-in is off."),
      refusal(
        "plan_limit_exceeded",
        403,
        "You have used every mailbox your plan includes.",
      ),
      refusal("invalid_access", 403, "Ask an owner."),
      refusal("forbidden", 403, "Only an owner or admin can create a mailbox."),
      refusal("not_found", 404, "No such member in this workspace."),
      refusal("validation_error", 422, "We do not host mailboxes on acme.io."),
      refusal("internal_server_error", 500, "boom"),
      refusal("something_new", 418, ""),
    ]
    for (const failure of cases) {
      expect(mailboxRefusal(failure, "admin")).not.toMatch(/\b(40\d|41\d|42\d|50\d)\b/)
    }
  })

  it("tells the next step for the ones that leave it out", () => {
    expect(
      mailboxRefusal(
        refusal("mailbox_already_exists", 409, "That address is already taken."),
        "admin",
      ),
    ).toBe("That address is already taken. Choose a different address or person.")
    expect(
      mailboxRefusal(
        refusal(
          "plan_limit_exceeded",
          403,
          "You have used every mailbox your plan includes.",
        ),
        "admin",
      ),
    ).toContain("Upgrade your plan or delete a mailbox")
  })

  it("reads a 403 invalid_access as a permission and a 401 as a sign-in", () => {
    expect(
      mailboxRefusal(
        refusal(
          "invalid_access",
          403,
          "Only an owner or admin of this workspace creates mailboxes. Ask one to create yours.",
        ),
        "self",
      ),
    ).toBe(
      "Only an owner or admin of this workspace creates mailboxes. Ask one to create yours.",
    )
    expect(
      mailboxRefusal(refusal("invalid_access", 401, "Sign in."), "self"),
    ).toContain("Sign in again")
  })

  it("does not leak a server fault's own words", () => {
    const said = mailboxRefusal(
      refusal("internal_server_error", 500, "ECONNREFUSED 10.0.0.4"),
      "admin",
    )
    expect(said).not.toContain("ECONNREFUSED")
    expect(said).toContain("Nothing was created")
  })
})

describe("who already has a mailbox", () => {
  it("maps each owner to their address and skips rows with no owner id", () => {
    const held = addressesByOwner([
      { address: "a@acme.dev", owner: { userId: "u1" } },
      { address: "b@acme.dev", owner: { userId: null } },
      { address: "c@acme.dev", owner: {} },
    ])
    expect([...held]).toEqual([["u1", "a@acme.dev"]])
  })
})
