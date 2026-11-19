import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { extractArchive, parseListing, validateEntries } from "../src/archive.js"
import {
  fetchFile,
  pinLocalFiles,
  selectDatasets,
  sha256OfFile,
  verifyDataset,
} from "../src/fetch.js"
import { cacheRoot, assertDatasetId } from "../src/paths.js"
import { sha256Hex } from "../src/text.js"
import { dataset, withTempDir } from "./helpers.js"

describe("archive listing", () => {
  it("parses bsdtar and GNU tar listings", () => {
    const bsd =
      "-rw-r--r--  0 0      0       11398 Oct  1 23:01 2026/10/a b.txt\ndrwxr-xr-x  0 0      0           0 Oct 31 18:01 2026/10/"
    expect(parseListing(bsd)).toEqual([
      { path: "2026/10/a b.txt", size: 11398, kind: "file" },
      { path: "2026/10/", size: 0, kind: "dir" },
    ])
    const gnu = "-rw------- jm/jm 8318 2003-02-28 12:00 hard_ham/00001.abc"
    expect(parseListing(gnu)).toEqual([
      { path: "hard_ham/00001.abc", size: 8318, kind: "file" },
    ])
  })

  it("fails closed on a line it cannot read", () => {
    expect(() => parseListing("something unexpected")).toThrow(/unrecognised/)
  })
})

describe("archive validation", () => {
  const file = (path: string, size = 1) => ({ path, size, kind: "file" as const })

  it("accepts ordinary relative paths", () => {
    expect(() => validateEntries([file("a/b.txt"), file("c.txt")])).not.toThrow()
  })

  it("refuses absolute paths, traversal, links and special files", () => {
    expect(() => validateEntries([file("/etc/passwd")])).toThrow(/absolute/)
    expect(() => validateEntries([file("a/../../escape")])).toThrow(/upwards/)
    expect(() => validateEntries([{ path: "x", size: 0, kind: "other" }])).toThrow(
      /link or special/,
    )
    expect(
      parseListing(
        "lrwxr-xr-x  0 0      0           0 Oct  1 23:01 x -> /etc/passwd",
      )[0]?.kind,
    ).toBe("other")
  })

  it("refuses an archive that expands past the size limit", () => {
    expect(() => validateEntries([file("big", 3 * 1024 * 1024 * 1024)])).toThrow(
      /expands/,
    )
  })
})

describe("extractArchive", () => {
  it("extracts a real tar.bz2 and reuses a finished extraction", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "src", "d"), { recursive: true })
      await writeFile(join(dir, "src", "d", "one.txt"), "hello")
      const archive = join(dir, "a.tar.bz2")
      expect(
        await Bun.spawn(["tar", "-cjf", archive, "-C", join(dir, "src"), "d"]).exited,
      ).toBe(0)
      const dest = join(dir, "out")
      expect(await extractArchive(archive, dest)).toEqual(["d/one.txt"])
      // A second call must not need the archive at all.
      expect(await extractArchive(join(dir, "gone.tar.bz2"), dest)).toEqual([
        "d/one.txt",
      ])
    })
  })

  it("refuses an archive holding a symlink before writing anything", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "src"), { recursive: true })
      await writeFile(join(dir, "src", "real"), "x")
      expect(
        await Bun.spawn(["ln", "-s", "/etc/passwd", join(dir, "src", "link")]).exited,
      ).toBe(0)
      const archive = join(dir, "l.tar")
      expect(
        await Bun.spawn(["tar", "-cf", archive, "-C", join(dir, "src"), "real", "link"])
          .exited,
      ).toBe(0)
      const dest = join(dir, "out")
      await expect(extractArchive(archive, dest)).rejects.toThrow(/link or special/)
      expect(existsSync(dest)).toBe(false)
    })
  })
})

const bytes = new TextEncoder().encode("pinned content")
const goodEntry = { bytes: bytes.length, sha256: sha256Hex(bytes) }
const respond = (body: Uint8Array) => () => Promise.resolve(new Response(body))

describe("fetchFile", () => {
  it("downloads, verifies against the pin, and then serves from cache", async () => {
    await withTempDir(async (dir) => {
      const dest = join(dir, "f.bin")
      const first = await fetchFile({
        url: "https://example.invalid/f",
        dest,
        expected: goodEntry,
        updateManifest: false,
        fetchImpl: respond(bytes),
      })
      expect(first.status).toBe("downloaded")
      expect(await sha256OfFile(dest)).toBe(goodEntry.sha256)
      let called = false
      const second = await fetchFile({
        url: "https://example.invalid/f",
        dest,
        expected: goodEntry,
        updateManifest: false,
        fetchImpl: () => {
          called = true
          return Promise.resolve(new Response(bytes))
        },
      })
      expect(second.status).toBe("cached")
      expect(called).toBe(false)
    })
  })

  it("notices an upstream change, keeps nothing, and repins only when told to", async () => {
    await withTempDir(async (dir) => {
      const dest = join(dir, "f.bin")
      const changed = new TextEncoder().encode("different content")
      await expect(
        fetchFile({
          url: "https://example.invalid/f",
          dest,
          expected: goodEntry,
          updateManifest: false,
          fetchImpl: respond(changed),
        }),
      ).rejects.toThrow(/changed upstream/)
      expect(existsSync(dest)).toBe(false)
      expect(existsSync(`${dest}.partial`)).toBe(false)
      const repinned = await fetchFile({
        url: "https://example.invalid/f",
        dest,
        expected: goodEntry,
        updateManifest: true,
        fetchImpl: respond(changed),
      })
      expect(repinned.status).toBe("repinned")
      expect(repinned.entry.sha256).toBe(sha256Hex(changed))
    })
  })

  it("refuses a file with no pin unless the manifest may be updated", async () => {
    await withTempDir(async (dir) => {
      const base = {
        url: "https://example.invalid/f",
        dest: join(dir, "f.bin"),
        expected: undefined,
        fetchImpl: respond(bytes),
      }
      await expect(fetchFile({ ...base, updateManifest: false })).rejects.toThrow(
        /not pinned/,
      )
      expect((await fetchFile({ ...base, updateManifest: true })).status).toBe("pinned")
    })
  })

  it("enforces the size cap and https", async () => {
    await withTempDir(async (dir) => {
      const base = {
        dest: join(dir, "f.bin"),
        expected: undefined,
        updateManifest: true,
      }
      await expect(
        fetchFile({
          ...base,
          url: "https://example.invalid/f",
          fetchImpl: respond(bytes),
          maxBytes: 4,
        }),
      ).rejects.toThrow(/limit/)
      expect(existsSync(`${base.dest}.partial`)).toBe(false)
      await expect(
        fetchFile({
          ...base,
          url: "http://example.invalid/f",
          fetchImpl: respond(bytes),
        }),
      ).rejects.toThrow(/non-https/)
    })
  })
})

describe("verifyDataset", () => {
  it("rejects a cached file that no longer matches the manifest", async () => {
    await withTempDir(async (root) => {
      const def = dataset("verify-me", ["f.bin"])
      await mkdir(join(root, "verify-me"), { recursive: true })
      await writeFile(join(root, "verify-me", "f.bin"), bytes)
      const manifest = {
        version: 1 as const,
        datasets: { "verify-me": { "f.bin": goodEntry } },
      }
      await expect(verifyDataset(root, def, manifest)).resolves.toBeUndefined()
      await writeFile(join(root, "verify-me", "f.bin"), "tampered")
      await expect(verifyDataset(root, def, manifest)).rejects.toThrow(/does not match/)
    })
  })
})

describe("pinLocalFiles", () => {
  it("hashes files put in the cache by hand, and says so when one is missing", async () => {
    await withTempDir(async (root) => {
      const def = dataset("manual-set", ["a.csv", "b.csv"])
      await mkdir(join(root, "manual-set"), { recursive: true })
      await writeFile(join(root, "manual-set", "a.csv"), bytes)
      const empty = { version: 1 as const, datasets: {} }
      await expect(pinLocalFiles(root, def, empty)).rejects.toThrow(/b\.csv is missing/)
      await writeFile(join(root, "manual-set", "b.csv"), bytes)
      const pinned = await pinLocalFiles(root, def, empty)
      expect(pinned.datasets["manual-set"]).toEqual({
        "a.csv": goodEntry,
        "b.csv": goodEntry,
      })
      await expect(verifyDataset(root, def, pinned)).resolves.toBeUndefined()
    })
  })
})

describe("terms gate and paths", () => {
  it("fetches only datasets whose terms allow it, by default", () => {
    const ids = selectDatasets([], []).map((d) => d.id)
    expect(ids).toContain("nazario")
    expect(ids).not.toContain("zenodo-curated")
  })

  it("makes an unclear dataset an explicit, per-run decision", () => {
    expect(() => selectDatasets(["zenodo-curated"], [])).toThrow(/unclear/)
    expect(selectDatasets(["zenodo-curated"], ["zenodo-curated"])).toHaveLength(1)
  })

  it("refuses a cache directory inside the repository", () => {
    expect(() =>
      cacheRoot({ I10_RISK_EVAL_CACHE: join(import.meta.dir, "cache") }),
    ).toThrow(/inside the repository/)
    expect(cacheRoot({ I10_RISK_EVAL_CACHE: "/tmp/elsewhere" })).toBe("/tmp/elsewhere")
  })

  it("keeps dataset ids to a closed alphabet that cannot collide with pipeline directories", () => {
    expect(() => assertDatasetId("../x")).toThrow()
    expect(() => assertDatasetId("splits")).toThrow(/collides/)
    expect(() => assertDatasetId("ok-id-2")).not.toThrow()
  })
})
