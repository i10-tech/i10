import { beforeEach, describe, expect, test } from "bun:test"
import { encodeShape, parseShapes, shapeFromText } from "@/lib/shapes"
import { templatesShape } from "@/lib/shapes/templates"
import { templateFolderShape } from "@/lib/shapes/template-folder"
import { templateDetailShape } from "@/lib/shapes/template-detail"
import { githubSetupShape } from "@/lib/shapes/github-setup"
import { renderLoading } from "./parity/harness"
import {
  clearSeededShapes,
  getSeededShape,
  seedShape,
} from "@/components/list/remembered-shapes"
import type {
  GithubState,
  TemplateDetail,
  TemplateFolder,
  TemplateSummary,
  TrustedTemplateRow,
} from "@/lib/types"

describe("templates shapes", () => {
  describe("templatesShape (/templates)", () => {
    const fakeTemplates: TemplateSummary[] = [
      {
        id: "t1",
        name: "welcome",
        title: "Welcome",
        folder_id: null,
        from: null,
        reply_to: null,
        preview_text: null,
        variables: [],
        kind: "tsx",
        source: "upload",
        subject: "Hello",
        published_at: null,
        version: 1,
        versions: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: "t2",
        name: "in-folder",
        title: "In Folder",
        folder_id: "f1",
        from: null,
        reply_to: null,
        preview_text: null,
        variables: [],
        kind: "tsx",
        source: "upload",
        subject: "Hello",
        published_at: null,
        version: 1,
        versions: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]

    const fakeFolders: TemplateFolder[] = [
      {
        id: "f1",
        name: "Onboarding",
        templates: 1,
        preview: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]

    const fakeGithub: GithubState = {
      configured: true,
      installations: [],
      repositories: [],
    }

    const fakeTrusted: TrustedTemplateRow[] = [
      {
        object: "trusted_template",
        id: "tr1",
        name: "receipt",
        status: "approved",
        html: null,
        text: null,
        holes: [],
        matched: 10,
        decision_reason: null,
        submitted_at: new Date().toISOString(),
        decided_at: new Date().toISOString(),
      },
    ]

    test("computes shape accurately from loaded data", () => {
      const shape = templatesShape.of({
        templates: fakeTemplates,
        folders: fakeFolders,
        github: fakeGithub,
        trusted: fakeTrusted,
        view: "table",
      })
      expect(shape).toEqual({
        templates: 1, // only root templates (folder_id === null)
        folders: 1,
        view: "table",
        github: true,
        githubInstalled: false,
        githubRepos: 0,
        trusted: 1,
      })
    })

    test("round-trips through cookie for workspace", () => {
      const shape = {
        templates: 2,
        folders: 1,
        view: "grid" as const,
        github: true,
        githubInstalled: true,
        githubRepos: 2,
        trusted: 0,
      }
      const cookies = [{ name: "i10-shape-templates", value: encodeShape("t1", shape) }]
      const text = parseShapes(cookies, "t1").templates
      expect(shapeFromText(templatesShape, text)).toEqual(shape)
      expect(parseShapes(cookies, "t2")).toEqual({})
    })

    test("a first visit draws the library, GitHub panel and reviewed list from the counts", () => {
      expect(
        templatesShape.fromCounts?.({
          templates: 1,
          templateFolders: 5,
          githubConfigured: 1,
          githubInstallations: 1,
          githubRepos: 2,
          trustedTemplates: 3,
        }),
      ).toEqual({
        templates: 1,
        folders: 5,
        view: "grid",
        github: true,
        githubInstalled: true,
        githubRepos: 2,
        trusted: 3,
      })
    })

    test("a count the API did not send stays unknown: no folders, and reviewed rows neutral", () => {
      // An API from before `templateFolders` and the GitHub and reviewed counts.
      const shape = templatesShape.fromCounts?.({ templates: 6 })
      expect(shape).toMatchObject({
        templates: 6,
        folders: 0,
        github: false,
        trusted: null,
      })
      expect(templatesShape.fromCounts?.({ domains: 1 })).toBeNull()
      expect(templatesShape.fallback.trusted).toBeNull()
    })

    test("an old cookie with plain trusted numbers still parses, and unknown round-trips", () => {
      const old = {
        templates: 2,
        folders: 0,
        view: "grid" as const,
        github: false,
        githubInstalled: false,
        githubRepos: 0,
        trusted: 0,
      }
      expect(templatesShape.parse(old)).toEqual(old)
      expect(templatesShape.parse({ ...old, trusted: null })).toEqual({
        ...old,
        trusted: null,
      })
      expect(templatesShape.parse({ ...old, trusted: -1 })).toBeNull()
    })

    test("malformed input falls back", () => {
      expect(shapeFromText(templatesShape, "{bad json")).toEqual(
        templatesShape.fallback,
      )
      expect(
        shapeFromText(templatesShape, JSON.stringify({ templates: -5, folders: 0 })),
      ).toEqual(templatesShape.fallback)
    })
  })

  describe("templateFolderShape (/templates/folder/[id])", () => {
    const folderDef = templateFolderShape("f1")

    test("uses folder-specific cookie key", () => {
      expect(folderDef.page).toBe("templates-f1")
    })

    test("computes folder template count and view", () => {
      const shape = folderDef.of({
        folderId: "f1",
        folder: {
          id: "f1",
          name: "Receipts",
          templates: 2,
          preview: [],
          created_at: "",
          updated_at: "",
        },
        templates: [
          {
            id: "t1",
            name: "r1",
            title: null,
            folder_id: "f1",
            from: null,
            reply_to: null,
            preview_text: null,
            variables: [],
            kind: "tsx",
            source: "upload",
            subject: null,
            published_at: null,
            version: 1,
            versions: 1,
            created_at: "",
            updated_at: "",
          },
          {
            id: "t2",
            name: "r2",
            title: null,
            folder_id: "f1",
            from: null,
            reply_to: null,
            preview_text: null,
            variables: [],
            kind: "tsx",
            source: "upload",
            subject: null,
            published_at: null,
            version: 1,
            versions: 1,
            created_at: "",
            updated_at: "",
          },
          {
            id: "t3",
            name: "other",
            title: null,
            folder_id: "f2",
            from: null,
            reply_to: null,
            preview_text: null,
            variables: [],
            kind: "tsx",
            source: "upload",
            subject: null,
            published_at: null,
            version: 1,
            versions: 1,
            created_at: "",
            updated_at: "",
          },
        ],
        view: "grid",
      })
      expect(shape).toEqual({
        templates: 2,
        view: "grid",
      })
    })

    test("round-trips through cookie for folder", () => {
      const shape = { templates: 5, view: "table" as const }
      const cookies = [
        { name: "i10-shape-templates-f1", value: encodeShape("t1", shape) },
      ]
      const text = parseShapes(cookies, "t1")["templates-f1"]
      expect(shapeFromText(folderDef, text)).toEqual(shape)
    })
  })

  describe("templateDetailShape (/templates/[id])", () => {
    beforeEach(() => {
      clearSeededShapes()
    })

    const sampleDetail: TemplateDetail = {
      id: "tpl-123",
      name: "order-confirmation",
      title: "Order Confirmation",
      folder_id: "f1",
      from: null,
      reply_to: null,
      preview_text: null,
      variables: [],
      kind: "tsx",
      source: "upload",
      subject: "Your order",
      html: null,
      text: null,
      published_at: new Date().toISOString(),
      version: 2,
      versions: 2,
      history: [
        {
          id: "v1",
          number: 1,
          kind: "tsx",
          subject: "Your order",
          variables: [],
          runtime: "react-email@3.0",
          path: "template.tsx",
          commit_sha: null,
          from: null,
          reply_to: null,
          preview_text: null,
          live: false,
          created_at: "",
        },
        {
          id: "v2",
          number: 2,
          kind: "tsx",
          subject: "Your order v2",
          variables: [],
          runtime: "react-email@3.0",
          path: "template.tsx",
          commit_sha: null,
          from: null,
          reply_to: null,
          preview_text: null,
          live: true,
          created_at: "",
        },
      ],
      github: null,
      created_at: "",
      updated_at: "",
    }

    test("computes detail shape correctly", () => {
      const shape = templateDetailShape.of({
        template: sampleDetail,
        tab: "versions",
      })
      expect(shape).toEqual({
        source: "upload",
        kind: "tsx",
        versions: 2,
        live: true,
        github: false,
        removed: false,
        folder: true,
        titled: true,
        tab: "versions",
      })
    })

    test("seeds and retrieves record shape", () => {
      seedShape(templateDetailShape, "tpl-123", {
        source: "github",
        kind: "tsx",
        versions: 3,
        live: true,
        github: true,
        removed: false,
        folder: false,
        titled: false,
        tab: "preview",
      })
      const seeded = getSeededShape(templateDetailShape, "tpl-123")
      expect(seeded).toEqual({
        source: "github",
        kind: "tsx",
        versions: 3,
        live: true,
        github: true,
        removed: false,
        folder: false,
        titled: false,
        tab: "preview",
      })
    })

    test("unseeded record returns fallback", () => {
      expect(getSeededShape(templateDetailShape, "tpl-unknown")).toEqual(
        templateDetailShape.fallback,
      )
    })
  })

  describe("githubSetupShape (/templates/github/setup)", () => {
    test("has empty frame shape", () => {
      expect(githubSetupShape.fallback).toEqual({})
      expect(githubSetupShape.of({})).toEqual({})
      expect(githubSetupShape.parse({})).toEqual({})
    })
  })
})

describe("the templates skeleton", () => {
  const view = {
    route: "/templates",
    pathname: "/templates",
    View: undefined as never,
    shape: templatesShape,
    cases: [],
  }
  const base = templatesShape.fallback

  test("unknown reviewed templates draw a row, never the empty state", async () => {
    const { TemplatesView } = await import("@/components/templates-view")
    const html = renderLoading({ ...view, View: TemplatesView as never }, base)
    expect(html).not.toContain("Nothing submitted yet")
  })

  test("zero reviewed templates is the empty state", async () => {
    const { TemplatesView } = await import("@/components/templates-view")
    const html = renderLoading(
      { ...view, View: TemplatesView as never },
      { ...base, trusted: 0 },
    )
    expect(html).toContain("Nothing submitted yet")
  })
})
