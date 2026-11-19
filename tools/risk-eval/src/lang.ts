/**
 * Cheap language detection: no model, no dependency.
 *
 * 1. Script vote. Count the letters of each script in the first 3,000
 *    characters. If one non-Latin script holds at least 30% of all letters it
 *    names the language: Arabic -> ar, Hangul -> ko, kana (any) -> ja,
 *    ideographs without kana -> zh, Cyrillic -> ru, Devanagari -> hi, Thai ->
 *    th, Hebrew -> he, Greek -> el. These are SCRIPT guesses: Cyrillic is
 *    reported as ru although it could be Ukrainian or Bulgarian, and Arabic
 *    script could be Persian or Urdu. The report treats them as scripts.
 * 2. Otherwise, for Latin script, count hits of a short stopword list per
 *    language (en es fr de pt it nl id). The winner needs at least 3 hits and
 *    1.5 times the runner-up, else the answer is "und".
 *
 * ⚠ IT IS A STRATIFICATION KEY, NOT A CLASSIFIER OF RECORD. Close languages
 * (es/pt, id/ms); words that are also common English (a, o, do, in) are left out of the lists so English text cannot vote for another language can be confused on short mails; the split only needs a stable,
 * roughly right label, and "und" is returned rather than a guess on short text.
 */

const SCRIPTS: { lang: string; test: RegExp }[] = [
  { lang: "ar", test: /\p{Script=Arabic}/gu },
  { lang: "ko", test: /\p{Script=Hangul}/gu },
  { lang: "kana", test: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu },
  { lang: "han", test: /\p{Script=Han}/gu },
  { lang: "ru", test: /\p{Script=Cyrillic}/gu },
  { lang: "hi", test: /\p{Script=Devanagari}/gu },
  { lang: "th", test: /\p{Script=Thai}/gu },
  { lang: "he", test: /\p{Script=Hebrew}/gu },
  { lang: "el", test: /\p{Script=Greek}/gu },
]

const STOPWORDS: Record<string, string[]> = {
  en: "the and you your for with this that are not have from will our can please".split(
    " ",
  ),
  es: "el la los las que para con por una del pero favor usted esta como más".split(
    " ",
  ),
  fr: "le la les des vous pour avec dans une est pas que votre sur nous cette".split(
    " ",
  ),
  de: "der die das und ist nicht sie ihr mit für auf ein eine von wir zu".split(" "),
  pt: "não você seu sua mais uma com para os as pelo também são está".split(" "),
  it: "il lo gli che per con una non sono del della di è anche vostro più".split(" "),
  nl: "de het een en van niet voor met uw wij ons dit zijn u bent".split(" "),
  id: "yang dan di ke dari untuk dengan ini anda kami tidak akan atau pada".split(" "),
}

const SAMPLE_CHARS = 3000
const SCRIPT_SHARE = 0.3

export function detectLanguage(text: string): string {
  const sample = text.slice(0, SAMPLE_CHARS)
  const letters = sample.match(/\p{L}/gu)?.length ?? 0
  if (letters < 8) return "und"

  const counts = SCRIPTS.map((s) => ({
    lang: s.lang,
    n: sample.match(s.test)?.length ?? 0,
  }))
  const n = (lang: string) => counts.find((c) => c.lang === lang)?.n ?? 0
  // Kana beats ideographs: Japanese text is mostly ideographs plus some kana.
  const kana = n("kana")
  const han = n("han")
  const ranked = [
    { lang: "ar", n: n("ar") },
    { lang: "ko", n: n("ko") },
    { lang: "ja", n: kana > 0 ? kana + han : 0 },
    { lang: "zh", n: kana === 0 ? han : 0 },
    ...counts.filter((c) => !["ar", "ko", "kana", "han"].includes(c.lang)),
  ].sort((a, b) => b.n - a.n)
  const top = ranked[0]
  if (top && top.n / letters >= SCRIPT_SHARE) return top.lang

  const words = sample.toLowerCase().match(/\p{L}+/gu) ?? []
  const scores = Object.entries(STOPWORDS)
    .map(([lang, list]) => {
      const set = new Set(list)
      return { lang, hits: words.filter((w) => set.has(w)).length }
    })
    .sort((a, b) => b.hits - a.hits)
  const best = scores[0]
  const second = scores[1]
  if (!best || best.hits < 3) return "und"
  if (second && best.hits < second.hits * 1.5) return "und"
  return best.lang
}
