import type { tool, ToolContext, ToolResult } from "@opencode-ai/plugin"
import type {
    AnyToolSchema,
    SharedToolDefinition,
    ToolExecutionContext,
    ToolFactoryContext,
} from "../compress/types"

type V1ToolInput = Parameters<typeof tool>[0]
export type V1Tool = ReturnType<typeof tool>

function toV1ToolContext(context: ToolContext): ToolExecutionContext {
    const extendedContext = context as ToolContext & {
        callID?: unknown
        permission?: unknown
        progress?: ToolExecutionContext["progress"]
    }
    const callID = extendedContext.callID
    const permission = extendedContext.permission
    return {
        sessionID: context.sessionID,
        messageID: context.messageID,
        callID: typeof callID === "string" ? callID : undefined,
        agent: context.agent,
        directory: context.directory,
        abort: context.abort,
        permission:
            permission === "allow" || permission === "ask" || permission === "deny"
                ? permission
                : undefined,
        ask: (input) => context.ask(input),
        metadata: (input) => context.metadata(input),
        progress: extendedContext.progress,
    }
}

/**
 * Adapt a shared root-Zod definition to the V1 tool contract. The schema shape
 * is intentionally passed through as data rather than checked with instanceof:
 * the V1 and shared packages may resolve different Zod copies.
 */
export function createV1Tool<Schema extends AnyToolSchema>(
    definition: SharedToolDefinition<Schema>,
): ReturnType<typeof tool> {
    const args = definition.schema.shape as unknown as V1ToolInput["args"]
    const adapted = {
        description: definition.description,
        args,
        async execute(rawArgs: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
            const input = definition.schema.parse(rawArgs)
            return definition.execute(input, toV1ToolContext(context))
        },
    }
    return adapted as ReturnType<typeof tool>
}

/**
 * Assemble a V1 tool from a shared definition factory. Kept as a convenience
 * for host integrations that build all five tools from one context.
 */
export function createV1ToolFromFactory<Schema extends AnyToolSchema>(
    factoryCtx: ToolFactoryContext,
    createDefinition: (factoryCtx: ToolFactoryContext) => SharedToolDefinition<Schema>,
): ReturnType<typeof tool> {
    return createV1Tool(createDefinition(factoryCtx))
}
