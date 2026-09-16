import type { NotificationInput, NotificationSink } from "./host"

export interface ManagedNotificationSink extends NotificationSink {
    /** Deliver a notification after a delay and return a cancellation handle. */
    notifyLater(input: NotificationInput, delayMs: number): () => void
    /** Alias for callers that describe delayed delivery as scheduling. */
    schedule(input: NotificationInput, delayMs: number): () => void
    /** Cancel all delayed delivery owned by this sink. */
    dispose(): void
    readonly disposed: boolean
    readonly pendingCount: number
}

type Timer = ReturnType<typeof setTimeout>

function reportFailure(onError: ((error: unknown) => void) | undefined, error: unknown): void {
    if (!onError) return
    try {
        onError(error)
    } catch {}
}

/**
 * Add ownership to a host notification sink without changing its payload.
 * Immediate delivery is deliberately fire-and-forget: a disconnected TUI must
 * never delay or fail compression. Timers are tracked so setup disposal can
 * cancel every delayed notice before it calls the delegate.
 */
export function createManagedNotificationSink(
    delegate: NotificationSink,
    options: { onError?: (error: unknown) => void } = {},
): ManagedNotificationSink {
    const timers = new Set<Timer>()
    let disposed = false

    const notify = (input: NotificationInput): void => {
        if (disposed) return

        try {
            const result = delegate.notify(input)
            if (result && typeof (result as PromiseLike<void>).then === "function") {
                void Promise.resolve(result).catch((error) => reportFailure(options.onError, error))
            }
        } catch (error) {
            reportFailure(options.onError, error)
        }
    }

    const notifyLater = (input: NotificationInput, delayMs: number): (() => void) => {
        if (disposed) return () => {}

        let timer: Timer | undefined
        const cancel = () => {
            if (timer === undefined) return
            timers.delete(timer)
            clearTimeout(timer)
            timer = undefined
        }

        timer = setTimeout(() => {
            if (timer !== undefined) timers.delete(timer)
            timer = undefined
            if (!disposed) notify(input)
        }, delayMs)
        timers.add(timer)
        return cancel
    }

    return {
        notify,
        notifyLater,
        schedule: notifyLater,
        dispose() {
            if (disposed) return
            disposed = true
            for (const timer of timers) clearTimeout(timer)
            timers.clear()
        },
        get disposed() {
            return disposed
        },
        get pendingCount() {
            return timers.size
        },
    }
}

export function isManagedNotificationSink(value: unknown): value is ManagedNotificationSink {
    if (value === null || typeof value !== "object") return false
    const candidate = value as Partial<ManagedNotificationSink>
    return (
        typeof candidate.notify === "function" &&
        typeof candidate.notifyLater === "function" &&
        typeof candidate.dispose === "function"
    )
}
