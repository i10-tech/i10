"use client"

import { useRecordShape } from "@/components/list/remembered-shapes"
import { emailShape } from "@/lib/shapes/email"
import { EmailView } from "@/components/email-view"

/** Loading an email record: its own view drawn from the seeded or fallback shape. */
export default function Loading() {
  return <EmailView shape={useRecordShape(emailShape)} />
}
