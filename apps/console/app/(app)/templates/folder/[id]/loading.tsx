"use client"

import * as React from "react"
import { useRouteParams } from "@/lib/target-route"
import { TemplateFolderLoading } from "@/components/template-folder-view"

/** Loading a template folder: the page's own view, drawn from the remembered shape. */
export default function Loading() {
  const params = useRouteParams()
  const raw = params?.id
  const id = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : ""
  return <TemplateFolderLoading folderId={id ?? ""} />
}
