/**
 * What each page's `</>` button shows: the public API call that does what the
 * page does, in Node and in cURL.
 *
 * ⚠ ONLY ENDPOINTS THAT EXIST (apps/api/openapi.json), and only SDK methods
 * `@i10/node` has - `emails.send` and `emails.batch`. Everything else is
 * shown as `fetch`, which works today, rather than an SDK call that does not.
 */
export interface ApiSnippet {
  tooltip: string
  title: string
  description: string
  docs?: string
  code: { label: string; code: string }[]
}

const BASE = "https://api.i10.tech"

const curl = (method: string, path: string, body?: string) =>
  [
    `curl -X ${method} ${BASE}${path} \\`,
    `  -H "Authorization: Bearer $I10_API_KEY"${body ? " \\" : ""}`,
    ...(body ? [`  -H "Content-Type: application/json" \\`, `  -d '${body}'`] : []),
  ].join("\n")

const fetchCall = (method: string, path: string, body?: string) =>
  `const response = await fetch("${BASE}${path}", {
  method: "${method}",
  headers: {
    Authorization: \`Bearer \${process.env.I10_API_KEY}\`,${body ? `\n    "Content-Type": "application/json",` : ""}
  },${body ? `\n  body: JSON.stringify(${body}),` : ""}
})
const data = await response.json()`

export const SNIPPETS = {
  emails: {
    tooltip: "Send from code",
    title: "Send an email",
    description:
      "Every email sent through the API shows up here within a second of being accepted.",
    docs: "https://docs.i10.tech/quickstart",
    code: [
      {
        label: "Node.js",
        code: `import { I10 } from "@i10/node"

const i10 = new I10(process.env.I10_API_KEY)

await i10.emails.send({
  from: "Acme <hello@acme.com>",
  to: "ada@example.com",
  subject: "Hello from Acme",
  html: "<p>It works.</p>",
})`,
      },
      {
        label: "cURL",
        code: curl(
          "POST",
          "/emails",
          `{
    "from": "Acme <hello@acme.com>",
    "to": "ada@example.com",
    "subject": "Hello from Acme",
    "html": "<p>It works.</p>"
  }`,
        ),
      },
    ],
  },
  templates: {
    tooltip: "Send from code",
    title: "Send a template",
    description:
      "Name the template by its id or alias. Its From, Reply-To and subject are used unless the request gives its own, and variables left out get their fallback.",
    code: [
      {
        label: "Node.js",
        code: `import { I10 } from "@i10/node"

const i10 = new I10(process.env.I10_API_KEY)

await i10.emails.send({
  to: "ada@example.com",
  template: {
    id: "password-reset", // the template's id or alias
    variables: { name: "Ada" },
  },
})`,
      },
      {
        label: "cURL",
        code: curl(
          "POST",
          "/emails",
          `{
    "to": "ada@example.com",
    "template": { "id": "password-reset", "variables": { "name": "Ada" } }
  }`,
        ),
      },
    ],
  },
  domains: {
    tooltip: "Domains from code",
    title: "Add a domain",
    description:
      "The response carries the DNS records to publish. Verification is checked again on its own, or on demand with /verify.",
    docs: "https://docs.i10.tech/dns",
    code: [
      { label: "Node.js", code: fetchCall("POST", "/domains", `{ name: "acme.com" }`) },
      { label: "cURL", code: curl("POST", "/domains", `{ "name": "acme.com" }`) },
      { label: "Verify", code: curl("POST", "/domains/{id}/verify") },
    ],
  },
  apiKeys: {
    tooltip: "Use a key",
    title: "Authenticate with a key",
    description:
      "Every request carries the key as a bearer token. Keep it in your server's environment, never in a browser.",
    docs: "https://docs.i10.tech/quickstart",
    code: [
      {
        label: "Node.js",
        code: `import { I10 } from "@i10/node"

// I10_API_KEY=i10_live_...
const i10 = new I10(process.env.I10_API_KEY)`,
      },
      { label: "cURL", code: curl("GET", "/domains") },
    ],
  },
  webhooks: {
    tooltip: "Webhooks from code",
    title: "Add an endpoint",
    description:
      "The signing secret is in the response, once. Events are POSTed to the URL as they happen and retried with backoff.",
    code: [
      {
        label: "Node.js",
        code: fetchCall(
          "POST",
          "/webhook-endpoints",
          `{
    url: "https://acme.com/webhooks/i10",
    events: ["email.delivered", "email.bounced", "email.complained"],
  }`,
        ),
      },
      {
        label: "cURL",
        code: curl(
          "POST",
          "/webhook-endpoints",
          `{
    "url": "https://acme.com/webhooks/i10",
    "events": ["email.delivered", "email.bounced", "email.complained"]
  }`,
        ),
      },
    ],
  },
  suppressions: {
    tooltip: "Suppressions from code",
    title: "Suppress an address",
    description:
      "Suppressed addresses are skipped at send. List them with GET, and remove one with DELETE /suppressions/{address}.",
    code: [
      {
        label: "Node.js",
        code: fetchCall("POST", "/suppressions", `{ address: "ada@example.com" }`),
      },
      {
        label: "cURL",
        code: curl("POST", "/suppressions", `{ "address": "ada@example.com" }`),
      },
      { label: "Remove", code: curl("DELETE", "/suppressions/ada@example.com") },
    ],
  },
  logs: {
    tooltip: "Send from code",
    title: "Every request lands here",
    description:
      "Each call made with one of your keys is logged with its status and timing, never its body. Look one up by the email id it returned.",
    code: [
      { label: "Node.js", code: fetchCall("GET", "/emails/{id}") },
      { label: "cURL", code: curl("GET", "/emails/{id}") },
    ],
  },
} satisfies Record<string, ApiSnippet>
