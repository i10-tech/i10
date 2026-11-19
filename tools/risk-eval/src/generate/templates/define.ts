import type { Block, Lang, MailType, Style, Template } from "../types.js"

/**
 * Starts a list of templates for one language. The id is made from the
 * language, type and style plus a counter, so adding a wording never changes
 * the id (and so the mails) of the ones before it.
 */
export function authoring(lang: Lang) {
  const seen = new Map<string, number>()
  return (type: MailType, style: Style, subject: string[], body: Block[]): Template => {
    const key = `${type}.${style}`
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    return { id: `${lang}.${key}.${n}`, type, style, lang, subject, body }
  }
}
