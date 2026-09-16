import "./test-env"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { Message } from "@opencode/ai"

import v1Server from "../lib/v1/plugin"
import { setup } from "../lib/v2/plugin"
import { V2OperationTracker } from "../lib/v2/lifecycle"

type DisposeRecord = {
    readonly disposed: string[]
    readonly reloads: { tool: number; command: number }
    readonly pushCatalogEvent: (event: unknown) => void
    readonly setProxy: (value: boolean) => void
    readonly blockHistory: (expectedStarts?: number) => {
        started: Promise<void>
        release: () => void
    }
    readonly invokeContext: (event: unknown) => Promise<void>
    readonly invokeTool: (name: string, sessionID?: string) => Promise<unknown>
    readonly invokeCommand: (name: string, sessionID?: string) => Promise<void>
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
    let contextHandler: ((event: unknown) => Promise<void>) | undefined
    let toolTransform: ((editor: { add(tool: unknown): void }) => void) | undefined
    let commandTransform: ((editor: { add(definition: unknown): void }) => void) | undefined
    let historyBlocked = false
    let historyGate: Promise<void> = Promise.resolve()
    let releaseHistory = () => {}
    let historyStarted: Promise<void> = Promise.resolve()
    let signalHistoryStarted = () => {}
    let expectedHistoryStarts = 1
    let observedHistoryStarts = 0

    const blockHistory = (expectedStarts = 1) => {
        historyBlocked = true
        expectedHistoryStarts = expectedStarts
        observedHistoryStarts = 0
        historyGate = new Promise<void>((resolve) => {
            releaseHistory = () => {
                historyBlocked = false
                resolve()
            }
        })
        historyStarted = new Promise<void>((resolve) => {
            signalHistoryStarted = resolve
        })
        return {
            started: historyStarted,
            release: () => releaseHistory(),
        }
    }

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
            async transform(transformer: unknown) {
                toolTransform = transformer as (editor: { add(tool: unknown): void }) => void
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
            async transform(transformer: unknown) {
                if (options.failCommand) throw new Error("command registration failed")
                commandTransform = transformer as (editor: {
                    add(definition: unknown): void
                }) => void
                return registration("command")
            },
            async reload() {
                reloads.command += 1
            },
        },
        agent: {
            async get() {
                return { data: { permissions: [] } }
            },
        },
        session: {
            async get({ sessionID }: { sessionID: string }) {
                return { id: sessionID, agent: "code" }
            },
            async context() {
                if (historyBlocked) {
                    observedHistoryStarts++
                    if (observedHistoryStarts >= expectedHistoryStarts) signalHistoryStarted()
                    await historyGate
                }
                return [{ type: "user", id: "history-user", time: { created: 1 }, text: "history" }]
            },
            async hook(_name: string, handler: unknown) {
                contextHandler = handler as (event: unknown) => Promise<void>
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
            blockHistory,
            async invokeContext(event: unknown) {
                await contextHandler?.(event)
            },
            async invokeTool(name: string, sessionID = "lifecycle-session") {
                const added: Array<{
                    name: string
                    execute(input: unknown, context: unknown): Promise<unknown>
                }> = []
                toolTransform?.({ add: (tool) => added.push(tool as (typeof added)[number]) })
                const tool = added.find((candidate) => candidate.name === name)
                if (!tool) throw new Error(`tool ${name} was not registered`)
                return tool.execute(
                    {},
                    {
                        sessionID,
                        agent: "code",
                        messageID: "lifecycle-message",
                        id: "lifecycle-call",
                        progress: async () => {},
                    },
                )
            },
            async invokeCommand(name: string, sessionID = "lifecycle-session") {
                const added: Array<{ name: string; execute(input: unknown): Promise<void> }> = []
                commandTransform?.({
                    add: (definition) =>
                        added.push(
                            definition as { name: string; execute(input: unknown): Promise<void> },
                        ),
                })
                const command = added.find((definition) => definition.name === name)
                if (!command) throw new Error(`command ${name} was not registered`)
                await command.execute({
                    sessionID,
                    prompt: { text: `${name} help` },
                    delivery: "queue",
                })
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

test("V2 lifecycle fence invalidates context/tool/command/timing commits and waits for settlement", async () => {
    const tracker = new V2OperationTracker()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
        release = resolve
    })
    const started: string[] = []
    const settled: string[] = []
    const pending = (kind: "context" | "tool" | "command" | "timing") =>
        tracker.run(kind, async (lease) => {
            started.push(kind)
            await blocked
            if (lease.isActive()) settled.push(kind)
            else settled.push(`${kind}-invalidated`)
        })

    const operations = [pending("context"), pending("tool"), pending("command"), pending("timing")]
    assert.deepEqual(started, ["context", "tool", "command", "timing"])
    tracker.deactivate()

    let idle = false
    const waiting = tracker.waitForIdle().then(() => {
        idle = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(idle, false)

    release()
    await Promise.all([...operations, waiting])
    assert.equal(idle, true)
    assert.deepEqual(settled.sort(), [
        "command-invalidated",
        "context-invalidated",
        "timing-invalidated",
        "tool-invalidated",
    ])
    assert.equal(await tracker.run("tool", async () => "late"), undefined)
})

test("V2 unload during blocked context waits and leaves the event untouched", async () => {
    const fixture = await makeContext()
    try {
        const cleanup = await setup(fixture.context)
        const gate = fixture.record.blockHistory()
        const event = {
            sessionID: "context-session",
            agent: "code",
            model: { id: "model", providerID: "provider" },
            system: [],
            messages: [Message.make({ id: "history-user", role: "user", content: "history" })],
        }
        const originalMessages = event.messages
        const pendingContext = fixture.record.invokeContext(event)
        await gate.started

        let cleanupSettled = false
        const pendingCleanup = cleanup!().then(() => {
            cleanupSettled = true
        })
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(cleanupSettled, false)
        gate.release()
        await Promise.all([pendingContext, pendingCleanup])
        assert.equal(cleanupSettled, true)
        assert.strictEqual(event.messages, originalMessages)
        assert.equal(fixture.record.disposed.includes("context"), true)
    } finally {
        await rm(fixture.directory, { recursive: true, force: true })
    }
})

test("V2 unload during blocked tool and command waits for both operations", async () => {
    const fixture = await makeContext()
    try {
        const cleanup = await setup(fixture.context)
        const initialEvent = (sessionID: string) => ({
            sessionID,
            agent: "code",
            model: { id: "model", providerID: "provider" },
            system: [],
            messages: [Message.make({ id: "history-user", role: "user", content: "history" })],
        })
        await fixture.record.invokeContext(initialEvent("lifecycle-tool"))
        await fixture.record.invokeContext(initialEvent("lifecycle-command"))

        const gate = fixture.record.blockHistory(2)
        const pendingTool = fixture.record.invokeTool("acp_status", "lifecycle-tool")
        const pendingCommand = fixture.record.invokeCommand("acp", "lifecycle-command")
        await gate.started
        let cleanupSettled = false
        const pendingCleanup = cleanup!().then(() => {
            cleanupSettled = true
        })
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(cleanupSettled, false)

        gate.release()
        await Promise.all([pendingTool, pendingCommand, pendingCleanup])
        assert.equal(cleanupSettled, true)
        assert.equal(fixture.record.disposed.includes("tool"), true)
        assert.equal(fixture.record.disposed.includes("command"), true)
    } finally {
        await rm(fixture.directory, { recursive: true, force: true })
    }
})
