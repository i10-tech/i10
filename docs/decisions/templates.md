# Templates: render once, fill on send

**Decided:** 2026-09-30. **Status:** #160 built (versions, the sandbox Worker,
`template` on the send API). The sandbox runs on celld until the Cloudflare
account is on Workers Paid; see "Where the sandbox runs". The templates page (#161), the visual editor
(#162) and the rest of #189 build on it.

---

## The rule

**Customer template code runs once per version, in a sandbox, and never on the
send path.**

When a version is created (an upload, a GitHub push, an editor save) the
template is rendered once with every variable replaced by a marker. What comes
out is stored as the version's **skeleton**. A send that names the template
fills the skeleton's markers by string substitution. No template code runs, and
nothing on the send path calls the sandbox.

Why, in the order it was decided:

1. **Cost.** A version renders once, not once per email.
2. **The send path stays ours.** No vendor call and no code execution between
   `POST /emails` and the 202.
3. **Security is simpler than "check it once".** Running code once cannot prove
   it safe, since it may behave differently on other input. Here it does not
   need to be: after that one render, the code never runs again.

## How a version is made

| Kind   | Source                              | Skeleton made by                                 |
| ------ | ----------------------------------- | ------------------------------------------------ |
| `html` | HTML written in the console         | finding `{{ name }}` placeholders (no execution) |
| `tsx`  | an uploaded React Email `.tsx` file | the sandbox Worker, `services/template-renderer` |

Markers look like `⟦i10<nonce>_<n>⟧`. The nonce is random per version and
chosen after the source is fixed, so a template cannot contain one by accident.
The marker code lives in `packages/templates`, shared by the Worker and the
API.

### The sandbox

`services/template-renderer` is a Cloudflare Worker that loads each template as
its own Dynamic Worker:

- `globalOutbound: null`, so `fetch` and `connect` throw.
- `env: {}`, so there are no bindings and no secrets.
- `limits: { cpuMs: 1000, subRequests: 0 }`.
- Imports are an allowlist: `react`, `react-email`, `@react-email/*`. Versions
  are pinned and recorded on every version row (`runtime`).
- Sucrase transpiles TSX in the parent Worker. It parses and never evaluates.

Everything the sandbox returns is treated as untrusted data. The parent
decides.

### The gate: "does it only insert its variables?"

A skeleton can be filled later only if the template's output depends on its
variables in exactly one way: where they are inserted. The Worker renders
three times and compares:

| Render | Variables are    | Catches                                                          |
| ------ | ---------------- | ---------------------------------------------------------------- |
| a      | markers, nonce A | a transformed variable (`toUpperCase`, `slice`, formatters)      |
| b      | markers, nonce B | output that depends on a value, or changes between renders       |
| empty  | `""`             | conditions and measurement (`{x && …}`, `x \|\| "y"`, `.length`) |

It also refuses a variable in a `<script>`, a `<style>`, a style attribute, an
event handler or a comment, where no escaping makes it safe. It refuses a prop
the template reads that `PreviewProps` does not declare, and lists.

**Templates with logic over their variables are refused at upload** with the
reason. Rendering those per send is a deliberate non-feature for now, to be
decided on demand.

**The known gap:** a comparison against a literal (`plan === "pro" ? … : …`)
takes the same branch for every marker and for `""`, so rendering cannot see
it. Closing it needs a static check or per-send rendering.

`PreviewProps` (React Email's own sample-data convention) is how a template
says what its variables are. Every value is a string by the time it reaches the
template; numbers and booleans from callers are stringified.

### Filling

`fill` in `packages/templates` does the two things a render would have done to
a value:

- **Escaping** with React's own five entities, so a filled skeleton is
  byte-equal to rendering the template with those values. Tests assert exactly
  that, against real React Email output.
- **Blocked URLs:** a marker in an `href`/`src`-like attribute carries a `u`
  flag, and `javascript:`/`vbscript:` values become `#`, as React does.

Plain text is rendered alongside. HTML-to-text uppercases headings, so a marker
there arrives uppercase, and the fill uppercases the value to match.

Subjects use `{{ name }}` placeholders, and line breaks in a filled subject are
folded to spaces, because a CR or LF in a header is header injection (#189).

## Versions

`core.templates` is the identity and the draft. `core.template_versions` rows
are immutable. `templates.live_version_id` is the one pointer that moves.

- **Publish** makes the draft a new live version. For `tsx`, publishing re-uses
  the latest rendering under the draft subject, so a subject edit needs neither
  a re-upload nor the sandbox.
- **Upload** (`POST /console/templates/:id/versions`) is the only route that
  runs anything.
- **Promote** makes an older version live, which is how you roll back.
- A send records `message_bodies.template_version_id`. The body is still stored
  in full, and content compaction (#171) deduplicates it like any other.

## Sending

```json
{
  "from": "…",
  "to": "…",
  "template": { "id": "welcome", "version": 3, "variables": { "name": "Ada" } }
}
```

As in Resend: `id` is the template's id or its name, `template` cannot be
combined with `html`/`text`, and the request's `subject` wins over the
template's. We add an optional `version`, which pins; without it the send
follows whatever is live. A missing template is a 404 (`not_found`) and missing
variables are a 422 (`validation_error`), checked before quota is spent. A
batch is all-or-nothing.

## Designed for an edge send path

The send path's first layer is moving to Cloudflare, so:

- **`resolveTemplateSend` is pure** and lives in `packages/templates`, which has
  no Node, Bun or DOM types. The API calls it today; a Worker can call the same
  code.
- **It reads through a port with two lookups**, because they cache differently:
  - ref → version id is **mutable**: live moves on promote. Cache it briefly,
    or purge on promote.
  - version id → content is **immutable**. Cache it by id, forever, anywhere.
- **`StoredVersion` is plain JSON**, the same bytes in Postgres, in the API's
  answer and in any cache.

## Where the sandbox runs: celld for now

Cloudflare's Dynamic Workers need the Workers Paid plan. Until the account
upgrades, **the same Worker runs on [celld](https://celld.dev)** (Deno's
open-source, Apache-2.0 Workers runtime, whose Worker Loader API matches
Cloudflare's). Decided 2026-09-30, for development and production, **not for
real customers' templates**.

It runs in the cluster (`infra/k8s/i10/workloads/template-renderer.yaml`) and in
`compose.dev.yaml`, from one image (`services/template-renderer/Dockerfile`).
The code is unchanged, and `wrangler.jsonc` still deploys it to Cloudflare.

Measured under celld on 2026-09-30, the properties the design relies on hold:

| Probe                           | Result                                           |
| ------------------------------- | ------------------------------------------------ |
| `fetch` from a template         | refused, `Worker exceeded subrequest limit of 0` |
| an import outside the allowlist | refused, naming the allowlist                    |
| an infinite loop                | stopped, `Worker exceeded CPU limit of 1000 ms`  |
| the next upload after the loop  | served normally                                  |

`wrangler dev` could not show the CPU limit: it does not enforce one, and a
loop hung it.

**What is weaker than Cloudflare, stated plainly:** celld runs each template as
a V8 isolate inside the celld process, and its own docs say that boundary is
not a claim about V8 escape safety. So the pod is built to be worth nothing to
an escape: no egress at all (a NetworkPolicy, DNS included), no service
account token, no route from outside the cluster, and one secret, its own.

**Switching to Cloudflare** is a deploy, not a change: upgrade the plan, run
`bun run deploy` in `services/template-renderer`, and point
`TEMPLATE_RENDERER_URL` at the `workers.dev` URL. Then delete
`template-renderer.yaml`, the Dockerfile, `celld.jsonc`,
`scripts/build-celld.ts`, the compose service and the image's entry in
`build.yml`.

## Operating the renderer

See `services/template-renderer/README.md`. The API needs
`TEMPLATE_RENDERER_URL` (set in `api.yaml` while the renderer is in the
cluster) and `TEMPLATE_RENDERER_SECRET` (Doppler, `api` config), both or
neither.
Without them HTML templates work and `.tsx` uploads answer 501. The renderer
being down stops uploads and nothing else.
