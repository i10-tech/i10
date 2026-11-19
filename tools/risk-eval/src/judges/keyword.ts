import type { Answers, Judge, JudgeInput } from "../judge.js"

/**
 * A deliberately crude baseline: weighted keyword counts squashed into (0, 1).
 *
 * It exists to prove the pipeline end to end and to set a floor a real judge
 * must clear, not to be good. Every list is English, so on mail in any other
 * language it can only answer "no", and the per-language breakdown shows that.
 */

interface Rule {
  pattern: RegExp
  weight: number
}

function rules(weights: Record<string, number>): Rule[] {
  return Object.entries(weights).map(([word, weight]) => ({
    pattern: new RegExp(word, "i"),
    weight,
  }))
}

const CREDENTIALS = rules({
  "\\bpassword\\b": 1,
  "\\bverify (your )?(account|identity|email)\\b": 2,
  "\\bconfirm your (account|identity|details|information)\\b": 2,
  "\\blog ?in\\b": 0.8,
  "\\bsign ?in\\b": 0.8,
  "\\b(ssn|social security)\\b": 2,
  "\\b(card number|cvv|pin)\\b": 2,
  "\\bupdate your (billing|payment|account)\\b": 2,
})

const URGENCY = rules({
  "\\b(urgent|immediately|within 24 hours|act now)\\b": 1,
  "\\b(suspended|locked|limited|deactivated|terminated)\\b": 1.5,
  "\\bunauthori[sz]ed\\b": 1.5,
  "\\bsecurity (alert|notice|warning)\\b": 1.5,
})

const BRANDS = rules({
  "\\bpaypal\\b": 1,
  "\\b(microsoft|office ?365|outlook)\\b": 1,
  "\\bapple( id)?\\b": 0.7,
  "\\bamazon\\b": 0.7,
  "\\b(netflix|dhl|fedex|ups|usps)\\b": 1,
  "\\b(bank of america|wells fargo|chase|hsbc|barclays)\\b": 1.5,
  "\\bdocusign\\b": 1,
})

const SPAMMY = rules({
  "\\b(viagra|cialis|pharmacy|casino|lottery|winner|jackpot)\\b": 2,
  "\\b(free|bonus|prize|guaranteed)\\b": 0.7,
  "\\b(million|inheritance|beneficiary|next of kin)\\b": 1.5,
  "\\b(click here|buy now|order now|limited time)\\b": 1,
  "\\b(refinance|mortgage|weight loss|enlarge)\\b": 1.5,
  "!{2,}": 0.7,
})

const MARKETING = rules({
  "\\bunsubscribe\\b": 2,
  "\\b(\\d+% off|sale|discount|coupon|promo(tion)?)\\b": 1.5,
  "\\b(newsletter|special offer|exclusive offer)\\b": 1.5,
  "\\b(shop now|buy now|order now)\\b": 1,
})

function score(rulesList: Rule[], text: string): number {
  return rulesList.reduce((sum, r) => (r.pattern.test(text) ? sum + r.weight : sum), 0)
}

/** 0 hits -> 0, rising and saturating: about 0.63 at 1, 0.95 at 3. */
function squash(weight: number): number {
  return 1 - Math.exp(-weight)
}

export const keywordJudge: Judge = {
  name: "keyword-v1",
  judge(input: JudgeInput): Promise<Answers> {
    const text = `${input.subject}\n${input.text}`
    const credentials = score(CREDENTIALS, text)
    const urgency = score(URGENCY, text)
    const brands = score(BRANDS, text)
    const spammy = score(SPAMMY, text)
    const marketing = score(MARKETING, text)
    const hasLink = /https?:\/\//i.test(text)
    return Promise.resolve({
      // Phishing is credentials or a brand plus pressure, helped by a link.
      phishing: squash(
        (credentials + urgency + (brands > 0 ? brands : 0) * 0.5) *
          (hasLink ? 1 : 0.6) *
          0.6,
      ),
      spam: squash(spammy * 0.8 + (marketing > 0 ? 0.3 : 0)),
      impersonates_brand: squash(brands * 0.8 + (urgency > 0 ? 0.2 : 0)),
      asks_for_credentials: squash(credentials * 0.8),
      is_marketing: squash(marketing * 0.7),
    })
  },
}
