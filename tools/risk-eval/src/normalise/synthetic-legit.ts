import { GENERATION_YEAR, generateMails } from "../generate/index.js"
import { type Normaliser, toMail } from "./common.js"

/**
 * `synthetic-legit-modern`: legitimate mail written for this tool, not read
 * from any file. It is regenerated on every `normalise` from the authored
 * templates, so it has no download and no pinned checksum; the code and the
 * templates are what is reviewed.
 *
 * The language is the template's own, set exactly rather than detected, and the
 * year is the generation year.
 */
export const normaliseSyntheticLegit: Normaliser = async function* (ctx) {
  const { mails } = generateMails()
  for (const generated of mails) {
    const mail = toMail(ctx.dataset, generated.key, "legit", generated.type, {
      subject: generated.subject,
      text: generated.text,
      html: generated.html,
      year: GENERATION_YEAR,
      fromDomain: generated.fromDomain,
    })
    mail.lang = generated.lang
    mail.mail_type = generated.type
    mail.style = generated.style
    if (generated.hardNegative) mail.hard_negative = true
    yield mail
  }
}
