import { beforeEach, describe, expect, test } from "bun:test"
import { encodeShape, parseShapes, shapeFromText } from "@/lib/shapes"
import {
  clearSeededShapes,
  getSeededShape,
  seedShape,
} from "@/components/list/remembered-shapes"
import {
  domainDetailShape,
  seedDomainShape,
  type DomainDetailData,
  type DomainDetailShape,
} from "@/lib/shapes/domain-detail"
import {
  newDomainShape,
  type NewDomainData,
  type NewDomainShape,
} from "@/lib/shapes/new-domain"
import type { DomainSummary } from "@/lib/types"

describe("domainDetailShape", () => {
  const sampleData: DomainDetailData = {
    domain: {
      object: "domain",
      id: "dom_123",
      name: "example.com",
      status: "verified",
      created_at: "2026-01-01T00:00:00Z",
      region: "us-east-1",
      delegated: true,
      records: [
        {
          type: "NS",
          name: "_domainkey.example.com",
          value: "ns1.i10.tech",
          ttl: "Auto",
          status: "verified",
          record: "NS",
        },
      ],
      open_tracking: false,
      click_tracking: false,
    },
    delegation: null,
    inspection: {
      domain: "example.com",
      nameservers: ["ns1.cloudflare.com"],
      provider: {
        slug: "cloudflare",
        name: "Cloudflare",
        kind: "host",
        canConnect: true,
        nsDelegation: true,
        oauth: true,
      },
      confidence: "exact",
      records: { txt: [], mx: [], dmarc: [] },
    },
    connectable: {
      slug: "cloudflare",
      name: "Cloudflare",
      oauth: true,
      token: true,
      scope: null,
      docs: null,
      zoneScoped: false,
    },
    connection: null,
    scopedKeys: [],
    keyImpact: [{ id: "key_1", name: "Deploy Key", keeps: [] }],
    transfer: null,
    ownEmails: ["user@example.com"],
    canManageMailboxes: true,
    mailboxAccounts: [],
    teamInboxes: [],
  }

  beforeEach(() => {
    clearSeededShapes()
  })

  test("derives correct shape from domain detail data", () => {
    const shape = domainDetailShape.of(sampleData)
    expect(shape).toEqual({
      status: "verified",
      delegated: true,
      displaced: false,
      records: 1,
      provider: true,
      connectable: true,
      delegation: false,
      keys: 1,
      added: false,
    })
  })

  test("round-trips through cookie serialization", () => {
    const shape: DomainDetailShape = {
      status: "pending",
      delegated: false,
      displaced: false,
      records: 4,
      provider: false,
      connectable: false,
      delegation: false,
      keys: 0,
      added: true,
    }
    const cookies = [
      { name: "i10-shape-domain-detail", value: encodeShape("tenant_1", shape) },
    ]
    const text = parseShapes(cookies, "tenant_1")["domain-detail"]
    expect(shapeFromText(domainDetailShape, text)).toEqual(shape)
  })

  test("parses and caps records and keys, rejects malformed values", () => {
    expect(
      domainDetailShape.parse({
        status: "pending",
        delegated: true,
        displaced: false,
        records: 99,
        provider: true,
        connectable: false,
        delegation: false,
        keys: 99,
      }),
    ).toEqual({
      status: "pending",
      delegated: true,
      displaced: false,
      records: 10,
      provider: true,
      connectable: false,
      delegation: false,
      keys: 10,
      added: false,
    })

    expect(domainDetailShape.parse(null)).toBeNull()
    expect(domainDetailShape.parse({ status: 123 })).toBeNull()
    expect(
      domainDetailShape.parse({
        status: "pending",
        delegated: "not-bool",
        displaced: false,
        records: 4,
        provider: false,
        connectable: false,
        delegation: false,
        keys: 0,
      }),
    ).toBeNull()
  })

  test("a cookie from before `added` existed still reads, as not added", () => {
    const old = {
      status: "pending",
      delegated: false,
      displaced: false,
      records: 4,
      provider: false,
      connectable: false,
      delegation: false,
      keys: 0,
    }
    expect(domainDetailShape.parse(old)).toEqual({ ...old, added: false })
  })

  test("seedDomainShape creates accurate seed from DomainSummary", () => {
    const summary: DomainSummary = {
      object: "domain",
      id: "dom_456",
      name: "hello.org",
      status: "temporary_failure",
      created_at: "2026-02-01T00:00:00Z",
      region: "eu-west-1",
      delegated: true,
      displaced_at: "2026-03-01T00:00:00Z",
    }
    const seeded = seedDomainShape(summary)
    expect(seeded).toEqual({
      status: "temporary_failure",
      delegated: true,
      displaced: true,
      records: 6,
      provider: false,
      connectable: false,
      delegation: false,
      keys: 0,
      added: false,
    })

    seedShape(domainDetailShape, summary.id, seeded)
    expect(getSeededShape(domainDetailShape, summary.id)).toEqual(seeded)
  })
})

describe("newDomainShape", () => {
  const sampleData: NewDomainData = {
    tenantId: "tenant_abc",
    restored: {
      name: "sub.domain.com",
      returnPath: "mail",
      mode: "delegate",
      advanced: false,
      step: "records",
      created: null,
      inspection: null,
    },
  }

  test("derives correct shape from restored draft", () => {
    const shape = newDomainShape.of(sampleData)
    expect(shape).toEqual({
      restored: true,
      step: "records",
    })
  })

  test("falls back when no restored draft exists", () => {
    const emptyData: NewDomainData = {
      tenantId: "tenant_abc",
      restored: null,
    }
    const shape = newDomainShape.of(emptyData)
    expect(shape).toEqual({
      restored: false,
      step: "domain",
    })
  })

  test("round-trips through cookie serialization", () => {
    const shape: NewDomainShape = {
      restored: true,
      step: "publish",
    }
    const cookies = [
      { name: "i10-shape-domains-new", value: encodeShape("tenant_1", shape) },
    ]
    const text = parseShapes(cookies, "tenant_1")["domains-new"]
    expect(shapeFromText(newDomainShape, text)).toEqual(shape)
  })

  test("validates steps and rejects unknown values", () => {
    expect(newDomainShape.parse({ restored: true, step: "domain" })).toEqual({
      restored: true,
      step: "domain",
    })
    expect(newDomainShape.parse({ restored: false, step: "invalid" })).toBeNull()
    expect(newDomainShape.parse("not-an-object")).toBeNull()
  })
})
