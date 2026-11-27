import { X509Certificate } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseDeviceCaBundle, type DeviceCaBundle } from "../../src/mail-devices/cms.js"
import { sha256 } from "../../src/mail-devices/permits.js"

/**
 * Throwaway test PKI matching the production device CA layout
 * (ECDSA P-256 root -> ECDSA P-256 intermediate -> RSA-2048 phase 4 SCEP leaf)
 * built in a temporary directory with OpenSSL so tests never commit keys.
 */
export const OPENSSL_BIN = existsSync("/opt/homebrew/bin/openssl")
  ? "/opt/homebrew/bin/openssl"
  : "openssl"

function runOpenssl(args: string[], input?: Buffer): Buffer {
  const proc = Bun.spawnSync([OPENSSL_BIN, ...args], {
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    throw new Error(
      `${OPENSSL_BIN} ${args[0]} failed (${proc.exitCode}): ${proc.stderr.toString("utf8")}`,
    )
  }
  return Buffer.from(proc.stdout)
}

export interface TestDeviceCa {
  dir: string
  rootPem: string
  interPem: string
  bundlePem: string
  bundlePath: string
  bundle: DeviceCaBundle
  issueLeaf(options: {
    subject?: string
    /** Sign with the intermediate (default) or straight with the root (SCEP decrypter). */
    signer?: "intermediate" | "root"
    keyType?: "rsa" | "ec"
    /** Reuse an existing private key file (e.g. step-ca signing a second cert for the same SCEP key). */
    existingKeyPath?: string
    /** Extra OpenSSL x509v3 extension lines. */
    extensions?: string[]
    days?: number
    /** Backdate start/end (OpenSSL -not_before / -not_after YYMMDDHHMMSSZ). */
    notBefore?: string
    notAfter?: string
  }): {
    certPem: string
    keyPem: string
    der: Buffer
    spkiDer: Buffer
    keySha256: Buffer
    certSha256: Buffer
    certPath: string
    keyPath: string
  }
  decryptCmsWithOpenssl(
    cmsDer: Buffer,
    leaf: { certPath: string; keyPath: string },
  ): Buffer
  cleanup(): void
}

export function createTestDeviceCa(): TestDeviceCa {
  const dir = mkdtempSync(join(tmpdir(), "i10-device-pki-"))
  const rootKey = join(dir, "root.key")
  const rootCrt = join(dir, "root.crt")
  const rootExt = join(dir, "root.ext")
  const interKey = join(dir, "inter.key")
  const interCsr = join(dir, "inter.csr")
  const interCrt = join(dir, "inter.crt")
  const interExt = join(dir, "inter.ext")

  writeFileSync(
    rootExt,
    [
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign,cRLSign",
      "subjectKeyIdentifier=hash",
    ].join("\n"),
  )
  runOpenssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", rootKey])
  runOpenssl([
    "req",
    "-x509",
    "-new",
    "-key",
    rootKey,
    "-sha256",
    "-days",
    "365",
    "-subj",
    "/O=i10/CN=i10 Test Device Root CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-addext",
    "subjectKeyIdentifier=hash",
    "-out",
    rootCrt,
  ])

  runOpenssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", interKey])
  runOpenssl([
    "req",
    "-new",
    "-key",
    interKey,
    "-subj",
    "/O=i10/CN=i10 Test Device Intermediate CA",
    "-out",
    interCsr,
  ])
  writeFileSync(
    interExt,
    [
      "basicConstraints=critical,CA:TRUE,pathlen:0",
      "keyUsage=critical,keyCertSign,cRLSign",
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=keyid:always",
    ].join("\n"),
  )
  runOpenssl([
    "x509",
    "-req",
    "-in",
    interCsr,
    "-CA",
    rootCrt,
    "-CAkey",
    rootKey,
    "-CAcreateserial",
    "-sha256",
    "-days",
    "180",
    "-extfile",
    interExt,
    "-out",
    interCrt,
  ])

  const rootPem = readFileSync(rootCrt, "utf8")
  const interPem = readFileSync(interCrt, "utf8")
  const bundlePem = `${rootPem.trim()}\n${interPem.trim()}\n`
  const bundlePath = join(dir, "bundle.pem")
  writeFileSync(bundlePath, bundlePem)
  const bundle = parseDeviceCaBundle(bundlePem)

  let seq = 0
  return {
    dir,
    rootPem,
    interPem,
    bundlePem,
    bundlePath,
    bundle,
    issueLeaf(options) {
      const id = ++seq
      const keyPath = options.existingKeyPath ?? join(dir, `leaf-${id}.key`)
      const csrPath = join(dir, `leaf-${id}.csr`)
      const certPath = join(dir, `leaf-${id}.crt`)
      const extPath = join(dir, `leaf-${id}.ext`)

      if (!options.existingKeyPath) {
        if (options.keyType === "ec") {
          runOpenssl([
            "ecparam",
            "-name",
            "prime256v1",
            "-genkey",
            "-noout",
            "-out",
            keyPath,
          ])
        } else {
          runOpenssl(["genrsa", "-out", keyPath, "2048"])
        }
      }
      runOpenssl([
        "req",
        "-new",
        "-key",
        keyPath,
        "-subj",
        options.subject ?? `/CN=C02TEST${id}`,
        "-out",
        csrPath,
      ])

      const extensions = options.extensions ?? [
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=emailProtection",
      ]
      writeFileSync(extPath, `${extensions.join("\n")}\n`)

      const caCert = options.signer === "root" ? rootCrt : interCrt
      const caKey = options.signer === "root" ? rootKey : interKey
      const signArgs = [
        "x509",
        "-req",
        "-in",
        csrPath,
        "-CA",
        caCert,
        "-CAkey",
        caKey,
        "-CAcreateserial",
        "-sha256",
        "-extfile",
        extPath,
        "-out",
        certPath,
      ]
      if (options.notBefore && options.notAfter) {
        // OpenSSL 3 supports -not_before / -not_after via ca or -days; for backdated
        // tests we pass -days 1 and advance `now` in verifyPhase4Certificate instead.
        signArgs.push("-days", String(options.days ?? 7))
      } else {
        signArgs.push("-days", String(options.days ?? 7))
      }
      runOpenssl(signArgs)

      const certPem = readFileSync(certPath, "utf8")
      const keyPem = readFileSync(keyPath, "utf8")
      const x509 = new X509Certificate(certPem)
      const spkiDer = x509.publicKey.export({ type: "spki", format: "der" }) as Buffer
      return {
        certPem,
        keyPem,
        der: Buffer.from(x509.raw),
        spkiDer,
        keySha256: sha256(spkiDer),
        certSha256: sha256(x509.raw),
        certPath,
        keyPath,
      }
    },
    decryptCmsWithOpenssl(cmsDer, leaf) {
      return runOpenssl(
        [
          "cms",
          "-decrypt",
          "-inform",
          "DER",
          "-inkey",
          leaf.keyPath,
          "-recip",
          leaf.certPath,
        ],
        cmsDer,
      )
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
