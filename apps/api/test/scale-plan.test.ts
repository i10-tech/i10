import { describe, expect, it } from "bun:test"
import { classify } from "../scripts/scale/capture.js"
import { goQueries } from "../scripts/scale/go-sql.js"
import { siteOf } from "../scripts/scale/measure.js"
import {
  analyse,
  nestedPlan,
  percentile,
  shapeOf,
  type PlanNode,
} from "../scripts/scale/plan.js"
import { REGISTRY } from "../scripts/scale/registry.js"
import { apportion, Rng } from "../scripts/scale/rng.js"

const sizes = new Map([
  ["core.messages_2026_10", 1_000_000],
  ["core.messages_2026_11", 1_200_000],
  ["core.tenants", 20_000],
  ["core.plans", 3],
])

const node = (n: Partial<PlanNode> & { "Node Type": string }): PlanNode => ({
  "Plan Rows": 1,
  "Actual Rows": 1,
  "Actual Loops": 1,
  ...n,
})

describe("plan rules", () => {
  it("flags a sequential scan of a big table and not of a small one", () => {
    const a = analyse(
      {
        Plan: node({
          "Node Type": "Seq Scan",
          "Relation Name": "tenants",
          Schema: "core",
        }),
      },
      sizes,
    )
    expect(a.flags.join()).toContain("seq scan on core.tenants")
    const b = analyse(
      {
        Plan: node({
          "Node Type": "Seq Scan",
          "Relation Name": "plans",
          Schema: "core",
        }),
      },
      sizes,
    )
    expect(b.flags).toEqual([])
  })

  it("flags per-row subplans, disk sorts, hash spills and big underestimates", () => {
    const a = analyse(
      {
        Plan: node({
          "Node Type": "Sort",
          "Sort Space Type": "Disk",
          "Plan Rows": 10,
          "Actual Rows": 50_000,
          Plans: [
            node({
              "Node Type": "Hash Join",
              Plans: [node({ "Node Type": "Hash", "Hash Batches": 4 })],
            }),
            node({
              "Node Type": "Index Scan",
              "Parent Relationship": "SubPlan",
              "Subplan Name": "SubPlan 1",
              "Actual Loops": 5000,
            }),
          ],
        }),
      },
      sizes,
    )
    const flags = a.flags.join(" | ")
    expect(flags).toContain("sort spilled to disk")
    expect(flags).toContain("hash spilled (4 batches)")
    expect(flags).toContain("per-row subplan (SubPlan 1, 5000 loops)")
    expect(flags).toContain("underestimate")
  })

  it("folds partitions, so the same plan over different months is one shape", () => {
    const over = (months: string[]) =>
      shapeOf(
        node({
          "Node Type": "Append",
          Plans: months.map((m) =>
            node({
              "Node Type": "Index Scan",
              "Relation Name": `messages_${m}`,
              "Index Name": `messages_${m}_tenant_id_created_at_idx`,
            }),
          ),
        }),
      )
    expect(over(["2026_10", "2026_11"])).toBe(over(["2026_11"]))
  })

  it("reads auto_explain's notice", () => {
    const p = nestedPlan(
      `duration: 1.2 ms  plan:\n{"Query Text": "select 1", "Plan": {"Node Type": "Result"}}`,
    )
    expect(p?.query).toBe("select 1")
    expect(p?.root["Execution Time"]).toBe(1.2)
    expect(nestedPlan("some other notice")).toBeNull()
  })

  it("percentile is nearest rank", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10)
  })
})

describe("statement classes", () => {
  const volatile = new Set(["core.record_identity_event"])
  it("tells context, reads and writes apart", () => {
    expect(classify("select set_config('app.tenant_id', $1, true)", volatile)).toBe(
      "context",
    )
    expect(classify("select * from core.messages", volatile)).toBe("read")
    expect(classify("insert into core.messages values ($1)", volatile)).toBe("write")
    expect(
      classify(
        "with x as (update core.t set a = 1 returning *) select * from x",
        volatile,
      ),
    ).toBe("write")
    expect(classify("select core.record_identity_event($1)", volatile)).toBe("write")
    expect(
      classify("select id from core.messages for update skip locked", volatile),
    ).toBe("write")
  })
})

describe("the registry", () => {
  it("every call site still exists, so the report's file:line is current", () => {
    for (const e of REGISTRY) expect(siteOf(e)).toMatch(/:\d+$/)
  })

  it("authd's SQL is read from its Go source, not retyped", () => {
    const [accounts] = goQueries(
      "services/authd/internal/projection/postgres.go",
      "AccountsByAddress",
    )
    expect(accounts).toContain("core.mailbox_domain_refused")
    expect(accounts).toContain("FROM authd.accounts a")
    expect(
      goQueries("services/authd/internal/projection/postgres.go", "hydrate"),
    ).toHaveLength(2)
  })

  it("every entry has a low-volume or worst case besides the typical one", () => {
    for (const e of REGISTRY) expect(e.cases.length).toBeGreaterThan(0)
    expect(new Set(REGISTRY.map((e) => e.name)).size).toBe(REGISTRY.length)
  })
})

describe("the generator's arithmetic", () => {
  it("one seed gives one sequence", () => {
    const draw = (seed: number) =>
      Array.from(
        { length: 5 },
        (
          (r) => () =>
            r.next()
        )(new Rng(seed)),
      )
    expect(draw(7)).toEqual(draw(7))
    expect(draw(7)).not.toEqual(draw(8))
  })

  it("apportion sums to the total and honours the minimum, whatever the weights' scale", () => {
    const out = apportion(1000, [10, 1, 1, 0.5], 1)
    expect(out.reduce((a, b) => a + b, 0)).toBe(1000)
    expect(Math.min(...out)).toBeGreaterThanOrEqual(1)
    expect(out[0]).toBeGreaterThan(out[1]! * 5)
  })
})
