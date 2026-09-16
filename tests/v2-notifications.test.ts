import "./test-env"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import { AcpRpc } from "../rpc"
import tui from "../tui"
import { getConfig } from "../lib/config"
import { createManagedNotificationSink } from "../lib/notifications"
import { createV2NotificationBridge } from "../lib/v2/notifications"

test("ACP RPC exposes only validated JSON-safe toast fields", () => {
    const schema = AcpRpc.events.notification.schema as Record<string, unknown>
    const properties = schema.properties as Record<string, unknown>

    assert.equal(AcpRpc.id, "opencode-acp")
    assert.deepEqual(Object.keys(properties), ["title", "message", "variant", "duration"])
    assert.deepEqual(schema.required, ["title", "message", "variant"])
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(properties.variant, {
        type: "string",
        enum: ["info", "warning", "error", "success"],
    })
    assert.deepEqual(properties.duration, { type: "number" })
})

test("managed notifications cancel delayed delivery and ignore post-dispose work", () => {
    const delivered: unknown[] = []
    const notifications = createManagedNotificationSink({
        notify(input) {
            delivered.push(input)
        },
    })

    const cancel = notifications.notifyLater(
        { title: "later", message: "not delivered", variant: "info" },
        0,
    )
    assert.equal(notifications.pendingCount, 1)
    cancel()
    assert.equal(notifications.pendingCount, 0)

    notifications.notify({ title: "now", message: "delivered", variant: "info" })
    notifications.dispose()
    notifications.notify({ title: "late", message: "dropped", variant: "info" })
    assert.deepEqual(delivered, [{ title: "now", message: "delivered", variant: "info" }])
    assert.equal(notifications.disposed, true)
})

test("V2 RPC emission is fire-and-forget and headless delivery is non-fatal", async () => {
    const emitted: unknown[] = []
    const bridge = createV2NotificationBridge()
    bridge.sink.notify({ title: "headless", message: "ok", variant: "info" })

    bridge.connect(async (name, data) => {
        emitted.push([name, data])
    })
    bridge.sink.notify({
        title: "ready",
        message: "shown",
        variant: "success",
        duration: 1000,
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(emitted, [
        ["notification", { title: "ready", message: "shown", variant: "success", duration: 1000 }],
    ])

    bridge.disconnect()
    bridge.sink.notify({ title: "detached", message: "ignored", variant: "warning" })
    assert.equal(emitted.length, 1)

    const failing = createV2NotificationBridge()
    failing.connect(async () => {
        throw new Error("TUI disconnected")
    })
    assert.doesNotThrow(() =>
        failing.sink.notify({ title: "failure", message: "ignored", variant: "error" }),
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
})

test("TUI maps the typed RPC event to a native toast and returns unsubscribe", async () => {
    let listener: ((event: unknown) => void) | undefined
    let unsubscribed = 0
    const toasts: unknown[] = []
    const context = {
        client: {
            rpc(definition: unknown) {
                assert.equal(definition, AcpRpc)
                return {
                    events: {
                        on(name: string, handler: (event: unknown) => void) {
                            assert.equal(name, "notification")
                            listener = handler
                            return () => {
                                unsubscribed += 1
                            }
                        },
                    },
                }
            },
        },
        ui: {
            toast: {
                show(input: unknown) {
                    toasts.push(input)
                },
            },
        },
    } as unknown as Parameters<typeof tui.setup>[0]

    const cleanup = await tui.setup(context)
    assert.equal(typeof cleanup, "function")
    listener?.({
        data: { title: "Toast", message: "Hello", variant: "warning", duration: 2500 },
    })
    assert.deepEqual(toasts, [
        { title: "Toast", message: "Hello", variant: "warning", duration: 2500 },
    ])
    await (cleanup as () => void)()
    assert.equal(unsubscribed, 1)
})

test("config warning timers are owned and cancelled by the managed sink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-config-warning-"))
    const projectConfig = join(directory, ".opencode")
    await mkdir(projectConfig, { recursive: true })
    await writeFile(join(projectConfig, "acp.jsonc"), '{ "unknownWarningKey": true }\n', "utf8")

    const delivered: unknown[] = []
    const notifications = createManagedNotificationSink({
        notify(input) {
            delivered.push(input)
        },
    })
    try {
        getConfig({ directory, notifications })
        assert.equal(notifications.pendingCount, 1)
        notifications.dispose()
        assert.equal(notifications.pendingCount, 0)
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
        assert.deepEqual(delivered, [])
    } finally {
        notifications.dispose()
        await rm(directory, { recursive: true, force: true })
    }
})
