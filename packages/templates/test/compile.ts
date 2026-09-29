import { createElement, type FunctionComponent } from "react"
import { render } from "react-email"
import {
  buildProps,
  flattenPreview,
  marker,
  verifyRenders,
  type Render,
  type Verified,
} from "../src/index.js"

/**
 * The sandbox's job, done in-process for tests: three renders and the gate.
 *
 * ⚠ THE SAME SEQUENCE AS services/template-renderer, with real React Email, so
 * a test here fails for the reasons production would.
 */
export async function compile(
  Component: FunctionComponent<never>,
  preview?: unknown,
): Promise<Verified> {
  const flat = flattenPreview(preview)
  if (!flat.ok) return { ok: false, problems: [flat.error] }

  const nonceA = "abcdefghijkl"
  const nonceB = "mnopqrstuvwx"
  const renderWith = async (props: Record<string, unknown>): Promise<Render> => {
    const element = createElement(
      Component as FunctionComponent<Record<string, unknown>>,
      props,
    )
    return {
      html: await render(element),
      text: await render(element, { plainText: true }),
    }
  }

  const accessed = new Set<string>()
  const probe = new Proxy(
    buildProps(flat.variables, () => ""),
    {
      get(target, key, receiver) {
        if (typeof key === "string") accessed.add(key)
        return Reflect.get(target, key, receiver) as unknown
      },
    },
  )
  await render(createElement(() => Component(probe as never)))

  return verifyRenders({
    variables: flat.variables,
    nonceA,
    nonceB,
    a: await renderWith(buildProps(flat.variables, (_v, i) => marker(nonceA, i))),
    b: await renderWith(buildProps(flat.variables, (_v, i) => marker(nonceB, i))),
    empty: await renderWith(buildProps(flat.variables, () => "")),
    accessed: [...accessed],
  })
}
