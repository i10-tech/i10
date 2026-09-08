import { VerificationCode } from "../src/templates/verification-code"

/*
 * Preview entries for `pnpm --filter @repo/emails dev`.
 *
 * ⚠ THESE FILES HOLD SAMPLE PROPS AND NOTHING ELSE. The templates live in
 * `src/` because the API imports them; react-email's preview server wants a
 * directory of default exports it can render on its own. Keeping the two apart
 * means the preview cannot drift from what actually gets sent — it renders the
 * same component, with a fixed code so the screenshot is stable.
 */
export default function Preview() {
  return <VerificationCode code="384021" />
}
