import { describe, expect, it } from "bun:test"
import { SignatureV4 } from "@smithy/signature-v4"
import {
  checkCredentials,
  parseQueueUrl,
  Sha256,
  sqsSendMessage,
} from "../src/webhooks/sqs.js"

describe("parseQueueUrl: only AWS's own SQS hosts", () => {
  it("reads a standard and a FIFO queue", () => {
    expect(
      parseQueueUrl("https://sqs.eu-west-1.amazonaws.com/123456789012/orders"),
    ).toEqual({
      region: "eu-west-1",
      account: "123456789012",
      name: "orders",
      fifo: false,
      endpoint: "https://sqs.eu-west-1.amazonaws.com",
    })
    expect(
      parseQueueUrl("https://sqs.us-gov-west-1.amazonaws.com/123456789012/o.fifo"),
    ).toMatchObject({ region: "us-gov-west-1", fifo: true })
  })

  for (const url of [
    "http://sqs.eu-west-1.amazonaws.com/123456789012/orders",
    "https://sqs.eu-west-1.amazonaws.com.evil.net/123456789012/orders",
    "https://evil.net/sqs.eu-west-1.amazonaws.com/123456789012/orders",
    "https://sqs.eu-west-1.amazonaws.com/12345/orders",
    "https://sqs.eu-west-1.amazonaws.com/123456789012/orders/extra",
    "https://eu-west-1.queue.amazonaws.com/123456789012/orders",
    "https://user@sqs.eu-west-1.amazonaws.com/123456789012/orders",
  ]) {
    it(`refuses ${url}`, () => {
      expect("error" in parseQueueUrl(url)).toBe(true)
    })
  }
})

describe("checkCredentials", () => {
  it("takes an access key pair and refuses what is not one", () => {
    expect(
      checkCredentials({
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      }).ok,
    ).toBe(true)
    expect(
      checkCredentials({
        access_key_id: "akia lower",
        secret_access_key: "x".repeat(40),
      }).ok,
    ).toBe(false)
    expect(
      checkCredentials({
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        secret_access_key: "has a space in it ok",
      }).ok,
    ).toBe(false)
  })
})

describe("signing", () => {
  // ⚠ AWS'S OWN TEST VECTOR (sigv4 test suite, "get-vanilla"), so the hash
  // adapter feeding AWS's signer is proven, not assumed.
  it("matches AWS's published get-vanilla signature", async () => {
    const signer = new SignatureV4({
      service: "service",
      region: "us-east-1",
      sha256: Sha256,
      applyChecksum: false,
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      },
    })
    const signed = await signer.sign(
      {
        method: "GET",
        protocol: "https:",
        hostname: "example.amazonaws.com",
        path: "/",
        query: {},
        headers: { host: "example.amazonaws.com" },
      },
      { signingDate: new Date("2015-08-30T12:36:00Z") },
    )
    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    )
  })

  const send = (url: string) =>
    sqsSendMessage({
      queue: parseQueueUrl(url) as Exclude<
        ReturnType<typeof parseQueueUrl>,
        { error: string }
      >,
      queueUrl: url,
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "s".repeat(40),
      },
      body: '{"id":"d1"}',
      attributes: { "webhook-id": "d1" },
      groupId: "ep-1",
      deduplicationId: "d1",
      now: new Date("2026-10-06T12:00:00Z"),
    })

  it("builds a SigV4-signed SendMessage to the queue's own host", async () => {
    const r = await send("https://sqs.eu-west-1.amazonaws.com/123456789012/orders")
    expect(r.url).toBe("https://sqs.eu-west-1.amazonaws.com/")
    expect(r.headers["x-amz-target"]).toBe("AmazonSQS.SendMessage")
    expect(r.headers.authorization).toContain(
      "Credential=AKIAIOSFODNN7EXAMPLE/20261006/eu-west-1/sqs/aws4_request",
    )
    const body = JSON.parse(r.body)
    expect(body).toEqual({
      QueueUrl: "https://sqs.eu-west-1.amazonaws.com/123456789012/orders",
      MessageBody: '{"id":"d1"}',
      MessageAttributes: { "webhook-id": { DataType: "String", StringValue: "d1" } },
    })
  })

  it("gives a FIFO queue the endpoint as its group and the delivery as its dedup id", async () => {
    const r = await send("https://sqs.eu-west-1.amazonaws.com/123456789012/orders.fifo")
    expect(JSON.parse(r.body)).toMatchObject({
      MessageGroupId: "ep-1",
      MessageDeduplicationId: "d1",
    })
  })
})
