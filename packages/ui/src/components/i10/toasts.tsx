"use client"

import * as React from "react"
import {
  ToastStack,
  ToastStackProvider,
  useToastStack,
  type ToastAction,
  type ToastOptions,
  type ToastStackApi,
} from "../toast-stack/toast-stack"

/**
 * Arc's toast stack, reachable from anywhere.
 *
 * Arc raises toasts through a hook inside its provider. The apps raise them
 * from event handlers, effects and plain modules (lib/toast.ts, the auth
 * forms), the way sonner allowed. So `ToastHost` mounts Arc's provider and
 * stack once at the root and hands the stack's API to this module, and
 * `toast` below keeps sonner's call shape on top of it. Calls made before the
 * host mounts are queued and shown as soon as it does.
 *
 * Arc's rule still applies: a toast is for background work and results that
 * happen away from the control. A foreground action confirms on its button.
 */

let api: ToastStackApi | null = null
const queue: Array<(api: ToastStackApi) => void> = []

function run(fn: (api: ToastStackApi) => void) {
  if (api) fn(api)
  else queue.push(fn)
}

function Bridge() {
  const stack = useToastStack()
  React.useEffect(() => {
    api = stack
    for (const fn of queue.splice(0)) fn(stack)
    return () => {
      if (api === stack) api = null
    }
  }, [stack])
  return null
}

export function ToastHost({ children }: { children?: React.ReactNode }) {
  return (
    <ToastStackProvider>
      {children}
      <Bridge />
      <ToastStack />
    </ToastStackProvider>
  )
}

export interface ToastDetail {
  description?: string
  id?: string | number
  duration?: number
  action?: { label: string; onClick: () => void }
}

type Type = ToastOptions["type"]

function show(type: Type, title: string, detail: ToastDetail = {}): string {
  const id = detail.id === undefined ? undefined : String(detail.id)
  const action: ToastAction | undefined = detail.action
    ? { label: detail.action.label, onClick: () => detail.action?.onClick() }
    : undefined
  const options = {
    type,
    title,
    description: detail.description,
    duration: detail.duration,
    action,
  }
  // Sonner replaced a toast that reused an id; Arc morphs it in place.
  let shown = id ?? ""
  run((stack) => {
    shown = stack.toast({ ...options, id })
  })
  return shown
}

export const toast = Object.assign(
  (title: string, detail?: ToastDetail) => show("info", title, detail),
  {
    success: (title: string, detail?: ToastDetail) => show("success", title, detail),
    error: (title: string, detail?: ToastDetail) => show("error", title, detail),
    warning: (title: string, detail?: ToastDetail) => show("warning", title, detail),
    info: (title: string, detail?: ToastDetail) => show("info", title, detail),
    loading: (title: string, detail?: ToastDetail) => show("loading", title, detail),
    dismiss: (id?: string | number) =>
      run((stack) => stack.dismiss(id === undefined ? undefined : String(id))),
  },
)
