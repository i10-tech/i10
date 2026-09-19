import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import {
  createDomainSchema,
  deletedDomainSchema,
  domainListSchema,
  domainSchema,
  domainSummarySchema,
  dnsRecordSchema,
} from "@repo/contracts"
import { requireApiKey } from "../middleware/auth.js"
import { errorResponse, notWired as notWiredFor } from "./shared.js"

/**
 * Domains, shaped as Resend's.
 *
 * ⚠ THE PATHS, THE VERBS AND THE BODY KEYS ARE THEIRS. `resend/node` →
 * `@i10/node` is meant to be a one-line change, and a customer who has written
 * `domains.create({ name })` should not have to find out that ours takes
 * `{ domain }`. What is not theirs is the record VALUES: those name Amazon,
 * because Amazon sends the mail.
 *
 * ⚠ AND THERE IS NO `PATCH`. Resend's updates tracking pixels and TLS
 * enforcement, none of which i10 implements. A route that accepted the body and
 * did nothing would be worse than its absence — the customer would believe
 * click tracking was on. A 404 says plainly that it is not there yet.
 */
export const domains = new OpenAPIHono()

dnsRecordSchema.openapi("DnsRecord")
domainSummarySchema.openapi("DomainSummary")
const Domain = domainSchema.openapi("Domain")
const DomainList = domainListSchema.openapi("DomainList")
const CreateDomain = createDomainSchema.openapi("CreateDomain")
const DeletedDomain = deletedDomainSchema.openapi("DeletedDomain")
const notWired = notWiredFor("Domains")

const notFound = {
  statusCode: 404,
  name: "not_found" as const,
  message: "No domain with that id.",
}

const idParam = z.object({
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
})

const validation = (message: string) => ({
  statusCode: 422,
  name: "validation_error" as const,
  message,
})

const create = createRoute({
  method: "post",
  path: "/",
  summary: "Create a domain",
  description:
    "Claims a domain for sending and returns the DNS records to publish. The " +
    "domain is unusable until those records exist and `POST /domains/{id}/verify` " +
    "has confirmed them.",
  tags: ["Domains"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateDomain } },
    },
  },
  responses: {
    201: {
      description: "Created, with the records to publish.",
      content: { "application/json": { schema: Domain } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    403: errorResponse("The plan does not include another domain."),
    409: errorResponse("That domain is already registered."),
    422: errorResponse("The name is not a domain."),
    501: errorResponse("Domains are not configured."),
  },
})

domains.openapi(
  create,
  async (c) => {
    const store = c.get("domains")
    if (!store) return c.json(notWired, 501)

    const auth = c.get("auth")
    const created = await store.create(auth.tenantId, c.req.valid("json"))

    switch (created.status) {
      case "created":
        return c.json(created.domain, 201)
      case "rejected":
        return c.json(validation(created.reason), 422)
      case "conflict":
        return c.json(
          {
            statusCode: 409,
            name: "domain_already_exists" as const,
            message: created.reason,
          },
          409,
        )
      default:
        // ⚠ 403, NOT 429. A plan limit on a resource is not rate limiting and
        // must not be retried — the SDKs back off on 429, and waiting will not
        // create another domain. The fix is an upgrade or a deletion.
        return c.json(
          {
            statusCode: 403,
            name: "plan_limit_exceeded" as const,
            message: created.reason,
          },
          403,
        )
    }
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        validation(result.error.issues[0]?.message ?? "Invalid request body."),
        422,
      )
    }
  },
)

const list = createRoute({
  method: "get",
  path: "/",
  summary: "List domains",
  description: "Summaries only. Fetch one domain to see its DNS records.",
  tags: ["Domains"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  responses: {
    200: {
      description: "Every domain this key's tenant owns, newest first.",
      content: { "application/json": { schema: DomainList } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    501: errorResponse("Domains are not configured."),
  },
})

domains.openapi(list, async (c) => {
  const store = c.get("domains")
  if (!store) return c.json(notWired, 501)
  const auth = c.get("auth")
  return c.json({ data: await store.list(auth.tenantId) }, 200)
})

const get = createRoute({
  method: "get",
  path: "/{id}",
  summary: "Retrieve a domain",
  tags: ["Domains"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: { params: idParam },
  responses: {
    200: {
      description: "The domain, with the records to publish.",
      content: { "application/json": { schema: Domain } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    404: errorResponse("No domain with that id."),
    501: errorResponse("Domains are not configured."),
  },
})

domains.openapi(get, async (c) => {
  const store = c.get("domains")
  if (!store) return c.json(notWired, 501)
  const auth = c.get("auth")
  const domain = await store.get(auth.tenantId, c.req.valid("param").id)
  return domain ? c.json(domain, 200) : c.json(notFound, 404)
})

const verify = createRoute({
  method: "post",
  path: "/{id}/verify",
  summary: "Verify a domain",
  description:
    "Asks the provider to re-check the DNS records. Verification is not " +
    "instant: a `pending` answer means the records have not propagated yet, " +
    "and `temporary_failure` means the lookup itself failed and is worth " +
    "retrying — neither means the records are wrong.",
  tags: ["Domains"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: { params: idParam },
  responses: {
    200: {
      description: "The domain as it now stands.",
      content: { "application/json": { schema: Domain } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    404: errorResponse("No domain with that id."),
    409: errorResponse(
      "Another workspace verified this domain first. A name may be held by " +
        "any number of workspaces while it is pending, but only by one once " +
        "ownership has been proved.",
    ),
    501: errorResponse("Domains are not configured."),
  },
})

domains.openapi(verify, async (c) => {
  const store = c.get("domains")
  if (!store) return c.json(notWired, 501)
  const auth = c.get("auth")
  const outcome = await store.verify(auth.tenantId, c.req.valid("param").id)

  switch (outcome.status) {
    /*
     * ⚠ 200, NOT AN ERROR. The challenge record simply is not published yet,
     * which is the ordinary state of every delegated domain between being added
     * and being set up — the same state a manual domain is in before its six
     * records resolve, which also answers 200. The domain comes back carrying
     * its record list, where the outstanding `Ownership` row is the signal.
     */
    case "ok":
    case "unproven":
      return c.json(outcome.domain, 200)
    case "missing":
      return c.json(notFound, 404)
    default:
      // ⚠ A CONFLICT OVER THE NAME, NOT A VERDICT ON THEIR DNS. See the console
      // route for the long version; the records may be entirely correct.
      return c.json(
        {
          statusCode: 409,
          name: "domain_already_claimed" as const,
          message:
            `${outcome.domain.name} has already been verified by another ` +
            `workspace. If it is also yours, remove it there first.`,
        },
        409,
      )
  }
})

const remove = createRoute({
  method: "delete",
  path: "/{id}",
  summary: "Delete a domain",
  description:
    "Removes the domain and its sending identity. Mail already accepted is " +
    "unaffected; nothing new can be sent from it afterwards.",
  tags: ["Domains"],
  security: [{ bearerAuth: [] }],
  middleware: [requireApiKey] as const,
  request: { params: idParam },
  responses: {
    200: {
      description: "Deleted.",
      content: { "application/json": { schema: DeletedDomain } },
    },
    401: errorResponse("The API key is missing, malformed, or unknown."),
    404: errorResponse("No domain with that id."),
    501: errorResponse("Domains are not configured."),
  },
})

domains.openapi(remove, async (c) => {
  const store = c.get("domains")
  if (!store) return c.json(notWired, 501)
  const auth = c.get("auth")
  const { id } = c.req.valid("param")
  const deleted = await store.remove(auth.tenantId, id)
  return deleted
    ? c.json({ object: "domain" as const, id, deleted: true as const }, 200)
    : c.json(notFound, 404)
})
