# Template renderer

Renders an uploaded React Email `.tsx` **once**, in a sandbox, when a template
version is created. Sends never call it. They fill the stored rendering in the
API. The design, and why, is in `docs/decisions/templates.md`.

Each template runs in its own Dynamic Worker: no network, no bindings, no
secrets, and 1s of CPU per call.

## Where it runs today: celld

Cloudflare's Dynamic Workers need the Workers Paid plan, so until the account
upgrades this Worker runs on [celld](https://celld.dev), whose Worker Loader API
matches Cloudflare's. This is for development and production, not for real
customers' templates. The code is the same on both; only the deployment
differs.

| File                     | For                                            |
| ------------------------ | ---------------------------------------------- |
| `celld.jsonc`            | celld's config (it refuses `observability`)    |
| `scripts/build-celld.ts` | bundles the Worker into one file for celld     |
| `Dockerfile`             | the pinned celld release plus that one file    |
| `entrypoint.sh`          | writes the secret to `.dev.vars` and starts it |
| `wrangler.jsonc`         | the Cloudflare deployment, for later           |

### Locally

```bash
docker compose -f compose.dev.yaml up -d --build template-renderer
```

It listens on `http://localhost:8788` with the secret `local-dev-secret`. Give
the API:

```
TEMPLATE_RENDERER_URL=http://localhost:8788
TEMPLATE_RENDERER_SECRET=local-dev-secret
```

`bun run dev` in this directory still runs it under `wrangler dev`, which is
quicker to iterate on. But `wrangler dev` does not enforce the CPU limit: an
infinite loop there hangs the whole local runtime. celld does enforce it.

### In the cluster

`infra/k8s/i10/workloads/template-renderer.yaml`: a ClusterIP Service with no
IngressRoute, a NetworkPolicy that denies all egress, and no service account
token. The Build workflow builds and pins the image like the others.

The pod reads `RENDERER_SECRET` from the `TEMPLATE_RENDERER_SECRET` key of the
API's own Secret, so the two always match and nothing else of the API's reaches
this pod. `TEMPLATE_RENDERER_URL` is set in `api.yaml`. Set the secret once in
Doppler's `api` config, then restart both:

```bash
openssl rand -base64 32
```

## Checking a deployment

These must hold wherever it runs. Against celld they were measured on
2026-09-30:

```bash
URL=http://localhost:8788; SECRET=local-dev-secret
post() { curl -s -X POST "$URL/compile" -H "authorization: Bearer $SECRET" --data "$1"; echo; }

# CPU: must answer 422 "exceeded CPU limit" in about a second
post '{"source":"export default function T() { while (true) {} }"}'
# network: must be refused
post '{"source":"export default async function T() { await fetch(\"https://example.com\"); return null }"}'
# imports: must name the allowlist
post '{"source":"import fs from \"node:fs\"\nexport default () => fs.readFileSync(\"/etc/passwd\")"}'
# file sets: a relative import outside the files must be refused by name
post '{"entry":"a.tsx","files":{"a.tsx":"const n = \"./b\"; const b = require(n)\nexport default () => b\nexport const x = 1"}}'
```

`/compile` takes `{ source }` (one file) or `{ entry, files }` (a template and
the files it imports, #234), and answers with the skeleton, the runtime id, and
the template's exported `subject` or null.

In the cluster, run them from a pod in `i10-prod`, since the Service has no
route from outside.

## Moving to Cloudflare

Once the account is on Workers Paid:

```bash
cd services/template-renderer && bun run deploy
bunx wrangler secret put RENDERER_SECRET   # the same value as in Doppler
```

Point `TEMPLATE_RENDERER_URL` at the `*.workers.dev` URL, run the checks above
against it, then delete the celld pieces: the table above bar `wrangler.jsonc`,
`template-renderer.yaml`, the compose service, and the image's entry in
`.github/workflows/build.yml`.
