import "./test-env"
import assert from "node:assert/strict"
import { constants as fsConstants } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { requireNoFollowFlag, writeDecompressedFileSafely } from "../lib/compress/decompress"

test("safe decompression writes require a numeric nonzero O_NOFOLLOW flag", () => {
    assert.throws(() => requireNoFollowFlag(0), /O_NOFOLLOW/i)
    assert.throws(() => requireNoFollowFlag(undefined), /O_NOFOLLOW/i)
    if (typeof fsConstants.O_NOFOLLOW === "number" && fsConstants.O_NOFOLLOW > 0) {
        assert.equal(requireNoFollowFlag(fsConstants.O_NOFOLLOW), fsConstants.O_NOFOLLOW)
    }
})

test("safe decompression file writes allow regular existing parents", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-safe-file-"))
    try {
        const nested = join(root, "owned-parent")
        await mkdir(nested)
        const target = join(nested, "restored.txt")
        assert.equal(await writeDecompressedFileSafely(target, "restored"), true)
        assert.equal(await readFile(target, "utf8"), "restored")
        if (typeof process.geteuid === "function") {
            assert.equal((await stat(nested)).uid, process.geteuid())
            assert.equal((await stat(target)).uid, process.geteuid())
        }
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})

test("safe decompression file writes reject final and intermediate symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-safe-file-links-"))
    const outside = await mkdtemp(join(tmpdir(), "acp-safe-file-outside-"))
    try {
        const regular = join(root, "regular.txt")
        await writeFile(regular, "untouched", "utf8")
        const finalLink = join(root, "final-link.txt")
        await symlink(regular, finalLink)
        await assert.rejects(
            () => writeDecompressedFileSafely(finalLink, "must not overwrite"),
            /symbolic link/i,
        )
        assert.equal(await readFile(regular, "utf8"), "untouched")

        const intermediateLink = join(root, "intermediate")
        await symlink(outside, intermediateLink)
        await assert.rejects(
            () => writeDecompressedFileSafely(join(intermediateLink, "escaped.txt"), "escape"),
            /outside|symbolic-link/i,
        )
    } finally {
        await rm(root, { recursive: true, force: true })
        await rm(outside, { recursive: true, force: true })
    }
})

test("safe decompression file writes reject paths outside approved roots", async () => {
    const outsidePath = join(process.cwd(), `acp-outside-${process.pid}-${Date.now()}.txt`)
    await assert.rejects(
        () => writeDecompressedFileSafely(outsidePath, "must not write"),
        /under .*allowed|toFile path/i,
    )
})

test("safe decompression file writes recheck lifecycle immediately before opening", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-safe-file-inactive-"))
    try {
        const target = join(root, "cancelled.txt")
        assert.equal(await writeDecompressedFileSafely(target, "cancelled", () => false), false)
        await assert.rejects(() => readFile(target, "utf8"), { code: "ENOENT" })
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})
