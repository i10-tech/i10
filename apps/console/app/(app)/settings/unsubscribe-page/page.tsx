import type { Metadata } from "next"
import { UnsubscribePageView } from "@/components/unsubscribe-page-view"

export const metadata: Metadata = { title: "Unsubscribe page" }

/**
 * What a recipient sees when they press unsubscribe.
 *
 * ⚠ THIS PAGE IS PART OF THE PRODUCT EVEN THOUGH NOBODY USING THE CONSOLE EVER
 * SEES IT. It is the one surface a customer's own customers meet, it carries
 * their brand rather than ours, and a broken or confusing one produces spam
 * complaints instead of unsubscribes - which is far more expensive.
 */
export default function UnsubscribePageSettingsPage() {
  return <UnsubscribePageView shape={{}} data={{}} />
}
