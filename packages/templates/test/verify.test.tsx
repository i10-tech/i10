import { describe, expect, it } from "bun:test"
import { createElement, type FunctionComponent } from "react"
import { Button, Heading, Html, Link, Text, render } from "react-email"
import { fill, type Skeleton } from "../src/index.js"
import { compile } from "./compile.js"

/**
 * The upload gate against real React Email output, and the fill against real
 * renders: a filled skeleton must be byte-equal to rendering the template with
 * the same values. That equality is the whole claim of render-once.
 */

type Props = { name: string; url: string; team: { name: string } }

function Welcome({ name, url, team }: Props) {
  return (
    <Html>
      <Heading>Welcome to {team.name}</Heading>
      <Text>Hi {name}, you were invited.</Text>
      <Button href={url}>Join {team.name}</Button>
    </Html>
  )
}
Welcome.PreviewProps = {
  name: "Ada",
  url: "https://example.com/join",
  team: { name: "Acme" },
}

async function skeletonOf(
  Component: FunctionComponent<never>,
  preview: unknown,
): Promise<Skeleton> {
  const result = await compile(Component, preview)
  if (!result.ok) throw new Error(result.problems.join("\n"))
  return result.skeleton
}

describe("templates that only insert their variables", () => {
  it("fill to exactly what a render with those values produces", async () => {
    const skeleton = await skeletonOf(Welcome, Welcome.PreviewProps)
    const values = {
      name: `O'Brien <ceo> & "friends"`,
      url: "https://example.com/?a=1&b=2",
      team: { name: "Tom & Jerry" },
    }

    const filled = fill({ ...skeleton, subject: null }, values)
    if (!filled.ok) throw new Error("fill failed")

    const element = createElement(Welcome, values)
    expect(filled.filled.html).toBe(await render(element))
    expect(filled.filled.text).toBe(await render(element, { plainText: true }))
  })

  it("uppercases a value the plain text puts in a heading, as the render does", async () => {
    const skeleton = await skeletonOf(Welcome, Welcome.PreviewProps)
    const filled = fill(
      { ...skeleton, subject: null },
      {
        name: "a",
        url: "https://x.test",
        team: { name: "acme" },
      },
    )
    if (!filled.ok) throw new Error("fill failed")
    expect(filled.filled.text).toContain("WELCOME TO ACME")
  })

  it("keeps only the variables the output uses", async () => {
    const skeleton = await skeletonOf(
      ({ name }: { name: string }) => <Text>{name}</Text>,
      { name: "Ada", unused: "x" },
    )
    expect(skeleton.variables.map((v) => v.path)).toEqual(["name"])
  })

  it("blocks a javascript: URL filled into an href, as React does", async () => {
    const skeleton = await skeletonOf(
      ({ url }: { url: string }) => <Link href={url}>go</Link>,
      { url: "https://example.com" },
    )
    const filled = fill(
      { ...skeleton, subject: null },
      { url: " java\tscript:alert(1)" },
    )
    if (!filled.ok) throw new Error("fill failed")
    expect(filled.filled.html).toContain('href="#"')
  })
})

describe("templates with logic over their variables are refused", () => {
  const refused = async (Component: FunctionComponent<never>, preview: unknown) => {
    const result = await compile(Component, preview)
    expect(result.ok).toBe(false)
    return result.ok ? "" : result.problems.join("\n")
  }

  it("a transformed variable", async () => {
    expect(
      await refused(({ name }: { name: string }) => <Text>{name.toUpperCase()}</Text>, {
        name: "Ada",
      }),
    ).toContain("changed before it is inserted")
  })

  it("a sliced variable", async () => {
    expect(
      await refused(({ name }: { name: string }) => <Text>{name.slice(0, 3)}</Text>, {
        name: "Ada",
      }),
    ).toContain("changed before it is inserted")
  })

  it("a variable used as a condition", async () => {
    expect(
      await refused(
        ({ name }: { name: string }) => <Html>{name && <Text>Hi {name}</Text>}</Html>,
        { name: "Ada" },
      ),
    ).toContain("used as a condition")
  })

  it("a fallback for an empty variable", async () => {
    expect(
      await refused(({ name }: { name: string }) => <Text>Hi {name || "there"}</Text>, {
        name: "Ada",
      }),
    ).toContain("used as a condition")
  })

  it("a measured variable", async () => {
    expect(
      await refused(
        ({ name }: { name: string }) => <Text>{name.length} letters</Text>,
        {
          name: "Ada",
        },
      ),
    ).toContain("used as a condition")
  })

  it("output that changes between renders", async () => {
    let n = 0
    expect(
      await refused(
        ({ name }: { name: string }) => (
          <Text>
            {name} #{n++}
          </Text>
        ),
        { name: "Ada" },
      ),
    ).toContain("depends on a variable's value")
  })

  it("a list", async () => {
    expect(await refused(() => <Text>x</Text>, { items: ["a", "b"] })).toContain(
      "Lists are not supported yet",
    )
  })

  it("a variable read without a sample value", async () => {
    expect(
      await refused(({ name }: { name?: string }) => <Text>Hi {name}</Text>, {}),
    ).toContain("`PreviewProps` has no value")
  })

  it("a variable in a style attribute", async () => {
    expect(
      await refused(
        ({ color }: { color: string }) => <Text style={{ color }}>x</Text>,
        { color: "red" },
      ),
    ).toContain("style attribute")
  })
})
