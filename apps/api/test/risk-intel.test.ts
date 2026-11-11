import { describe, expect, it } from "bun:test"
import { layaClassify, type Fetch } from "../src/risk/intel.js"

/**
 * The content classifier's answer, read in the shape the System One API
 * documents for a `noul` question.
 *
 * The fixture follows the output schema published for Cloudflare's Clef models
 * (developers.cloudflare.com/workers-ai/models/clef/schema-output.json: a noul
 * answer is `{ type: "noul", noul: <probability the answer is yes> }`) and the
 * Laya README (`out["answers"][id]["noul"]`, "probability the answer is yes").
 */
const DOCUMENTED = {
  model: "clef-flash",
  answers: { abusive: { type: "noul", noul: 0.93 } },
  usage: { input_tokens: 412, output_tokens: 1 },
}

const answering = (body: unknown, status = 200): Fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as Fetch

const LAYA = { url: "https://laya.example/" }

describe("layaClassify", () => {
  it("reads the probability from a documented noul answer", async () => {
    expect(
      await layaClassify(LAYA, "Verify your password", answering(DOCUMENTED)),
    ).toBe(0.93)
  })

  it("says nothing when the answer carries no noul probability", async () => {
    const choiceShaped = {
      ...DOCUMENTED,
      answers: { abusive: { probabilities: { yes: 0.93 }, confidence: 0.9 } },
    }
    expect(await layaClassify(LAYA, "x", answering(choiceShaped))).toBeNull()
    expect(
      await layaClassify(
        LAYA,
        "x",
        answering({ ...DOCUMENTED, answers: { abusive: { type: "noul", noul: 7 } } }),
      ),
    ).toBeNull()
  })

  it("says nothing when the service refuses", async () => {
    expect(await layaClassify(LAYA, "x", answering({}, 503))).toBeNull()
  })
})
