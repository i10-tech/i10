import { domainsShape } from "@/lib/shapes/domains"
import { apiKeysShape } from "@/lib/shapes/api-keys"
import { emailsShape } from "@/lib/shapes/emails"
import { logsShape } from "@/lib/shapes/logs"
import { suppressionsShape } from "@/lib/shapes/suppressions"
import { contactsShape } from "@/lib/shapes/contacts"
import { segmentsShape } from "@/lib/shapes/segments"
import { topicsShape } from "@/lib/shapes/topics"
import { broadcastsShape } from "@/lib/shapes/broadcasts"
import { webhooksShape } from "@/lib/shapes/webhooks"
import { templatesShape } from "@/lib/shapes/templates"
import { ssoShape } from "@/lib/shapes/sso"
import { billingShape } from "@/lib/shapes/billing"
import { overviewShape } from "@/lib/shapes/overview"

/**
 * Every page shape the layout seeds from GET /console/shapes, so a first
 * visit draws the right skeleton. A converted page adds its def here.
 */
export const PAGE_SHAPES = [
  domainsShape,
  apiKeysShape,
  emailsShape,
  logsShape,
  suppressionsShape,
  contactsShape,
  segmentsShape,
  topicsShape,
  broadcastsShape,
  webhooksShape,
  templatesShape,
  ssoShape,
  billingShape,
  overviewShape,
]
