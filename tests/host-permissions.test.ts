import assert from "node:assert/strict"
import test from "node:test"
import {
    compressDisabledByOpencode,
    hasExplicitToolPermission,
    resolveEffectiveCompressPermission,
    resolveV2Permission,
} from "../lib/host-permissions"

test("wildcard deny disables compress", () => {
    assert.equal(compressDisabledByOpencode({ "*": "deny" }), true)
})

test("later explicit compress allow overrides wildcard deny", () => {
    assert.equal(
        compressDisabledByOpencode({
            "*": "deny",
            compress: "allow",
        }),
        false,
    )
})

test("agent wildcard deny disables compress even when global config allows it", () => {
    assert.equal(
        resolveEffectiveCompressPermission(
            "allow",
            {
                global: { question: "allow" },
                agents: {
                    fast: { "*": "deny", question: "allow" },
                },
            },
            "fast",
        ),
        "deny",
    )
})

test("agent explicit allow overrides global wildcard deny", () => {
    assert.equal(
        resolveEffectiveCompressPermission(
            "allow",
            {
                global: { "*": "deny" },
                agents: {
                    build: { compress: "allow" },
                },
            },
            "build",
        ),
        "allow",
    )
})

test("permission wildcards follow opencode-style matching", () => {
    assert.equal(compressDisabledByOpencode({ "c?mpress": "deny" }), true)
})

test("pattern-specific denies do not disable the whole tool", () => {
    assert.equal(
        compressDisabledByOpencode({
            compress: {
                "/tmp/*": "deny",
            },
        }),
        false,
    )
})

test("compress permission resolution works without Array.findLast", () => {
    const originalFindLast = Array.prototype.findLast

    try {
        delete (Array.prototype as Array<unknown> & { findLast?: unknown }).findLast

        assert.equal(
            compressDisabledByOpencode({
                "*": "deny",
                compress: "allow",
            }),
            false,
        )
    } finally {
        Array.prototype.findLast = originalFindLast
    }
})

test("explicit compress permissions are detected", () => {
    assert.equal(hasExplicitToolPermission({ compress: "ask" }, "compress"), true)
    assert.equal(hasExplicitToolPermission({ "*": "deny" }, "compress"), false)
})

test("explicit permission detection works without Object.hasOwn", () => {
    const originalHasOwn = Object.hasOwn

    try {
        delete (Object as typeof Object & { hasOwn?: unknown }).hasOwn

        assert.equal(hasExplicitToolPermission({ compress: "ask" }, "compress"), true)
        assert.equal(hasExplicitToolPermission({ "*": "deny" }, "compress"), false)
    } finally {
        Object.hasOwn = originalHasOwn
    }
})

test("V2 ordered rules use the last matching whole-resource action", () => {
    assert.equal(
        resolveV2Permission([{ action: "compress", resource: "*", effect: "allow" }], "compress"),
        "allow",
    )
    assert.equal(
        resolveV2Permission(
            [
                { action: "*", resource: "*", effect: "deny" },
                { action: "compress", resource: "*", effect: "allow" },
            ],
            "compress",
        ),
        "allow",
    )
    assert.equal(
        resolveV2Permission(
            [
                { action: "compress", resource: "*", effect: "allow" },
                { action: "compress", resource: "*", effect: "ask" },
            ],
            "compress",
        ),
        "ask",
    )
    assert.equal(
        resolveV2Permission(
            [
                { action: "compress", resource: "*", effect: "ask" },
                { action: "compress", resource: "*", effect: "deny" },
            ],
            "compress",
        ),
        "deny",
    )
})

test("V2 resource-specific rules do not wholly disable a direct tool", () => {
    assert.equal(
        resolveV2Permission(
            [{ action: "compress", resource: "/tmp/*", effect: "deny" }],
            "compress",
        ),
        undefined,
    )
    assert.equal(
        resolveV2Permission(
            [
                { action: "compress", resource: "*", effect: "deny" },
                { action: "compress", resource: "/tmp/*", effect: "allow" },
            ],
            "compress",
        ),
        "deny",
    )
    assert.equal(
        resolveV2Permission(
            [
                { action: "compress", resource: "*", effect: "deny" },
                { action: "compress", resource: "/tmp/*", effect: "allow" },
            ],
            "compress",
            "/tmp/result.txt",
        ),
        "allow",
    )
})
