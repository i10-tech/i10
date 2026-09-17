import type { Metadata } from "next"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/page"
import { UnsubscribePageSettings } from "@/components/unsubscribe-settings"

export const metadata: Metadata = { title: "Unsubscribe page" }

/**
 * What a recipient sees when they press unsubscribe.
 *
 * ⚠ THIS PAGE IS PART OF THE PRODUCT EVEN THOUGH NOBODY USING THE CONSOLE EVER
 * SEES IT. It is the one surface a customer's own customers meet, it carries
 * their brand rather than ours, and a broken or confusing one produces spam
 * complaints instead of unsubscribes — which is far more expensive.
 */
export default function UnsubscribePageSettingsPage() {
  return (
    <div>
      <Section className="pt-0">
        <SectionTitle>Appearance</SectionTitle>
        <SectionDescription>
          Shown to your recipients when they follow an unsubscribe link. Applies to
          every broadcast from this workspace.
        </SectionDescription>
        <SectionContent>
          <UnsubscribePageSettings />
        </SectionContent>
      </Section>
    </div>
  )
}
