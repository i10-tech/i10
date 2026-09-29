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

## Where templates come from

`templates.source` says where a template is maintained (#234). That also
decides what may make a version of it:

| Source    | Maintained in                                           | A version is made by           |
| --------- | ------------------------------------------------------- | ------------------------------ |
| `managed` | the dash's editor (HTML now, the visual editor in #162) | publishing                     |
| `upload`  | `.tsx` files or a folder, uploaded in the dash          | each upload                    |
| `github`  | a connected repository (#235)                           | each push to the target branch |

A folder upload only creates or versions `upload` templates. A file whose name
matches a managed or GitHub template is refused, not versioned over it.
Templates we ship ready-made for customers are a separate, later idea.

## How a version is made

| Kind   | Source                                | Skeleton made by                                 |
| ------ | ------------------------------------- | ------------------------------------------------ |
| `html` | HTML written in the console           | finding `{{ name }}` placeholders (no execution) |
| `tsx`  | React Email files, uploaded or pushed | the sandbox Worker, `services/template-renderer` |

### Visual templates (#243)

The dash's visual editor is **`@react-email/editor`** (MIT, `resend/react-email`),
built on TipTap. A template made in it has kind `visual` and source `managed`.

- **The draft is the editor's document** (`templates.design`, TipTap JSON),
  saved together with the HTML and text the editor exports from it
  (`getEmail()`). The document is what reopens; the exported HTML is what a
  version is made from.
- **Publishing is the `html` path.** `{{ name }}` placeholders in the exported
  HTML and text become markers; no sandbox, because the editor's output is
  markup, not code. The version also keeps `design`, so any version can be
  copied back into the draft ("Edit from here") and reopened.
- **Variables are typed as `{{ name }}`**, in text and in link addresses. The
  editor exports both unchanged (verified: `href="{{ url }}"` survives), so a
  visual template fills exactly like an HTML one.
- **Isolation (#189).** The editor is handed the template's own document,
  never HTML, and ProseMirror renders only nodes its schema knows. It is loaded
  on the client, only on the editor tab. Previews still go through the
  sandboxed, CSP-constrained `EmailFrame`.
- The document is sent to the server as a plain JSON copy. TipTap's attribute
  objects are not plain, and a server action serializes them as temporary
  references that arrive as nothing.

### Template images (#244)

Images added in the visual editor go to a **separate, public R2 bucket**,
because every recipient's mail client loads them. Message content stays in the
private content bucket, and R2 tokens cannot be scoped to a prefix, so the
separation is a bucket.

- **Content-addressed per workspace:** `<folder>/<sha256>.<ext>`, where the
  folder is a salted hash of the workspace id. The public URL names no
  workspace, but a workspace's images remain one prefix. The same image
  uploaded twice is one object. Two workspaces never share one, since a shared
  object would tell one whether the other had uploaded it.
- **The type comes from the bytes:** PNG, JPEG, GIF or WebP, at most 4 MB.
  SVG is refused, since it is a document that can carry script, served from a
  host we own.
- **`core.template_assets`** records what exists, under tenant row security.
  Like `content_objects`, it has no cascading foreign key.
- **Kept while the workspace lives, deleted with it.** Sent mail points at
  these URLs, and nothing we hold says which inboxes still show them. The
  hourly retention job deletes the images of deleted workspaces
  (`core.template_assets_orphaned`, tenant ids only), from R2 first and then
  the rows.
- Settings: `TEMPLATE_ASSETS_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID`,
  `_SECRET_ACCESS_KEY` and `_PUBLIC_URL`, all or none. Unset, uploads answer
  501 and the editor takes image addresses only.

### Templates are file sets

Real template folders share a layout, a footer, a button. So a `tsx` template
is an **entry file plus everything it imports by relative path**, and an
upload (or a repository directory) is a set of files that may hold many
templates. The file-set code lives in `packages/templates` (`files.ts`), so the
API and the Worker cannot disagree about what `./layout` means:

- **Discovery.** A template is a `.tsx`/`.jsx` file with a default export that
  sets `PreviewProps`, outside `node_modules` and folders starting with `_` or
  `.`. That is React Email's own convention, so a folder that works with
  `email dev` works here. An `i10.json` at the root with
  `{ "templates": [...] }` lists them explicitly instead.
- **Names.** The file's stem is the template's name, which is what a send
  uses; its directory is the folder. Two templates with the same stem are both
  refused, since one name for two emails would be a guess.
- **The closure.** The entry's relative imports are followed transitively.
  One that is not in the set is refused, naming the file and the specifier.
  Everything else in the set is ignored, so each template renders in a
  sandbox holding only its own files. The limits are 64 files and 512 KiB per
  template, and 500 files and 4 MiB per upload.
- **In the sandbox.** Each file is transpiled on its own. `template.js` holds
  them as CommonJS factories; a relative `require` resolves only through the
  link table the parent computed, and anything else goes to the allowlist. A
  relative specifier the table does not name is refused by name, never passed
  to the allowlist.
- **The import scan is lexical, and fails closed.** A specifier it misses is
  absent from the link table, so the sandbox refuses it.

A template may also `export const subject = "Welcome, {{ name }}"`. When it
does, that becomes the version's subject and the draft's, so a GitHub
template's subject lives in the repository with the rest of it.

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
- **Upload** is the only thing that runs anything:
  `POST /console/templates/:id/versions` for one template (`{ source }` or
  `{ entry, files }`), and `POST /console/templates/upload { files }` for a
  folder, which answers with one outcome per template: `created`, `versioned`,
  `unchanged`, `refused` with its problems, or `unavailable`.
- **The same files make no new version.** `source_sha256` hashes the entry and
  all of its files, and an upload or push whose hash matches the live version
  answers `unchanged` without calling the sandbox. A version keeps its entry
  in `source`, the rest in `files`, and its entry's `path` (and, for GitHub,
  `commit_sha`), because a repository can be deleted or force-pushed.
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
- **Today, in the API (#238):** a template send is one tenant transaction. It
  resolves the reference against Postgres every time, because live moves and
  a promote must reach the very next send on every pod. It fetches the
  version's content in that same transaction only on a miss. Versions are kept
  in an in-process LRU keyed by tenant and version id (32 MB), so a warm send
  is one query, pinned or not.

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
