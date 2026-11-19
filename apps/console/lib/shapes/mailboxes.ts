import { defineShape } from "@/lib/shapes"

export type MailboxesData = Record<string, never>
export type MailboxesShape = Record<string, never>

export const mailboxesShape = defineShape<MailboxesShape, MailboxesData>({
  page: "mailboxes",
  fallback: {},
  of: () => ({}),
  parse: (raw) => (typeof raw === "object" && raw !== null ? {} : null),
})
