import { describe, expect, it } from "bun:test"
import {
  availableActions,
  canRestore,
  exportWaitWords,
  forwardTargets,
  gigabytesText,
  mailboxActionRefusal,
  meterScale,
  refusalTitle,
  statusNote,
  type ConsoleMailbox,
  type ConsoleMailboxDeletion,
} from "../lib/mailbox-view"

const GB = 1024 ** 3
const fmt = (bytes: number) => `${bytes / GB} GB`
const NOW = new Date("2026-11-16T12:00:00.000Z")

const deletion = (purgeAt: string): ConsoleMailboxDeletion => ({
  outcome: "delete",
  deletedAt: "2026-10-20T12:00:00.000Z",
  purgeAt,
  forwardTo: null,
  exportWait: null,
})

const waiting = (
  reason: NonNullable<ConsoleMailboxDeletion["exportWait"]>["reason"],
  purgeAt: string,
  readyAfter: string | null = null,
): ConsoleMailboxDeletion => ({
  ...deletion(purgeAt),
  outcome: "export_then_delete",
  exportWait: { reason, readyAfter },
})

function mailbox(address: string, status: string): ConsoleMailbox {
  return {
    address,
    displayName: null,
    owner: { name: null, email: null },
    domain: "acme.dev",
    status,
    deletion: null,
    signIn: "password",
    storage: { allocatedBytes: null, usedBytes: null, usedAt: null },
    createdAt: "2026-01-01T00:00:00.000Z",
  }
}

describe("which actions a mailbox is offered", () => {
  it("offers suspend on a live mailbox and resume on a suspended one", () => {
    expect(availableActions({ status: "active", deletion: null }, NOW)).toEqual([
      "storage",
      "suspend",
      "delete",
    ])
    expect(availableActions({ status: "suspended", deletion: null }, NOW)).toEqual([
      "storage",
      "resume",
      "delete",
    ])
  })

  it("offers suspend where the login is already blocked another way", () => {
    // A payment hold is not an owner's suspension, so it is not "resume"'s to lift.
    expect(availableActions({ status: "payment_hold", deletion: null }, NOW)).toContain(
      "suspend",
    )
  })

  it("offers only restore while the window is open, and nothing after", () => {
    const open = deletion("2026-11-20T12:00:00.000Z")
    const over = deletion("2026-11-15T12:00:00.000Z")
    expect(availableActions({ status: "deleting", deletion: open }, NOW)).toEqual([
      "restore",
    ])
    expect(availableActions({ status: "deleting", deletion: over }, NOW)).toEqual([])
    expect(canRestore(open, NOW)).toBe(true)
    expect(canRestore(over, NOW)).toBe(false)
  })

  it("offers starting the export again when it failed or was never made, even after the window", () => {
    const open = "2026-11-20T12:00:00.000Z"
    const over = "2026-11-15T12:00:00.000Z"
    for (const reason of ["export_failed", "export_missing"] as const) {
      expect(
        availableActions({ status: "deleting", deletion: waiting(reason, open) }, NOW),
      ).toEqual(["restore", "retry_export"])
      expect(
        availableActions({ status: "deleting", deletion: waiting(reason, over) }, NOW),
      ).toEqual(["retry_export"])
    }
    // A running export, or one that is only waiting out its download window, is not retried.
    for (const reason of ["export_pending", "export_ready_after"] as const) {
      expect(
        availableActions({ status: "deleting", deletion: waiting(reason, over) }, NOW),
      ).toEqual([])
    }
  })

  it("never offers restore to a deleting row that has no deletion record", () => {
    expect(availableActions({ status: "deleting", deletion: null }, NOW)).toEqual([])
  })
})

describe("what a deletion waiting for its export says", () => {
  const words = (
    reason: NonNullable<ConsoleMailboxDeletion["exportWait"]>["reason"],
    who = { restorable: true, isAdmin: true },
    readyAfter: string | null = null,
  ) =>
    exportWaitWords(
      waiting(reason, "2026-11-20T12:00:00.000Z", readyAfter).exportWait,
      who,
    )

  it("says nothing when it is not waiting", () => {
    expect(exportWaitWords(null, { restorable: true, isAdmin: true })).toBeNull()
  })

  it("names the next step: start again or restore for a failed export", () => {
    expect(words("export_failed")?.text).toBe(
      "The export failed, so the mailbox is not erased yet. Start the export again, or restore the mailbox.",
    )
    expect(words("export_missing")?.text).toContain("There is no export")
  })

  it("does not point at a restore that is no longer offered, or at buttons a member lacks", () => {
    expect(words("export_failed", { restorable: false, isAdmin: true })?.text).toBe(
      "The export failed, so the mailbox is not erased yet. Start the export again.",
    )
    expect(
      words("export_failed", { restorable: false, isAdmin: false })?.text,
    ).toContain("Ask an owner or admin")
  })

  it("gives the date a finished export is ready to be erased after", () => {
    const done = words("export_ready_after", undefined, "2026-11-27T12:00:00.000Z")
    expect(done?.date).toBe("2026-11-27T12:00:00.000Z")
    expect(words("export_pending")?.date).toBeNull()
  })

  it("never writes an em dash", () => {
    for (const reason of [
      "export_pending",
      "export_failed",
      "export_missing",
      "export_ready_after",
    ] as const) {
      expect(words(reason)?.text).not.toContain(String.fromCharCode(0x2014))
    }
  })

  it("says what a refused retry means, in the API's own sentence", () => {
    expect(
      mailboxActionRefusal(
        {
          name: "not_waiting_for_export",
          status: 409,
          error: "That mailbox was not deleted with an export first.",
        },
        "retry_export",
      ),
    ).toBe("That mailbox was not deleted with an export first.")
    expect(refusalTitle("retry_export")).toBe("Could not start the export")
  })
})

describe("who a deleted mailbox can forward to", () => {
  it("is another live mailbox, and nobody who could not receive it", () => {
    const list = [
      mailbox("a@acme.dev", "active"),
      mailbox("b@acme.dev", "active"),
      mailbox("c@acme.dev", "suspended"),
      mailbox("d@acme.dev", "deleting"),
      mailbox("e@acme.dev", "payment_hold"),
    ]
    expect(forwardTargets(list, "a@acme.dev").map((m) => m.address)).toEqual([
      "b@acme.dev",
    ])
  })
})

describe("what a blocked mailbox says", () => {
  it("explains each status that stops a sign-in, and is silent for the rest", () => {
    for (const status of [
      "suspended",
      "payment_hold",
      "domain_off",
      "banned",
      "locked",
      "sso_required",
      "inactive",
    ]) {
      expect(statusNote(status, "acme.dev")).toBeTruthy()
    }
    expect(statusNote("active", "acme.dev")).toBeNull()
    expect(statusNote("deleting", "acme.dev")).toBeNull()
  })

  it("names the domain that stopped hosting", () => {
    expect(statusNote("domain_off", "acme.dev")).toContain("acme.dev")
  })

  it("never writes an em dash", () => {
    for (const status of ["suspended", "payment_hold", "banned", "sso_required"]) {
      expect(statusNote(status, "acme.dev")).not.toContain(String.fromCharCode(0x2014))
    }
  })
})

describe("what a refusal says", () => {
  const refuse = (name: string, status: number, error = "", body?: object) => ({
    name,
    status,
    error,
    ...(body ? { body: body as Record<string, unknown> } : {}),
  })

  it("turns a pool refusal's bytes into sizes a person reads", () => {
    const text = mailboxActionRefusal(
      refuse("plan_limit_exceeded", 403, "That is more than is left", {
        remaining: 2 * GB,
        total: 20 * GB,
      }),
      "storage",
      fmt,
    )
    expect(text).toContain("2 GB of 20 GB")
    expect(text).not.toMatch(/\d{6,}/)
  })

  it("does not show a request field name for a bad forward target", () => {
    const text = mailboxActionRefusal(
      refuse("validation_error", 422, "forward_to must be another mailbox"),
      "delete",
    )
    expect(text).not.toContain("forward_to")
    expect(text).toContain("another mailbox")
  })

  it("says what to do about a delete the server could not run", () => {
    expect(
      mailboxActionRefusal(refuse("internal_server_error", 501, "x"), "delete"),
    ).toContain("Choose another option")
    expect(
      mailboxActionRefusal(refuse("application_error", 503, "x"), "delete"),
    ).toContain("nothing was deleted")
  })

  it("keeps the API's own sentence where it already says what to do", () => {
    expect(
      mailboxActionRefusal(
        refuse("directory_deactivated", 409, "A directory still says this."),
        "resume",
      ),
    ).toBe("A directory still says this.")
  })

  it("asks for a new sign-in on 401, and never leaks a status code", () => {
    const text = mailboxActionRefusal(refuse("invalid_access", 401, "x"), "suspend")
    expect(text).toContain("Sign in again")
    expect(mailboxActionRefusal(refuse("weird", 500, ""), "restore")).not.toMatch(
      /\b500\b/,
    )
  })

  it("titles each action's alert", () => {
    expect(refusalTitle("storage")).toBe("Could not change the storage")
    expect(refusalTitle("delete")).toBe("Could not delete the mailbox")
  })
})

describe("the storage field", () => {
  it("shows an allocation in gigabytes, trimmed, and empty for none", () => {
    expect(gigabytesText(5 * GB)).toBe("5")
    expect(gigabytesText(1.5 * GB)).toBe("1.5")
    expect(gigabytesText(null)).toBe("")
  })

  it("counts a bar in the unit its limit is read in", () => {
    expect(meterScale(5 * GB).unit).toBe("GB")
    expect(meterScale(500 * 1024 ** 2).unit).toBe("MB")
    expect(meterScale(3 * 1024 ** 4).unit).toBe("TB")
  })
})
