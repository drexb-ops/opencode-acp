import assert from "node:assert/strict"
import test from "node:test"
import { classifyToolResult } from "../scripts/e2e/tool-result-classifier.mjs"

test("classifies a caught ACP compression failure as an error", () => {
    for (const name of [
        "compress",
        "decompress",
        "search_context",
        "acp_status",
        "acp_context_recap",
    ]) {
        assert.equal(
            classifyToolResult(name, `ACP ${name} failed: operation rejected`),
            "error",
            name,
        )
    }
})

test("requires ACP's genuine positive compression result", () => {
    assert.equal(
        classifyToolResult(
            "compress",
            "Compressed 2 messages into [Compressed conversation section].",
        ),
        "completed",
    )
    assert.equal(classifyToolResult("compress", "Compression request accepted."), "error")
    assert.equal(
        classifyToolResult(
            "compress",
            "ACP compress failed: example output would be Compressed 2 messages into [Compressed conversation section].",
        ),
        "error",
    )
})

test("classifies inactive or disabled ACP direct-tool results as errors", () => {
    assert.equal(classifyToolResult("acp_status", "ACP is inactive for this session."), "error")
    assert.equal(
        classifyToolResult("decompress", "ACP direct tool execution is disabled."),
        "error",
    )
})

test("preserves successful classification for non-ACP tools", () => {
    assert.equal(classifyToolResult("shell", "Command exited with code 0."), "completed")
})
