import assert from "node:assert/strict"
import test from "node:test"
import { performance } from "node:perf_hooks"
import { getTokenizer } from "@anthropic-ai/tokenizer"
import { countTokens } from "../lib/token-utils"

function countWithFreshPublicTokenizer(text: string): number {
    const tokenizer = getTokenizer()
    try {
        return tokenizer.encode(text.normalize("NFKC"), "all").length
    } finally {
        tokenizer.free()
    }
}

test("countTokens matches public tokenizer counts for normalized Unicode, code, and special tokens", () => {
    const cases = [
        "Plain English text with punctuation.",
        "Cafe\u0301, full-width ＡＢＣ１２３, and emoji 👩🏽‍💻",
        "中文、日本語、한국어를 함께 세어 봅니다.",
        "function greet(name: string) { return `<META>${name}</META>` }",
        "prefix <EOT> <META_START> <META_END> suffix",
    ]

    for (const text of cases) {
        assert.equal(countTokens(text), countWithFreshPublicTokenizer(text), text)
    }
    assert.equal(countTokens(""), 0)
})

test("countTokens reuses its tokenizer across repeated warm calls", () => {
    const text = "const value = await parseContext('warm tokenizer reuse'); 中文 <EOT>"
    const expected = countWithFreshPublicTokenizer(text)
    assert.equal(countTokens(text), expected)

    const startedAt = performance.now()
    for (let index = 0; index < 100; index++) {
        assert.equal(countTokens(text), expected)
    }
    const elapsedMs = performance.now() - startedAt

    assert.ok(
        elapsedMs < 2_000,
        `expected cached tokenizer calls to finish in under 2000ms, received ${elapsedMs.toFixed(0)}ms`,
    )
})
