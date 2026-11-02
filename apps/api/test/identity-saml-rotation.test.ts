import { describe, expect, it } from "bun:test"
import type { Connection } from "../src/identity/model.js"
import { guardedFetch } from "../src/identity/oidc-fetch.js"
import { IdpUnreachable } from "../src/identity/oidc-fetch.js"
import type { IdpMetadata } from "../src/identity/saml-messages.js"
import { FORCE_REFRESH_EVERY_MS, forceRefresh } from "../src/identity/saml-refresh.js"
import { samlEngine } from "../src/identity/saml.js"
import {
  CONNECTION,
  TENANT,
  connection,
  log,
  memoryReplay,
  memorySaml,
  memoryStore,
} from "./identity-fakes.js"
import {
  ENTITY,
  assertionXml,
  b64,
  keys,
  responseXml,
  sign,
  type Keys,
} from "./saml-idp.js"

/**
 * A rotated IdP certificate: a failed signature on a connection with a
 * metadata URL re-reads the metadata once and checks the same response again.
 */

const AUTH = "https://auth.i10.localhost"
const URL_ = "https://idp.acme.test/metadata"
const oldKey = keys()
const newKey = keys()

const metadataOf = (...k: Keys[]): IdpMetadata => ({
  entityId: ENTITY,
  ssoUrl: "https://idp.acme.test/sso",
  sloUrl: null,
  sloResponseUrl: null,
  certificates: k.map((x) => x.cert),
  wantAuthnRequestsSigned: false,
})

async function world(
  options: { metadataUrl?: boolean; serves?: () => Promise<IdpMetadata> } = {},
) {
  const conn: Connection = connection({
    protocol: "saml",
    provider: "entra",
    config: {
      saml: {
        idpEntityId: ENTITY,
        ssoUrl: "https://idp.acme.test/sso",
        ...(options.metadataUrl === false ? {} : { metadataUrl: URL_ }),
      },
    },
  })
  const store = memoryStore({ connections: [conn] })
  const saml = memorySaml(store)
  await saml.saml.addCertificate(
    TENANT,
    CONNECTION,
    { ...oldKey.cert, source: "metadata" },
    null,
  )
  const replay = memoryReplay()
  const fetched: string[] = []
  const serves = options.serves ?? (async () => metadataOf(newKey))
  const engine = samlEngine({
    store: store.store,
    saml: saml.saml,
    fetch: guardedFetch({
      vet: async () => ({ ok: true, address: "93.184.216.34", family: 4 }),
    }),
    replay: replay.replay,
    forceRefresh: (c, before) =>
      forceRefresh(
        {
          store: store.store,
          saml: saml.saml,
          log,
          replay: replay.replay,
          fetchMetadata: async (url) => {
            fetched.push(url)
            return serves()
          },
        },
        c,
        before,
      ),
    authOrigin: AUTH,
    log,
  })
  const verify = (key: Keys, id = "_a1") =>
    engine.verify(store.connections.get(CONNECTION)!, {
      samlResponse: b64(
        responseXml(sign(assertionXml({ id, inResponseTo: "_req1" }), key), {
          inResponseTo: "_req1",
        }),
      ),
      inResponseTo: "_req1",
    })
  const audited = () => store.events.filter((e) => e.type === "saml.certificate_refreshed")
  return { store, saml, replay, fetched, verify, audited }
}

describe("a rotated IdP certificate", () => {
  it("refreshes the metadata once and accepts the same response", async () => {
    const w = await world()
    const done = await w.verify(newKey)
    expect(done.ok).toBe(true)
    expect(w.fetched).toEqual([URL_])
    expect(w.audited()).toHaveLength(1)
    expect(w.audited()[0]!.data).toMatchObject({
      retried: true,
      retrySucceeded: true,
      certificatesBefore: 1,
      certificatesAfter: 1,
    })
    expect(JSON.stringify(w.audited()[0])).not.toContain(newKey.cert.certificate)
  })

  it("refuses without a refresh when one ran in the last 10 minutes", async () => {
    const w = await world()
    await w.replay.replay.claim(
      `sso:saml:force-refresh:${CONNECTION}`,
      FORCE_REFRESH_EVERY_MS,
    )
    const done = await w.verify(newKey)
    expect(done).toMatchObject({ ok: false, extra: { failure: "bad_signature" } })
    expect(w.fetched).toEqual([])
    expect(w.audited()).toHaveLength(0)
  })

  it("refuses, and does not loop, when the refresh brings no new certificate", async () => {
    const w = await world({ serves: async () => metadataOf(oldKey) })
    const first = await w.verify(newKey)
    expect(first).toMatchObject({ ok: false, extra: { failure: "bad_signature" } })
    const second = await w.verify(newKey)
    expect(second.ok).toBe(false)
    expect(w.fetched).toHaveLength(1)
    expect(w.audited()[0]!.data).toMatchObject({ retried: false, retrySucceeded: false })
  })

  it("audits a retry that still fails, and the refusal stands", async () => {
    const other = keys()
    const w = await world()
    const done = await w.verify(other)
    expect(done).toMatchObject({ ok: false, extra: { failure: "bad_signature" } })
    expect(w.audited()[0]!.data).toMatchObject({ retried: true, retrySucceeded: false })
  })

  it("refuses as before with no metadata URL, and fetches nothing", async () => {
    const w = await world({ metadataUrl: false })
    const done = await w.verify(newKey)
    expect(done).toMatchObject({ ok: false, extra: { failure: "bad_signature" } })
    expect(w.fetched).toEqual([])
    expect(w.replay.seen.size).toBe(0)
  })

  it("refuses when the metadata URL cannot be read", async () => {
    const w = await world({
      serves: async () => {
        throw new IdpUnreachable("down", "network")
      },
    })
    const done = await w.verify(newKey)
    expect(done).toMatchObject({ ok: false, extra: { failure: "bad_signature" } })
    expect(w.audited()).toHaveLength(0)
  })

  it("refuses a replay of the response after the retry succeeded", async () => {
    const w = await world()
    expect((await w.verify(newKey)).ok).toBe(true)
    const again = await w.verify(newKey)
    expect(again).toMatchObject({ ok: false, extra: { failure: "replayed" } })
    expect(w.fetched).toHaveLength(1)
  })
})
