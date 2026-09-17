import type { Metadata } from "next"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/page"
import { ThemePicker } from "@/components/theme-picker"

export const metadata: Metadata = { title: "Appearance" }

/**
 * ⚠ THE THEME IS PER-BROWSER, NOT PER-ACCOUNT, AND THE PAGE SAYS SO. next-themes
 * stores it in `localStorage`; persisting it to the account would mean a write
 * on every toggle and a flash of the wrong theme on every first paint while the
 * preference is fetched. Somebody using two machines genuinely may want dark on
 * one and light on the other.
 */
export default function AppearancePage() {
  return (
    <div>
      <Section className="pt-0">
        <SectionTitle>Theme</SectionTitle>
        <SectionDescription>
          Remembered in this browser. Set it again on another device.
        </SectionDescription>
        <SectionContent>
          <ThemePicker />
        </SectionContent>
      </Section>
    </div>
  )
}
