import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"

import plugin from "../index"

type DualPluginShape = {
    id: string
    setup: (...args: never[]) => unknown
    server: (...args: never[]) => unknown
}

function assertDualPluginShape(value: unknown): asserts value is DualPluginShape {
    assert.equal(typeof value, "object")
    assert.notEqual(value, null)

    const shape = value as Record<string, unknown>
    assert.equal(shape.id, "opencode-acp")
    assert.equal(typeof shape.setup, "function")
    assert.equal(typeof shape.server, "function")
}

test("source entrypoint exposes the dual V1/V2 plugin shape", () => {
    assertDualPluginShape(plugin)
})

test("built entrypoint exposes the dual V1/V2 plugin shape", async (context) => {
    const builtPath = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js")
    if (!existsSync(builtPath)) {
        context.skip("dist/index.js is unavailable; run npm run build first")
        return
    }

    const builtModule = await import(`${pathToFileURL(builtPath).href}?entrypoint-test`)
    assertDualPluginShape(builtModule.default)
})
