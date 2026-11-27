import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createPrivateKey } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PgDialect } from "drizzle-orm/pg-core"
import { mailDeviceEnrolledSubject, renderMailDeviceEnrolled } from "@repo/emails"
import { createApp } from "../src/app.js"
import {
  CA_HOOK_KINDS,
  parseTokenHashes,
  type CaHookKind,
} from "../src/ca-hooks/config.js"
import {
  createEnrolldHandlers,
  ENROLLD_CALLS,
  keyedSerialDigest,
  type EnrolldCall,
  type EnrolldHandlers,
} from "../src/ca-hooks/enrolld.js"
import type { HookHandler } from "../src/ca-hooks/handlers.js"
import {
  createCaHooksFetch,
  MAX_BODY_BYTES,
  startCaHooksListener,
  type HookLog,
} from "../src/ca-hooks/listener.js"
import { loadEnv } from "../src/env.js"
import {
  createDeviceCaBundleLoader,
  decryptCmsEnvelopedData,
  encryptCmsEnvelopedData,
  parseDeviceCaBundle,
  verifyPhase4Certificate,
} from "../src/mail-devices/cms.js"
import { expirePermitsForEnrollmentsSql } from "../src/mail-devices/permits.js"
import { mailDeviceEnrolledNotifier } from "../src/mail-devices/notice.js"
import { HookDeadlineExceeded, sha256 } from "../src/mail-devices/permits.js"
import {
  classifyApplePlatform,
  parseAppleBuildMajor,
  type PlatformDecision,
} from "../src/mail-devices/platform.js"
import {
  buildInnerPayloadsPlist,
  buildSealedMobileConfig,
  DEFAULT_ACME_DIRECTORY_URL,
} from "../src/mail-devices/sealed-profile.js"
import type {
  ActiveOrgReader,
  FreshAuthReader,
  SessionVerifier,
  SsoGateReader,
} from "../src/middleware/session.js"
import type { TenantResolver } from "../src/middleware/tenant.js"
import type { ConsoleDeps } from "../src/routes/console.js"
import type { MailDeviceEnrollmentsDeps } from "../src/routes/console/deps.js"
import { goTime, throwawayCertificate } from "./support/ca-hooks.js"
import { createTestDeviceCa, type TestDeviceCa } from "./support/device-pki.js"

/**
 * Pure & route-level tests for Apple OTA mail device enrollment (#383 PR 4,
 * docs/research/mail-device-binding.md section 12 + Review 1 rules):
 *   - platform classification table (Apple silicon list, macOS build >= 23)
 *   - phase 4 certificate verification (intermediate chain, EKU, raw SAN check)
 *   - CMS EnvelopedData + sealed `.mobileconfig` decrypted by BOTH
 *     `/opt/homebrew/bin/openssl cms -decrypt` and `node:crypto`
 *   - post-seal notice email (`/account#mail-devices`)
 *   - `:3443` listener `/enrolld/*` branch, token isolation, and `ENROLLD_TOKEN_HASHES`
 *   - `/console/mail-devices/enrollments[/:id]` routes (step-up, workspace-optional)
 *   - pinned array SQL (`expirePermitsForEnrollmentsSql`)
 */

const hex = (value: string) => sha256(value).toString("hex")

function recordingLog() {
  const lines: { level: string; fields: Record<string, unknown>; message: string }[] =
    []
  const log: HookLog = {
    info: (fields, message) => lines.push({ level: "info", fields, message }),
    warn: (fields, message) => lines.push({ level: "warn", fields, message }),
    error: (fields, message) => lines.push({ level: "error", fields, message }),
  }
  return { log, lines }
}

describe("Apple platform classification rules", () => {
  it.each<[string, string, PlatformDecision]>([
    // iPhones -> ios regardless of OS build
    ["iPhone17,2", "22A3354", { ok: true, platform: "ios" }],
    ["iPhone12,1", "18A1", { ok: true, platform: "ios" }],
    ["iPhone16,2", "", { ok: true, platform: "ios" }],
    [" iPhone15,3 ", "21F79", { ok: true, platform: "ios" }],
    // iPads -> ipados regardless of OS build
    ["iPad16,6", "22B83", { ok: true, platform: "ipados" }],
    ["iPad8,1", "17F75", { ok: true, platform: "ipados" }],
    // Apple silicon Macs on macOS 14+ (build major >= 23)
    ["MacBookPro17,1", "23A344", { ok: true, platform: "macos" }],
    ["MacBookPro18,1", "23F79", { ok: true, platform: "macos" }],
    ["MacBookPro18,4", "24D70", { ok: true, platform: "macos" }],
    ["MacBookPro19,1", "25A5279m", { ok: true, platform: "macos" }],
    ["MacBookAir10,1", "23A344", { ok: true, platform: "macos" }],
    ["Macmini9,1", "24A335", { ok: true, platform: "macos" }],
    ["iMac21,1", "23C71", { ok: true, platform: "macos" }],
    ["iMac21,2", "24B83", { ok: true, platform: "macos" }],
    ["Mac13,1", "23A344", { ok: true, platform: "macos" }],
    ["Mac14,2", "24D70", { ok: true, platform: "macos" }],
    ["Mac15,6", "24G2091", { ok: true, platform: "macos" }],
    ["Mac16,1", "25A5279m", { ok: true, platform: "macos" }],
    // Intel Macs (even on macOS 14/15 builds) -> mac_not_apple_silicon
    ["MacBookPro16,1", "24D70", { ok: false, refusal: "mac_not_apple_silicon" }],
    ["MacBookPro16,4", "23F79", { ok: false, refusal: "mac_not_apple_silicon" }],
    ["MacBookPro17,2", "24D70", { ok: false, refusal: "mac_not_apple_silicon" }],
    ["MacBookAir9,1", "24D70", { ok: false, refusal: "mac_not_apple_silicon" }],
    ["MacBookAir10,2", "24D70", { ok: false, refusal: "mac_not_apple_silicon" }],
    ["Macmini8,1", "24D70", { ok: false, refusal: "mac_not_apple_silicon" }],
    ["Macmini9,2", "24D70", { ok: false, refusal: "mac_not_apple_silicon" }],
    ["iMac20,1", "24D70", { ok: false, refusal: "mac_not_apple_silicon" }],
    ["iMac20,2", "24D70", { ok: false, refusal: "mac_not_apple_silicon" }],
    ["iMacPro1,1", "24D70", { ok: false, refusal: "mac_not_apple_silicon" }],
    ["MacPro7,1", "24D70", { ok: false, refusal: "mac_not_apple_silicon" }],
    ["MacBook10,1", "24D70", { ok: false, refusal: "mac_not_apple_silicon" }],
    ["Mac12,1", "24D70", { ok: false, refusal: "mac_not_apple_silicon" }],
    // Apple silicon Macs on macOS < 14 or unparseable build -> macos_too_old
    ["Mac14,2", "22G74", { ok: false, refusal: "macos_too_old" }],
    ["MacBookPro18,3", "21H1320", { ok: false, refusal: "macos_too_old" }],
    ["MacBookAir10,1", "22A380", { ok: false, refusal: "macos_too_old" }],
    ["Macmini9,1", "14.5", { ok: false, refusal: "macos_too_old" }],
    ["iMac21,1", "", { ok: false, refusal: "macos_too_old" }],
    ["Mac15,3", "not-a-build", { ok: false, refusal: "macos_too_old" }],
    // Unsupported products
    ["AppleTV14,1", "22J357", { ok: false, refusal: "unsupported_product" }],
    ["Watch7,5", "22R349", { ok: false, refusal: "unsupported_product" }],
    ["RealityDevice14,1", "22N320", { ok: false, refusal: "unsupported_product" }],
    ["iPod9,1", "19H386", { ok: false, refusal: "unsupported_product" }],
    ["iPhone", "22A3354", { ok: false, refusal: "unsupported_product" }],
    ["MacBookPro", "24D70", { ok: false, refusal: "unsupported_product" }],
    ["Windows", "11", { ok: false, refusal: "unsupported_product" }],
    ["", "24D70", { ok: false, refusal: "unsupported_product" }],
  ])("classifies (%s, %s)", (product, version, expected) => {
    expect(classifyApplePlatform(product, version)).toEqual(expected)
  })

  it("extracts leading build majors cleanly", () => {
    expect(parseAppleBuildMajor("23A344")).toBe(23)
    expect(parseAppleBuildMajor("24D70")).toBe(24)
    expect(parseAppleBuildMajor("25A5279m")).toBe(25)
    expect(parseAppleBuildMajor("14.0")).toBeNull()
    expect(parseAppleBuildMajor("")).toBeNull()
  })
})

describe("phase 4 certificate verification and CMS sealing", () => {
  let pki: TestDeviceCa
  let otherPki: TestDeviceCa

  beforeAll(() => {
    pki = createTestDeviceCa()
    otherPki = createTestDeviceCa()
  })
  afterAll(() => {
    pki.cleanup()
    otherPki.cleanup()
  })

  it("parses both the test bundle and the real production device CA trust ConfigMap bundle", () => {
    expect(pki.bundle.roots).toHaveLength(1)
    expect(pki.bundle.intermediates).toHaveLength(1)

    // Extract bundle.pem from infra/k8s/i10/device-ca/trust.yaml and parse it.
    const trustYaml = readFileSync(
      join(import.meta.dir, "../../../infra/k8s/i10/device-ca/trust.yaml"),
      "utf8",
    )
    const parsed = Bun.YAML.parse(trustYaml) as { data: { "bundle.pem": string } }
    const prodBundle = parseDeviceCaBundle(parsed.data["bundle.pem"])
    expect(prodBundle.roots).toHaveLength(1)
    expect(prodBundle.intermediates).toHaveLength(1)

    expect(() => parseDeviceCaBundle(`${pki.bundlePem}\njunk`)).toThrow(/only PEM/)
    expect(() => parseDeviceCaBundle(pki.rootPem)).toThrow(/root and one intermediate/)
    expect(() => parseDeviceCaBundle(pki.interPem)).toThrow(/root and one intermediate/)
    const leaf = pki.issueLeaf({ subject: "/CN=C02NOTCA" })
    expect(() => parseDeviceCaBundle(`${pki.bundlePem}\n${leaf.certPem}`)).toThrow(
      /non-CA/,
    )
  })

  it("reloads the bundle file when replaced on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "i10-bundle-loader-"))
    try {
      const path = join(dir, "bundle.pem")
      const load = createDeviceCaBundleLoader(path)
      expect(load()).toBeNull()

      writeFileSync(path, pki.bundlePem)
      const first = load()
      expect(first?.roots[0]?.fingerprint256).toBe(pki.bundle.roots[0]?.fingerprint256)
      expect(load()).toBe(first)

      // Replace via write + rename (same pattern as Kubernetes ConfigMap ..data swap)
      const next = join(dir, "bundle.next.pem")
      writeFileSync(next, otherPki.bundlePem)
      Bun.spawnSync(["mv", next, path])
      const reloaded = load()
      expect(reloaded?.roots[0]?.fingerprint256).toBe(
        otherPki.bundle.roots[0]?.fingerprint256,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("accepts a valid phase 4 SCEP leaf signed by the intermediate and enforces every L1 refusal", () => {
    const valid = pki.issueLeaf({ subject: "/CN=C02PHASE4OK" })
    const ok = verifyPhase4Certificate(valid.der, pki.bundle)
    expect(ok.ok).toBe(true)
    if (!ok.ok) throw new Error("expected ok")
    expect(ok.verified.commonName).toBe("C02PHASE4OK")
    expect(ok.verified.keySha256.equals(valid.keySha256)).toBe(true)
    expect(ok.verified.certSha256.equals(valid.certSha256)).toBe(true)

    // Past expiry / before validity
    expect(
      verifyPhase4Certificate(
        valid.der,
        pki.bundle,
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ),
    ).toEqual({ ok: false, reason: "cert_not_valid_now" })
    expect(
      verifyPhase4Certificate(valid.der, pki.bundle, new Date("2020-01-01T00:00:00Z")),
    ).toEqual({ ok: false, reason: "cert_not_valid_now" })

    // Signed directly by the root (like the SCEP decrypter cert) MUST be refused.
    const rootSigned = pki.issueLeaf({
      subject: "/CN=C02ROOTSIGNED",
      signer: "root",
    })
    expect(verifyPhase4Certificate(rootSigned.der, pki.bundle)).toEqual({
      ok: false,
      reason: "cert_untrusted",
    })

    // Signed by another CA MUST be refused.
    const foreign = otherPki.issueLeaf({ subject: "/CN=C02FOREIGN" })
    expect(verifyPhase4Certificate(foreign.der, pki.bundle)).toEqual({
      ok: false,
      reason: "cert_untrusted",
    })

    // Missing EKU
    const noEku = pki.issueLeaf({
      subject: "/CN=C02NOEKU",
      extensions: ["basicConstraints=critical,CA:FALSE", "keyUsage=digitalSignature"],
    })
    expect(verifyPhase4Certificate(noEku.der, pki.bundle)).toEqual({
      ok: false,
      reason: "cert_bad_eku",
    })

    // clientAuth only, or emailProtection + clientAuth
    const clientAuthOnly = pki.issueLeaf({
      subject: "/CN=C02CLIENTAUTH",
      extensions: ["basicConstraints=critical,CA:FALSE", "extendedKeyUsage=clientAuth"],
    })
    expect(verifyPhase4Certificate(clientAuthOnly.der, pki.bundle)).toEqual({
      ok: false,
      reason: "cert_bad_eku",
    })
    const bothEkUs = pki.issueLeaf({
      subject: "/CN=C02BOTHEKU",
      extensions: [
        "basicConstraints=critical,CA:FALSE",
        "extendedKeyUsage=emailProtection,clientAuth",
      ],
    })
    expect(verifyPhase4Certificate(bothEkUs.der, pki.bundle)).toEqual({
      ok: false,
      reason: "cert_bad_eku",
    })

    // Any SAN extension (DNS, email, or otherName permanentIdentifier) MUST be refused.
    const withDnsSan = pki.issueLeaf({
      subject: "/CN=C02DNSSAN",
      extensions: [
        "basicConstraints=critical,CA:FALSE",
        "extendedKeyUsage=emailProtection",
        "subjectAltName=DNS:mail.i10.tech",
      ],
    })
    expect(verifyPhase4Certificate(withDnsSan.der, pki.bundle)).toEqual({
      ok: false,
      reason: "cert_has_san",
    })
    const withOtherNameSan = pki.issueLeaf({
      subject: "/CN=C02OTHERNAME",
      extensions: [
        "basicConstraints=critical,CA:FALSE",
        "extendedKeyUsage=emailProtection",
        "subjectAltName=otherName:1.3.6.1.5.5.7.8.3;SEQUENCE:perm_id",
        "[perm_id]",
        "identifierValue=UTF8:C02OTHERNAME",
      ],
    })
    expect(verifyPhase4Certificate(withOtherNameSan.der, pki.bundle)).toEqual({
      ok: false,
      reason: "cert_has_san",
    })

    // Non-RSA (ECDSA) leaf
    const ecLeaf = pki.issueLeaf({ subject: "/CN=C02ECDSA", keyType: "ec" })
    expect(verifyPhase4Certificate(ecLeaf.der, pki.bundle)).toEqual({
      ok: false,
      reason: "cert_not_rsa",
    })

    // CA:TRUE leaf
    const caLeaf = pki.issueLeaf({
      subject: "/CN=C02CA",
      extensions: [
        "basicConstraints=critical,CA:TRUE",
        "extendedKeyUsage=emailProtection",
      ],
    })
    expect(verifyPhase4Certificate(caLeaf.der, pki.bundle)).toEqual({
      ok: false,
      reason: "cert_is_ca",
    })

    // Bad CN (spaces) and malformed DER
    const badCn = pki.issueLeaf({ subject: "/CN=bad serial with spaces" })
    expect(verifyPhase4Certificate(badCn.der, pki.bundle)).toEqual({
      ok: false,
      reason: "cert_bad_cn",
    })
    expect(verifyPhase4Certificate(Buffer.from("not-der"), pki.bundle)).toEqual({
      ok: false,
      reason: "invalid_cert_der",
    })
  })

  it("seals CMS EnvelopedData that decrypts identically with openssl cms -decrypt AND node:crypto", () => {
    const leaf = pki.issueLeaf({ subject: "/CN=C02SEALTEST1" })
    const checked = verifyPhase4Certificate(leaf.der, pki.bundle)
    if (!checked.ok) throw new Error(`unexpected verify failure: ${checked.reason}`)
    const recipient = {
      publicKey: checked.verified.cert.publicKey,
      issuerDer: checked.verified.issuerDer,
      serialNumberDer: checked.verified.serialNumberDer,
    }

    const plaintext = Buffer.from("Hello i10 sealed payload\n".repeat(40), "utf8")
    const cms1 = encryptCmsEnvelopedData(plaintext, recipient)
    const cms2 = encryptCmsEnvelopedData(plaintext, recipient)
    expect(cms1.equals(cms2)).toBe(false)

    // 1. Decrypt with OpenSSL CLI (`/opt/homebrew/bin/openssl cms -decrypt`)
    const opensslOut = pki.decryptCmsWithOpenssl(cms1, leaf)
    expect(opensslOut.equals(plaintext)).toBe(true)

    // 2. Decrypt and parse back with node:crypto (`decryptCmsEnvelopedData`)
    const privateKey = createPrivateKey(leaf.keyPem)
    const nodeOut1 = decryptCmsEnvelopedData(cms1, privateKey)
    const nodeOut2 = decryptCmsEnvelopedData(cms2, privateKey)
    expect(nodeOut1.plaintext.equals(plaintext)).toBe(true)
    expect(nodeOut2.plaintext.equals(plaintext)).toBe(true)
    expect(nodeOut1.issuerDer.equals(checked.verified.issuerDer)).toBe(true)
    expect(nodeOut1.serialNumberDer.equals(checked.verified.serialNumberDer)).toBe(true)
    expect(nodeOut1.iv).toHaveLength(16)
    expect(nodeOut1.iv.equals(nodeOut2.iv)).toBe(false)
  })

  it("builds sealed .mobileconfig profiles for iPhone, iPad, and Mac with proper scope, identifiers and ACME payload", () => {
    const leaf = pki.issueLeaf({ subject: "/CN=C02MACSEAL99" })
    const checked = verifyPhase4Certificate(leaf.der, pki.bundle)
    if (!checked.ok) throw new Error(`unexpected verify failure: ${checked.reason}`)
    const recipient = {
      publicKey: checked.verified.cert.publicKey,
      issuerDer: checked.verified.issuerDer,
      serialNumberDer: checked.verified.serialNumberDer,
    }
    const privateKey = createPrivateKey(leaf.keyPem)
    const deviceCode = `i10dc1.${"0".repeat(32)}.${"A".repeat(43)}`
    const acmeNonce = "acme-nonce-0123456789ab"

    const extractEncryptedDer = (xml: string): Buffer => {
      const m = /<key>EncryptedPayloadContent<\/key>\s*<data>([^<]+)<\/data>/.exec(xml)
      if (!m?.[1]) throw new Error("missing EncryptedPayloadContent")
      return Buffer.from(m[1], "base64")
    }

    // 1. iPhone -> PayloadScope System, NO ACME payload, secret never in outer XML
    const iosInput = {
      deviceId: "019ab100-0000-7000-8000-000000000001",
      email: "ada@acme.com",
      platform: "ios" as const,
      serial: "F2LIPHONE001",
      deviceCode,
      imapHost: "mail.i10.tech",
      imapPort: 993,
      smtpHost: "mail.i10.tech",
      smtpPort: 465,
      organization: "i10",
    }
    const iosProfile = buildSealedMobileConfig(iosInput, recipient).toString("utf8")
    expect(iosProfile).toContain("<key>PayloadScope</key>\n\t<string>System</string>")
    expect(iosProfile).toContain(
      "<string>tech.i10.mail-device.019ab100-0000-7000-8000-000000000001</string>",
    )
    expect(iosProfile).not.toContain(deviceCode)
    expect(iosProfile).not.toContain("<key>PayloadContent</key>")

    const iosCmsDer = extractEncryptedDer(iosProfile)
    const iosInnerOpenssl = pki.decryptCmsWithOpenssl(iosCmsDer, leaf).toString("utf8")
    const iosInnerNode = decryptCmsEnvelopedData(
      iosCmsDer,
      privateKey,
    ).plaintext.toString("utf8")
    expect(iosInnerOpenssl).toBe(iosInnerNode)
    expect(iosInnerOpenssl).toBe(buildInnerPayloadsPlist(iosInput))
    expect(iosInnerOpenssl).toContain(`<string>${deviceCode}</string>`)
    expect(iosInnerOpenssl).toContain(
      "<key>OutgoingPasswordSameAsIncomingPassword</key>\n\t\t<true/>",
    )
    expect(iosInnerOpenssl).not.toContain("com.apple.security.acme")

    // 2. iPad -> PayloadScope System, NO ACME payload
    const ipadProfile = buildSealedMobileConfig(
      {
        ...iosInput,
        deviceId: "019ab100-0000-7000-8000-000000000002",
        platform: "ipados",
      },
      recipient,
    ).toString("utf8")
    expect(ipadProfile).toContain("<key>PayloadScope</key>\n\t<string>System</string>")

    // 3. Mac -> PayloadScope User, includes ACME payload with CN=serial & OU=nonce
    const macInput = {
      ...iosInput,
      deviceId: "019ab100-0000-7000-8000-000000000003",
      platform: "macos" as const,
      serial: "C02MACSEAL99",
      acmeNonce,
    }
    const macProfile = buildSealedMobileConfig(macInput, recipient).toString("utf8")
    expect(macProfile).toContain("<key>PayloadScope</key>\n\t<string>User</string>")
    expect(macProfile).not.toContain(deviceCode)
    expect(macProfile).not.toContain(acmeNonce)

    const macCmsDer = extractEncryptedDer(macProfile)
    const macInnerOpenssl = pki.decryptCmsWithOpenssl(macCmsDer, leaf).toString("utf8")
    expect(macInnerOpenssl).toBe(
      decryptCmsEnvelopedData(macCmsDer, privateKey).plaintext.toString("utf8"),
    )
    expect(macInnerOpenssl).toContain("com.apple.security.acme")
    expect(macInnerOpenssl).toContain(`<string>${DEFAULT_ACME_DIRECTORY_URL}</string>`)
    expect(macInnerOpenssl).toContain(
      "<key>ClientIdentifier</key>\n\t\t<string>C02MACSEAL99</string>",
    )
    expect(macInnerOpenssl).toContain(
      "<string>CN</string>\n\t\t\t\t\t<string>C02MACSEAL99</string>",
    )
    expect(macInnerOpenssl).toContain(
      `<string>OU</string>\n\t\t\t\t\t<string>${acmeNonce}</string>`,
    )
    expect(macInnerOpenssl).toContain(
      "<key>KeyType</key>\n\t\t<string>ECSECPrimeRandom</string>",
    )
    expect(macInnerOpenssl).toContain("<key>KeySize</key>\n\t\t<integer>384</integer>")
    expect(macInnerOpenssl).toContain("<key>HardwareBound</key>\n\t\t<true/>")
    expect(macInnerOpenssl).toContain("<key>Attest</key>\n\t\t<true/>")
    expect(macInnerOpenssl).toContain("<string>1.3.6.1.5.5.7.3.2</string>")

    // Re-enrollment with a new deviceId yields distinct PayloadIdentifier + PayloadUUID.
    const mac2Profile = buildSealedMobileConfig(
      { ...macInput, deviceId: "019ab100-0000-7000-8000-000000000004" },
      recipient,
    ).toString("utf8")
    const uuidOf = (xml: string) =>
      /<key>PayloadUUID<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1]
    expect(uuidOf(macProfile)).not.toBe(uuidOf(mac2Profile))

    // Mac without acmeNonce throws
    expect(() =>
      buildInnerPayloadsPlist({ ...macInput, acmeNonce: undefined }),
    ).toThrow(/acmeNonce/)
  })
})

describe("post-seal notice email", () => {
  it("links to /account#mail-devices in both the notifier and preview props", async () => {
    const templateSrc = readFileSync(
      join(
        import.meta.dir,
        "../../../packages/emails/src/templates/mail-device-enrolled.tsx",
      ),
      "utf8",
    )
    expect(templateSrc).toContain('url: "https://dash.i10.tech/account#mail-devices"')
    expect(templateSrc).not.toContain("dash.i10.tech/mail-devices")

    const sent: {
      to: string
      subject: string
      html: string
      text?: string
      idempotencyKey: string
    }[] = []
    const notify = mailDeviceEnrolledNotifier({
      sender: {
        send: async (msg) => {
          sent.push(msg)
        },
      },
      consoleUrl: "https://dash.i10.tech/",
    })

    await notify({
      email: "ada@acme.com",
      deviceId: "019ab100-0000-7000-8000-000000000099",
      platform: "macos",
      model: "Mac14,2",
      serialLast4: "9X4K",
    })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      to: "ada@acme.com",
      subject: mailDeviceEnrolledSubject("Mac14,2"),
      idempotencyKey: "mail-device-enrolled:019ab100-0000-7000-8000-000000000099",
    })
    expect(sent[0]!.html).toContain("https://dash.i10.tech/account#mail-devices")
    expect(sent[0]!.html).toContain("Mac14,2")
    expect(sent[0]!.html).toContain("9X4K")
    expect(sent[0]!.text).toContain("https://dash.i10.tech/account#mail-devices")

    const rendered = await renderMailDeviceEnrolled({
      email: "ada@acme.com",
      model: "iPhone16,2",
      serialLast4: "9X4K",
      url: "https://dash.i10.tech/account#mail-devices",
    })
    expect(rendered.html).toContain("https://dash.i10.tech/account#mail-devices")
  })
})

describe("ENROLLD_TOKEN_HASHES env and :3443 listener branch", () => {
  const CA_TOKEN = "ca-relay-token-0123456789abcdef01"
  const ENROLLD_TOKEN = "enrolld-bearer-token-0123456789ab"
  const ENROLLD_ROTATED = "enrolld-bearer-token-rotated-9876"
  const IDS = {
    "acme-authorize": "wh-acme-authorize",
    "scep-challenge": "wh-scep-challenge",
    "scep-authorize": "wh-scep-authorize",
    "scep-notify": "wh-scep-notify",
  } as const satisfies Record<CaHookKind, string>
  const NOW = new Date("2026-11-27T02:00:00Z")

  const baseEnv: NodeJS.ProcessEnv = {
    DATABASE_URL: "postgres://i10_api:pw@localhost:5432/i10",
    REDIS_URL: "redis://localhost:6379",
    CLERK_WEBHOOK_SECRET: "whsec_test",
    CLERK_SECRET_KEY: "sk_test_abc",
    MAIL_DOMAINS: "i10.tech",
    SES_CONFIGURATION_SET: "i10-events",
  }

  it("parses ENROLLD_TOKEN_HASHES independently of CA_HOOK_* and refuses malformed values without quoting them", () => {
    const empty = loadEnv(baseEnv)
    expect(empty.ENROLLD_TOKEN_HASHES).toBeUndefined()
    expect(empty.DEVICE_CA_BUNDLE_FILE).toBe("/etc/i10/device-ca/bundle.pem")

    const withEnrolld = loadEnv({
      ...baseEnv,
      ENROLLD_TOKEN_HASHES: `${hex(ENROLLD_TOKEN)},${hex(ENROLLD_ROTATED)}`,
      DEVICE_CA_BUNDLE_FILE: "/custom/bundle.pem",
    })
    expect(withEnrolld.ENROLLD_TOKEN_HASHES?.map((b) => b.toString("hex"))).toEqual([
      hex(ENROLLD_TOKEN),
      hex(ENROLLD_ROTATED),
    ])
    expect(withEnrolld.DEVICE_CA_BUNDLE_FILE).toBe("/custom/bundle.pem")

    const secretish = "bad-enrolld-secret-value-never-log"
    let message = ""
    try {
      loadEnv({ ...baseEnv, ENROLLD_TOKEN_HASHES: secretish })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("ENROLLD_TOKEN_HASHES")
    expect(message).not.toContain(secretish)
  })

  it("refuses an ENROLLD_TOKEN_HASHES entry that is also a CA hook token", () => {
    const hooks = {
      ...baseEnv,
      CA_HOOK_TOKEN_HASHES: hex(CA_TOKEN),
      CA_HOOK_WEBHOOK_IDS: Object.entries(IDS)
        .map(([kind, id]) => `${kind}=${id}`)
        .join(","),
      CA_INTERMEDIATE_NOT_AFTER: "2027-11-26T00:00:00Z",
    }
    expect(() =>
      loadEnv({
        ...hooks,
        ENROLLD_TOKEN_HASHES: `${hex(ENROLLD_TOKEN)},${hex(CA_TOKEN)}`,
      }),
    ).toThrow("must share no entry with CA_HOOK_TOKEN_HASHES")
    expect(
      loadEnv({ ...hooks, ENROLLD_TOKEN_HASHES: hex(ENROLLD_TOKEN) })
        .ENROLLD_TOKEN_HASHES,
    ).toHaveLength(1)
  })

  function buildFetch(options: {
    withEnrolld?: boolean
    enrolldHandlers?: Partial<EnrolldHandlers>
    timeoutMs?: number
  }) {
    const { log, lines } = recordingLog()
    const caHandlers = Object.fromEntries(
      CA_HOOK_KINDS.map((kind): [CaHookKind, HookHandler] => [
        kind,
        async () => ({ allow: true, outcome: "allowed" }),
      ]),
    ) as Record<CaHookKind, HookHandler>
    const enrolldCalls: { call: EnrolldCall; body: unknown }[] = []
    const defaultEnrolld: EnrolldHandlers = {
      peek: async (body) => {
        enrolldCalls.push({ call: "peek", body })
        return { outcome: "live", body: { live: true } }
      },
      attest: async (body) => {
        enrolldCalls.push({ call: "attest", body })
        return {
          outcome: "scep",
          logFields: {
            product: "iPhone17,2",
            serialHash: keyedSerialDigest("F2LSECRET"),
          },
          body: {
            outcome: "scep",
            serial: "F2LSECRET",
            challenge: "secret-challenge-xyz",
          },
        }
      },
      finish: async (body) => {
        enrolldCalls.push({ call: "finish", body })
        return { outcome: "sealed", body: { outcome: "sealed", profile: "AAAA" } }
      },
    }
    const fetch = createCaHooksFetch({
      tokenHashes: parseTokenHashes(hex(CA_TOKEN)),
      webhookIds: IDS,
      handlers: caHandlers,
      ...(options.withEnrolld
        ? {
            enrolld: {
              tokenHashes: parseTokenHashes(
                `${hex(ENROLLD_TOKEN)},${hex(ENROLLD_ROTATED)}`,
              ),
              handlers: { ...defaultEnrolld, ...options.enrolldHandlers },
            },
          }
        : {}),
      log,
      now: () => NOW,
      timeoutMs: options.timeoutMs,
    })
    return { fetch, lines, enrolldCalls }
  }

  const enrolldReq = (
    call: string,
    init: { method?: string; token?: string | null; body?: string } = {},
  ) => {
    const headers = new Headers({ "content-type": "application/json" })
    if (init.token !== null) {
      headers.set("authorization", `Bearer ${init.token ?? ENROLLD_TOKEN}`)
    }
    return new Request(`https://hooks.test/enrolld/${call}`, {
      method: init.method ?? "POST",
      headers,
      body:
        init.method === "GET"
          ? undefined
          : (init.body ?? JSON.stringify({ token: "tok" })),
    })
  }

  it("returns bare 404 on /enrolld/* while keeping CA hooks working when ENROLLD_TOKEN_HASHES is unset", async () => {
    const { fetch } = buildFetch({ withEnrolld: false })
    for (const call of ENROLLD_CALLS) {
      const res = await fetch(enrolldReq(call))
      expect(res.status).toBe(404)
      expect(await res.text()).toBe("")
    }
    // CA hooks keep serving normally.
    const caRes = await fetch(
      new Request("https://hooks.test/scep-notify", {
        method: "POST",
        headers: {
          authorization: `Bearer ${CA_TOKEN}`,
          "x-smallstep-webhook-id": IDS["scep-notify"],
        },
        body: JSON.stringify({ timestamp: goTime(NOW) }),
      }),
    )
    expect(caRes.status).toBe(200)
    expect(await caRes.json()).toEqual({ allow: true })
  })

  it("enforces separate tokens, rotation, bounds, timeouts, and zero secret logging on /enrolld/*", async () => {
    const { fetch, lines, enrolldCalls } = buildFetch({ withEnrolld: true })

    // Both rotated enrolld tokens succeed on /enrolld/*.
    const r1 = await fetch(enrolldReq("peek", { token: ENROLLD_TOKEN }))
    expect(r1.status).toBe(200)
    expect(await r1.json()).toEqual({ live: true })

    const r2 = await fetch(enrolldReq("attest", { token: ENROLLD_ROTATED }))
    expect(r2.status).toBe(200)
    expect(await r2.json()).toEqual({
      outcome: "scep",
      serial: "F2LSECRET",
      challenge: "secret-challenge-xyz",
    })

    const r3 = await fetch(enrolldReq("finish", { token: ENROLLD_TOKEN }))
    expect(r3.status).toBe(200)
    expect(await r3.json()).toEqual({ outcome: "sealed", profile: "AAAA" })

    // Cross-token isolation: CA token CANNOT open /enrolld/*; enrolld token CANNOT open CA hooks.
    expect((await fetch(enrolldReq("peek", { token: CA_TOKEN }))).status).toBe(404)
    expect(
      (
        await fetch(
          new Request("https://hooks.test/acme-authorize", {
            method: "POST",
            headers: {
              authorization: `Bearer ${ENROLLD_TOKEN}`,
              "x-smallstep-webhook-id": IDS["acme-authorize"],
            },
            body: JSON.stringify({ timestamp: goTime(NOW) }),
          }),
        )
      ).status,
    ).toBe(404)

    // Missing/wrong token, bad method, query string, unknown path, bad JSON, oversize body -> bare 404.
    for (const req of [
      enrolldReq("peek", { token: null }),
      enrolldReq("peek", { token: "wrong-enrolld-token-1234567890" }),
      enrolldReq("peek", { method: "GET" }),
      enrolldReq("peek?x=1"),
      enrolldReq("unknown"),
      enrolldReq("peek", { body: "not-json" }),
      enrolldReq("peek", { body: JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) }) }),
    ]) {
      const res = await fetch(req)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe("")
    }
    expect(enrolldCalls).toHaveLength(3)

    // Logs must never contain tokens, challenges, codes, or raw serials.
    const written = JSON.stringify(lines)
    for (const secret of [
      ENROLLD_TOKEN,
      ENROLLD_ROTATED,
      CA_TOKEN,
      "secret-challenge-xyz",
      "F2LSECRET",
      "Bearer",
    ]) {
      expect(written).not.toContain(secret)
    }

    // Timeout / deadline -> 503; unexpected error -> 500 without leaking error message.
    const failing = buildFetch({
      withEnrolld: true,
      timeoutMs: 25,
      enrolldHandlers: {
        peek: async () => {
          throw new HookDeadlineExceeded()
        },
        attest: async () => {
          throw Object.assign(new Error(`boom ${ENROLLD_TOKEN} F2LSECRET`), {
            code: "08006",
          })
        },
        finish: () => new Promise(() => {}),
      },
    })
    expect((await failing.fetch(enrolldReq("peek"))).status).toBe(503)
    expect((await failing.fetch(enrolldReq("attest"))).status).toBe(500)
    expect((await failing.fetch(enrolldReq("finish"))).status).toBe(503)
    const errLogs = JSON.stringify(failing.lines)
    expect(errLogs).not.toContain(ENROLLD_TOKEN)
    expect(errLogs).not.toContain("F2LSECRET")
    expect(errLogs).toContain("08006")
  })

  it("starts over TLS when ENROLLD_TOKEN_HASHES is unset and keeps serving CA hooks while /enrolld/* returns 404", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i10-enrolld-tls-"))
    const tls = throwawayCertificate()
    writeFileSync(join(dir, "tls.crt"), tls.certPem)
    writeFileSync(join(dir, "tls.key"), tls.keyPem)
    const { log } = recordingLog()
    let builtEnrolld = false
    const started = startCaHooksListener(
      {
        port: 0,
        certFile: join(dir, "tls.crt"),
        keyFile: join(dir, "tls.key"),
        tokenHashes: parseTokenHashes(hex(CA_TOKEN)),
        webhookIds: IDS,
        intermediateNotAfter: new Date("2036-11-26T00:00:00Z"),
        enrolldTokenHashes: undefined,
      },
      () =>
        Object.fromEntries(
          CA_HOOK_KINDS.map((k): [CaHookKind, HookHandler] => [
            k,
            async () => ({ allow: true, outcome: "allowed" }),
          ]),
        ) as Record<CaHookKind, HookHandler>,
      log,
      () => {
        builtEnrolld = true
        throw new Error(
          "must not build enrolld handlers when ENROLLD_TOKEN_HASHES is unset",
        )
      },
    )
    expect(started).not.toBeNull()
    expect(builtEnrolld).toBe(false)
    try {
      const caRes = await fetch(`https://127.0.0.1:${started!.port}/scep-notify`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${CA_TOKEN}`,
          "x-smallstep-webhook-id": IDS["scep-notify"],
        },
        body: JSON.stringify({ timestamp: goTime(new Date()) }),
        tls: { rejectUnauthorized: false },
      })
      expect(caRes.status).toBe(200)

      const enrRes = await fetch(`https://127.0.0.1:${started!.port}/enrolld/peek`, {
        method: "POST",
        headers: { authorization: `Bearer ${ENROLLD_TOKEN}` },
        body: JSON.stringify({ token: "abc" }),
        tls: { rejectUnauthorized: false },
      })
      expect(enrRes.status).toBe(404)
    } finally {
      await started!.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("accepts null or omitted optional fields in enrolld handlers and never fails finish on notice error", async () => {
    const { log, lines } = recordingLog()
    const handlers = createEnrolldHandlers({
      db: {
        transaction: async () => {
          throw new Error("should not reach db for bad_body")
        },
      } as never,
      keys: null,
      deviceCaBundle: () => null,
      imapHost: "mail.i10.tech",
      imapPort: 993,
      smtpHost: "mail.i10.tech",
      smtpPort: 465,
      organization: "i10",
      log,
    })

    expect(
      await handlers.peek({ token: "" }, NOW, new Date(NOW.getTime() + 4000)),
    ).toEqual({ outcome: "bad_body", body: { live: false } })
    expect(
      await handlers.attest({ token: "t" }, NOW, new Date(NOW.getTime() + 4000)),
    ).toEqual({ outcome: "bad_body", body: { outcome: "refused", reason: "bad_body" } })
    expect(
      await handlers.finish(
        { certDer: "not base64!!!" },
        NOW,
        new Date(NOW.getTime() + 4000),
      ),
    ).toEqual({ outcome: "bad_body", body: { outcome: "refused", reason: "bad_body" } })
    expect(lines).toHaveLength(0)
  })

  it.each([
    ["a CR/LF in product", { product: "iPhone17,2\r\nBcc: x@y" }],
    ["a CR/LF in version", { version: "22A3354\n" + "X: y" }],
    ["a control character in the device name", { deviceName: "Ada\r\nBcc: x@y" }],
    ["a non-ASCII product", { product: "iPhone 17,2" }],
  ])("refuses an attest claim carrying %s before any database call", async (_, bad) => {
    const handlers = createEnrolldHandlers({
      db: {
        transaction: async () => {
          throw new Error("should not reach db for bad_body")
        },
      } as never,
      keys: null,
      deviceCaBundle: () => null,
      imapHost: "mail.i10.tech",
      imapPort: 993,
      smtpHost: "mail.i10.tech",
      smtpPort: 465,
      organization: "i10",
      log: recordingLog().log,
    })
    const body = {
      token: "t",
      udid: "00008140-001A2B3C4D5E6F70",
      serial: "FRJ49GN63F",
      product: "iPhone17,2",
      version: "22A3354",
      deviceName: "Ada's iPhone",
      model: null,
      appleSignerSha256: "ab".repeat(32),
      ...bad,
    }
    expect(await handlers.attest(body, NOW, new Date(NOW.getTime() + 4000))).toEqual({
      outcome: "bad_body",
      body: { outcome: "refused", reason: "bad_body" },
    })
  })
})

describe("console routes /console/mail-devices/enrollments[/:id]", () => {
  const TENANT = "11111111-1111-4111-8111-111111111111"
  const ENROLLMENT_ID = "019ab100-0000-7000-8000-000000000010"
  const DEVICE_ID = "019ab100-0000-7000-8000-000000000020"
  const BEARER = { Authorization: "Bearer stub" }
  const EXPIRES = new Date("2026-11-27T02:15:00.000Z")

  const sessions: SessionVerifier = {
    verify: async () => ({ status: "signed-in", userId: "user_ada" }),
  }
  const tenants: TenantResolver = { resolve: async () => TENANT }
  const fresh: FreshAuthReader = async () => ({ status: "fresh" })
  const stale: FreshAuthReader = async () => ({ status: "stale" })

  function makeApp(options: {
    freshAuth?: FreshAuthReader
    activeOrg?: ActiveOrgReader
    tenants?: TenantResolver
    mailDeviceEnrollments?: MailDeviceEnrollmentsDeps
    ssoGate?: SsoGateReader
  }) {
    return createApp({
      ...(options.ssoGate ? { ssoGate: options.ssoGate } : {}),
      console: {
        sessions,
        tenants: options.tenants ?? tenants,
        ...(options.activeOrg ? { activeOrg: options.activeOrg } : {}),
        ...(options.freshAuth ? { freshAuth: options.freshAuth } : {}),
        ...(options.mailDeviceEnrollments
          ? { mailDeviceEnrollments: options.mailDeviceEnrollments }
          : {}),
        queries: {} as ConsoleDeps["queries"],
        usage: {} as ConsoleDeps["usage"],
        onboarding: {} as ConsoleDeps["onboarding"],
        profile: {} as ConsoleDeps["profile"],
        marketing: {} as ConsoleDeps["marketing"],
        log: { error: () => {}, warn: () => {} },
      },
    })
  }

  const stubDeps = (
    overrides: Partial<MailDeviceEnrollmentsDeps> = {},
  ): MailDeviceEnrollmentsDeps => ({
    mailboxTenant: async () => ({ tenantId: TENANT }),
    create: async () => ({
      ok: true,
      id: ENROLLMENT_ID,
      url: "https://ca.i10.tech/enroll/apple/tok123",
      expiresAt: EXPIRES,
    }),
    get: async ({ id, clerkUserId }) =>
      id === ENROLLMENT_ID && clerkUserId === "user_ada"
        ? {
            id: ENROLLMENT_ID,
            status: "sealed",
            expiresAt: EXPIRES,
            refusal: null,
            platform: "macos",
            model: "Mac14,2",
            deviceName: "Ada's MacBook Air",
            deviceId: DEVICE_ID,
            needsMailSetup: true,
          }
        : null,
    cancel: async ({ id, clerkUserId }) =>
      id === ENROLLMENT_ID && clerkUserId === "user_ada" ? "cancelled" : "not_found",
    ...overrides,
  })

  it("POST requires fresh auth (403 stale, 501 unwired) and returns 201 with Cache-Control: no-store", async () => {
    const staleRes = await makeApp({
      freshAuth: stale,
      mailDeviceEnrollments: stubDeps(),
    }).request("/console/mail-devices/enrollments", {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: "{}",
    })
    expect(staleRes.status).toBe(403)
    expect(await staleRes.json()).toMatchObject({
      clerk_error: { reason: "reverification-error" },
    })

    const noFreshRes = await makeApp({
      mailDeviceEnrollments: stubDeps(),
    }).request("/console/mail-devices/enrollments", {
      method: "POST",
      headers: BEARER,
      body: "{}",
    })
    expect(noFreshRes.status).toBe(501)

    const okRes = await makeApp({
      freshAuth: fresh,
      mailDeviceEnrollments: stubDeps(),
    }).request("/console/mail-devices/enrollments", {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: "{}",
    })
    expect(okRes.status).toBe(201)
    expect(okRes.headers.get("cache-control")).toBe("no-store")
    expect(await okRes.json()).toEqual({
      id: ENROLLMENT_ID,
      url: "https://ca.i10.tech/enroll/apple/tok123",
      expiresAt: EXPIRES.toISOString(),
    })

    // Empty body is also accepted; invalid JSON or array is 422.
    const emptyBodyRes = await makeApp({
      freshAuth: fresh,
      mailDeviceEnrollments: stubDeps(),
    }).request("/console/mail-devices/enrollments", {
      method: "POST",
      headers: BEARER,
    })
    expect(emptyBodyRes.status).toBe(201)

    for (const badBody of ["[1,2]", '"str"', "{bad"]) {
      const badRes = await makeApp({
        freshAuth: fresh,
        mailDeviceEnrollments: stubDeps(),
      }).request("/console/mail-devices/enrollments", {
        method: "POST",
        headers: { ...BEARER, "content-type": "application/json" },
        body: badBody,
      })
      expect(badRes.status).toBe(422)
    }
  })

  it("works without an active workspace (Review 1: i10.tech mailboxes have no workspace)", async () => {
    const noOrg: ActiveOrgReader = async () => ({ status: "personal" })
    const noTenant: TenantResolver = { resolve: async () => null }
    const app = makeApp({
      freshAuth: fresh,
      activeOrg: noOrg,
      tenants: noTenant,
      mailDeviceEnrollments: stubDeps(),
    })

    const postRes = await app.request("/console/mail-devices/enrollments", {
      method: "POST",
      headers: BEARER,
      body: "{}",
    })
    expect(postRes.status).toBe(201)

    const getRes = await app.request(
      `/console/mail-devices/enrollments/${ENROLLMENT_ID}`,
      {
        headers: BEARER,
      },
    )
    expect(getRes.status).toBe(200)
    expect(getRes.headers.get("cache-control")).toBe("no-store")
    expect(await getRes.json()).toEqual({
      id: ENROLLMENT_ID,
      status: "sealed",
      expiresAt: EXPIRES.toISOString(),
      refusal: null,
      platform: "macos",
      model: "Mac14,2",
      deviceName: "Ada's MacBook Air",
      deviceId: DEVICE_ID,
      needsMailSetup: true,
    })

    const delRes = await app.request(
      `/console/mail-devices/enrollments/${ENROLLMENT_ID}`,
      {
        method: "DELETE",
        headers: BEARER,
      },
    )
    expect(delRes.status).toBe(204)
  })

  it("runs the mailbox workspace's console policies when another workspace or none is open", async () => {
    const MAILBOX_TENANT = "22222222-2222-4222-8222-222222222222"
    const gated: (string | undefined)[] = []
    const ssoGate: SsoGateReader = async (_req, _userId, tenantId) => {
      gated.push(tenantId)
      return tenantId === MAILBOX_TENANT
        ? { status: "mfa_required" }
        : { status: "pass" }
    }
    const created: { tenantId: string | null }[] = []
    const deps = stubDeps({
      mailboxTenant: async () => ({ tenantId: MAILBOX_TENANT }),
      create: async (input) => {
        created.push({ tenantId: input.tenantId })
        return {
          ok: true,
          id: ENROLLMENT_ID,
          url: "https://ca.i10.tech/enroll/apple/t",
          expiresAt: EXPIRES,
        }
      },
    })
    const post = (app: ReturnType<typeof makeApp>) =>
      app.request("/console/mail-devices/enrollments", {
        method: "POST",
        headers: BEARER,
      })

    for (const activeOrg of [
      async () => ({ status: "personal" }) as const,
      async () => ({ status: "org", orgId: "org_other" }) as const,
    ] satisfies ActiveOrgReader[]) {
      const res = await post(
        makeApp({ freshAuth: fresh, activeOrg, ssoGate, mailDeviceEnrollments: deps }),
      )
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ name: "mfa_required" })
    }
    expect(created).toEqual([])
    expect(gated).toContain(MAILBOX_TENANT)

    // Reading or cancelling the enrollment meets the same policies.
    let cancelled = 0
    const refusedApp = makeApp({
      freshAuth: fresh,
      activeOrg: async () => ({ status: "personal" }),
      ssoGate,
      mailDeviceEnrollments: {
        ...deps,
        cancel: async () => {
          cancelled++
          return "cancelled"
        },
      },
    })
    const path = `/console/mail-devices/enrollments/${ENROLLMENT_ID}`
    for (const method of ["GET", "DELETE"]) {
      const res = await refusedApp.request(path, { method, headers: BEARER })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ name: "mfa_required" })
    }
    expect(cancelled).toBe(0)

    // Its own workspace open: requireTenant already ran that gate, and the
    // tenant the route read is the one create checks under the account lock.
    const own = await post(
      makeApp({
        freshAuth: fresh,
        tenants: { resolve: async () => MAILBOX_TENANT },
        ssoGate: async () => ({ status: "pass" }),
        mailDeviceEnrollments: deps,
      }),
    )
    expect(own.status).toBe(201)
    expect(created).toEqual([{ tenantId: MAILBOX_TENANT }])

    // An i10.tech mailbox has no workspace whose policies could apply.
    const none = await post(
      makeApp({
        freshAuth: fresh,
        ssoGate,
        mailDeviceEnrollments: stubDeps({
          mailboxTenant: async () => ({ tenantId: null }),
        }),
      }),
    )
    expect(none.status).toBe(201)

    const noMailbox = await post(
      makeApp({
        freshAuth: fresh,
        mailDeviceEnrollments: stubDeps({ mailboxTenant: async () => null }),
      }),
    )
    expect(noMailbox.status).toBe(409)
    expect(await noMailbox.json()).toMatchObject({ name: "no_mailbox" })
  })

  it("maps 409, 503, 404, 409 already_sealed, and 501 when unwired", async () => {
    const conflictApp = makeApp({
      freshAuth: fresh,
      mailDeviceEnrollments: stubDeps({
        create: async () => ({ ok: false, status: 409, code: "no_mailbox" }),
        cancel: async () => "already_sealed",
      }),
    })
    const cRes = await conflictApp.request("/console/mail-devices/enrollments", {
      method: "POST",
      headers: BEARER,
      body: "{}",
    })
    expect(cRes.status).toBe(409)
    expect(await cRes.json()).toMatchObject({ name: "no_mailbox" })

    const sealedDel = await conflictApp.request(
      `/console/mail-devices/enrollments/${ENROLLMENT_ID}`,
      { method: "DELETE", headers: BEARER },
    )
    expect(sealedDel.status).toBe(409)
    expect(await sealedDel.json()).toMatchObject({ name: "already_sealed" })

    const keysOffApp = makeApp({
      freshAuth: fresh,
      mailDeviceEnrollments: stubDeps({
        create: async () => ({ ok: false, status: 503, code: "keys_not_configured" }),
      }),
    })
    const kRes = await keysOffApp.request("/console/mail-devices/enrollments", {
      method: "POST",
      headers: BEARER,
      body: "{}",
    })
    expect(kRes.status).toBe(503)
    expect(await kRes.json()).toMatchObject({ name: "keys_not_configured" })

    const badUuid = await conflictApp.request(
      "/console/mail-devices/enrollments/not-a-uuid",
      { headers: BEARER },
    )
    expect(badUuid.status).toBe(404)

    const otherId = await conflictApp.request(
      `/console/mail-devices/enrollments/${DEVICE_ID}`,
      { headers: BEARER },
    )
    expect(otherId.status).toBe(404)

    const unwired = makeApp({ freshAuth: fresh })
    expect(
      (
        await unwired.request("/console/mail-devices/enrollments", {
          method: "POST",
          headers: BEARER,
        })
      ).status,
    ).toBe(501)
  })

  it("matches /mail-devices/enrollments before a later /mail-devices/:id route", async () => {
    const app = makeApp({
      freshAuth: fresh,
      mailDeviceEnrollments: stubDeps(),
    })
    app.get("/console/mail-devices/:id", (c) =>
      c.json({ swallowed: c.req.param("id") }, 200),
    )
    const getRes = await app.request(
      `/console/mail-devices/enrollments/${ENROLLMENT_ID}`,
      { headers: BEARER },
    )
    expect(getRes.status).toBe(200)
    expect(await getRes.json()).toMatchObject({ id: ENROLLMENT_ID, status: "sealed" })
  })
})

describe("pinned array SQL (db-guard)", () => {
  it("binds enrollment ids as one uuid[] parameter for both 1 and 2 elements", () => {
    const dialect = new PgDialect()
    const id1 = "019ab100-0000-7000-8000-000000000001"
    const id2 = "019ab100-0000-7000-8000-000000000002"

    const one = dialect.sqlToQuery(expirePermitsForEnrollmentsSql([id1]))
    expect(one.sql).toContain("any($1::uuid[])")
    expect(one.sql).not.toContain("$2")
    expect(one.params).toEqual([`{${id1}}`])

    const two = dialect.sqlToQuery(expirePermitsForEnrollmentsSql([id1, id2]))
    expect(two.sql).toContain("any($1::uuid[])")
    expect(two.sql).not.toContain("$2")
    expect(two.params).toEqual([`{${id1},${id2}}`])

    expect(() => expirePermitsForEnrollmentsSql(["not-a-uuid"])).toThrow(
      /invalid enrollment id/,
    )
  })
})
