import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import v1Server from "../lib/v1/plugin"
import { setup } from "../lib/v2/plugin"

type DisposeRecord = {
    readonly disposed: string[]
    readonly reloads: { tool: number; command: number }
    readonly pushCatalogEvent: (event: unknown) => void
    readonly setProxy: (value: boolean) => void
}

async function makeContext(options: { failCommand?: boolean; throwToolDispose?: boolean } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "acp-v2-lifecycle-"))
    await mkdir(join(directory, ".opencode"), { recursive: true })
    await writeFile(join(directory, ".opencode", "acp.jsonc"), '{ "autoUpdate": false }\n', "utf8")

    const disposed: string[] = []
    const reloads = { tool: 0, command: 0 }
    let proxy = false
    const queued: unknown[] = []
    let wake: (() => void) | undefined
    let closed = false
    let monitorRecorded = false

    const recordMonitor = () => {
        if (monitorRecorded) return
        monitorRecorded = true
        disposed.push("monitor")
    }

    const pushCatalogEvent = (event: unknown) => {
        if (closed) return
        queued.push(event)
        wake?.()
        wake = undefined
    }
    const source = {
        async next(): Promise<IteratorResult<unknown>> {
            while (!closed && queued.length === 0) {
                await new Promise<void>((resolve) => {
                    wake = resolve
                })
            }
            if (closed) return { done: true, value: undefined }
            return { done: false, value: queued.shift() }
        },
        async return(): Promise<IteratorResult<unknown>> {
            closed = true
            recordMonitor()
            wake?.()
            wake = undefined
            return { done: true, value: undefined }
        },
        [Symbol.asyncIterator]() {
            return this
        },
    }

    const registration = (name: string) => ({
        async dispose() {
            disposed.push(name)
            if (name === "tool" && options.throwToolDispose) {
                throw new Error("tool cleanup failed")
            }
        },
    })

    const context = {
        location: { directory },
        rpc: {
            async register() {
                return {
                    events: {
                        async emit() {},
                    },
                    async dispose() {
                        disposed.push("rpc")
                    },
                }
            },
        },
        catalog: {
            provider: {
                async list() {
                    return {
                        data: [
                            {
                                id: "provider",
                                settings: {
                                    baseURL: proxy
                                        ? "http://proxy/bili/upstream"
                                        : "https://direct",
                                },
                            },
                        ],
                    }
                },
            },
            model: {
                async list() {
                    return {
                        data: [
                            {
                                id: "model",
                                providerID: "provider",
                                settings: { baseURL: "https://direct" },
                                limit: { context: 128000 },
                            },
                        ],
                    }
                },
            },
        },
        tool: {
            async transform() {
                return registration("tool")
            },
            async hook(name: string) {
                return registration(name === "execute.before" ? "timing-before" : "timing-after")
            },
            async reload() {
                reloads.tool += 1
            },
        },
        command: {
            async transform() {
                if (options.failCommand) throw new Error("command registration failed")
                return registration("command")
            },
            async reload() {
                reloads.command += 1
            },
        },
        session: {
            async hook() {
                return registration("context")
            },
        },
        event: {
            subscribe({ signal }: { signal?: AbortSignal } = {}) {
                signal?.addEventListener(
                    "abort",
                    () => {
                        closed = true
                        recordMonitor()
                        wake?.()
                        wake = undefined
                    },
                    { once: true },
                )
                return source
            },
        },
    } as unknown as Parameters<typeof setup>[0]

    return {
        context,
        directory,
        record: {
            disposed,
            reloads,
            pushCatalogEvent,
            setProxy(value: boolean) {
                proxy = value
            },
        } satisfies DisposeRecord,
    }
}

test("V2 unload is reverse ordered, idempotent, and does not duplicate domains", async () => {
    const fixture = await makeContext()
    try {
        const cleanup = await setup(fixture.context)
        assert.equal(typeof cleanup, "function")

        fixture.record.setProxy(true)
        fixture.record.pushCatalogEvent({ type: "catalog.updated", data: {} })
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert.deepEqual(fixture.record.reloads, { tool: 1, command: 1 })

        await (cleanup as () => Promise<void>)()
        await (cleanup as () => Promise<void>)()
        assert.deepEqual(fixture.record.disposed, [
            "monitor",
            "timing-after",
            "timing-before",
            "context",
            "command",
            "tool",
            "rpc",
        ])
    } finally {
        await rm(fixture.directory, { recursive: true, force: true })
    }
})

test("partial V2 setup attempts every prior cleanup and preserves the setup error", async () => {
    const fixture = await makeContext({ failCommand: true })
    try {
        await assert.rejects(() => setup(fixture.context), /command registration failed/)
        assert.deepEqual(fixture.record.disposed, ["tool", "rpc"])
    } finally {
        await rm(fixture.directory, { recursive: true, force: true })
    }
})

test("cleanup continues after one resource disposer fails", async () => {
    const fixture = await makeContext({ throwToolDispose: true })
    try {
        const cleanup = await setup(fixture.context)
        await (cleanup as () => Promise<void>)()
        assert.deepEqual(fixture.record.disposed, [
            "monitor",
            "timing-after",
            "timing-before",
            "context",
            "command",
            "tool",
            "rpc",
        ])
    } finally {
        await rm(fixture.directory, { recursive: true, force: true })
    }
})

test("V1 exposes idempotent dispose for managed notification and update work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-v1-dispose-"))
    await mkdir(join(directory, ".opencode"), { recursive: true })
    await writeFile(
        join(directory, ".opencode", "acp.jsonc"),
        '{ "autoUpdate": false, "unknownWarningKey": true }\n',
        "utf8",
    )
    const toasts: unknown[] = []
    const context = {
        directory,
        client: {
            config: {
                async providers() {
                    return { data: { providers: [] } }
                },
            },
            session: {},
            tui: {
                async showToast(input: unknown) {
                    toasts.push(input)
                },
            },
        },
    }

    try {
        const hooks = await v1Server(context as never, undefined)
        assert.equal(typeof hooks.dispose, "function")
        await hooks.dispose?.()
        await hooks.dispose?.()
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
        assert.deepEqual(toasts, [])
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
