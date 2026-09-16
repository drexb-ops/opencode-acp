/**
 * Small lifecycle fence shared by every asynchronous V2 adapter operation.
 *
 * V2.0.3 does not expose an abort signal to tool callbacks, so running work is
 * allowed to finish. Deactivation prevents new work, invalidates leases that
 * have not reached their commit point, and lets setup await all work before it
 * tears down host registrations and notification sinks.
 */
export type V2OperationKind = "context" | "tool" | "command" | "timing" | "proxy"

export interface V2OperationLease {
    readonly kind: V2OperationKind
    readonly generation: number
    isActive(): boolean
    complete(): void
}

export class V2OperationTracker {
    private active = true
    private generation = 0
    private readonly inFlight = new Set<Promise<void>>()

    get isActive(): boolean {
        return this.active
    }

    /**
     * Reserve an operation synchronously. The returned operation remains part
     * of the in-flight set until `complete`, even when its callback is blocked
     * on host I/O.
     */
    enter(kind: V2OperationKind): V2OperationLease | undefined {
        if (!this.active) return undefined

        const generation = this.generation
        let finish!: () => void
        const settled = new Promise<void>((resolve) => {
            finish = resolve
        })
        this.inFlight.add(settled)
        let completed = false
        return {
            kind,
            generation,
            isActive: () => this.active && this.generation === generation,
            complete: () => {
                if (completed) return
                completed = true
                this.inFlight.delete(settled)
                finish()
            },
        }
    }

    /** Run a fenced operation, returning undefined when setup is inactive. */
    async run<T>(
        kind: V2OperationKind,
        operation: (lease: V2OperationLease) => T | Promise<T>,
    ): Promise<T | undefined> {
        const lease = this.enter(kind)
        if (!lease) return undefined
        try {
            return await operation(lease)
        } finally {
            lease.complete()
        }
    }

    /** Invalidate all leases and prevent future reservations. */
    deactivate(): void {
        if (!this.active) return
        this.active = false
        this.generation++
    }

    /** Wait until all operations reserved before deactivation have settled. */
    async waitForIdle(): Promise<void> {
        while (this.inFlight.size > 0) {
            await Promise.allSettled([...this.inFlight])
        }
    }
}
