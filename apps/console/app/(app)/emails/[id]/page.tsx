import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { EmailView } from "@/components/email-view"
import { tryApi } from "@/lib/api"
import { emailShape, type EmailData } from "@/lib/shapes/email"
import type { EmailDetail } from "@/lib/types"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const result = await tryApi<EmailDetail>(`/console/emails/${encodeURIComponent(id)}`)
  // ⚠ THE SUBJECT, NOT THE ID. A browser tab reading `a7f3…` tells somebody
  // nothing about which of the four emails they have open it is.
  return { title: result.ok ? result.data.subject || "Email" : "Email" }
}

/**
 * One message, and everything that happened to it.
 *
 * ⚠ THE EVENT TIMELINE IS THE POINT OF THE PAGE, NOT THE BODY. Somebody opens
 * this because a customer says they did not receive something; the body is
 * confirmation that the right thing was sent, and the timeline is the answer.
 * It is therefore on the right at desktop width and FIRST on mobile - a phone
 * that shows the HTML preview first makes you scroll past a whole email to
 * reach the one line that matters.
 */
export default async function EmailDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const result = await tryApi<EmailDetail>(`/console/emails/${encodeURIComponent(id)}`)

  if (!result.ok) {
    // ⚠ A 404 FROM THE API IS A REAL 404 HERE. RLS makes another tenant's id
    // indistinguishable from a nonexistent one, deliberately - a 403 would
    // confirm the id exists and turn this page into an oracle for enumerating
    // other people's message ids.
    if (result.error.statusCode === 404) notFound()
    throw new Error(result.error.message)
  }

  const email = result.data
  const data: EmailData = { email }

  return <EmailView shape={emailShape.of(data)} data={data} />
}
