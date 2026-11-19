import type { Template } from "../types.js"
import { AR } from "./ar.js"
import { DE } from "./de.js"
import { EN_ACCOUNT } from "./en-account.js"
import { EN_ACTIVITY } from "./en-activity.js"
import { EN_BILLING } from "./en-billing.js"
import { EN_HARD } from "./en-hard.js"
import { EN_MARKETING } from "./en-marketing.js"
import { EN_SECURITY } from "./en-security.js"
import { ES } from "./es.js"
import { FR } from "./fr.js"
import { ID } from "./id.js"
import { JA } from "./ja.js"
import { PT } from "./pt.js"
import { ZH } from "./zh.js"

/** Every authored template, English first. */
export const TEMPLATES: Template[] = [
  ...EN_SECURITY,
  ...EN_ACCOUNT,
  ...EN_BILLING,
  ...EN_ACTIVITY,
  ...EN_MARKETING,
  ...EN_HARD,
  ...AR,
  ...ES,
  ...PT,
  ...FR,
  ...DE,
  ...JA,
  ...ID,
  ...ZH,
]
