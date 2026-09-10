import "../tests/test-env"
import { recoverFromParentState } from "../lib/state/fork-transfer"
import { rebuildCompressionState } from "../lib/state/rebuild"
import { createSessionState } from "../lib/state/state"
import { saveSessionState } from "../lib/state/persistence"
import { Logger } from "../lib/logger"
import type { SessionState, WithParts } from "../lib/state/types"

const logger = new Logger(false)
const PARENT_ID = "parent-session-375"
const FORK_ID = "fork-session-375"

function makeUserMessage(id: string, text: string, created: number, sessionID: string): WithParts {
    return {
        info: {
            id, sessionID, role: "user", agent: "assistant",
            time: { created },
            model: { providerID: "test-provider", modelID: "test-model" },
        } as WithParts["info"],
        parts: [{ type: "text", text, id: `${id}-p1`, sessionID, messageID: id }],
    }
}

function makeAssistantMessage(id: string, parts: any[], created: number, sessionID: string): WithParts {
    return {
        info: {
            id, sessionID, role: "assistant", agent: "test",
            time: { created }, parentID: "parent-1",
            modelID: "test-model", providerID: "test-provider", mode: "normal",
            path: { cwd: "/", root: "/" }, summary: false, cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as WithParts["info"],
        parts,
    }
}

const makeTextPart = (text: string): any => ({ type: "text", text })

function makeCompressPart(callId: string, input: any): any {
    return {
        type: "tool", tool: "compress", callID: callId,
        state: { status: "completed", input, output: "Compressed messages into [Compressed conversation section]." },
    }
}

function makeStrippedCompressPart(callId: string): any {
    return {
        type: "tool", tool: "compress", callID: callId,
        state: { status: "completed", output: "Compressed messages into [Compressed conversation section]." },
    }
}

function makeClient(parentMessages: WithParts[]): any {
    return { session: { messages: async (_opts: any) => ({ data: parentMessages }) } }
}

async function main() {
    // Use the test file's buildConfig by dynamic import won't work (not exported).
    // Inline minimal config matching tests/rebuild-parent.test.ts buildConfig().
    const { getConfig } = await import("../lib/config")
    const cfg = getConfig(undefined, undefined)

    // Parent: b1 = m1-m4, then b2 = m1-m8 NESTED (consumes b1)
    const input1 = { topic: "t1", content: [{ startId: "m00001", endId: "m00004", summary: "first range summary text" }] }
    const input2 = { topic: "t2", content: [{ startId: "m00001", endId: "m00008", summary: "second nested summary covering all" }] }

    const parentState = createSessionState()
    parentState.sessionId = PARENT_ID
    parentState.isSubAgent = false
    const parentMessages: WithParts[] = [
        makeUserMessage("p1", "hello", 1000, PARENT_ID),
        makeAssistantMessage("p2", [makeTextPart("hi")], 1001, PARENT_ID),
        makeUserMessage("p3", "do a task", 1002, PARENT_ID),
        makeAssistantMessage("p4", [makeTextPart("doing it")], 1003, PARENT_ID),
        makeAssistantMessage("p5", [makeCompressPart("call-1", input1)], 1004, PARENT_ID),
        makeUserMessage("p6", "more", 1005, PARENT_ID),
        makeAssistantMessage("p7", [makeTextPart("ok")], 1006, PARENT_ID),
        makeUserMessage("p8", "done", 1007, PARENT_ID),
        makeAssistantMessage("p9", [makeCompressPart("call-2", input2)], 1008, PARENT_ID),
    ]
    const rebuilt = rebuildCompressionState(parentState, parentMessages, cfg, logger)
    console.log("parent rebuilt blocks:", rebuilt)
    for (const [id, b] of parentState.prune.messages.blocksById) {
        console.log(`  parent b${id}: active=${b.active} deactivatedByBlockId=${b.deactivatedByBlockId ?? "-"} anchor=${b.anchorMessageId}`)
    }
    await saveSessionState(parentState, logger)

    // Fork copied p1..p5 only (stripped), then continued
    const forkMessages: WithParts[] = [
        makeUserMessage("f1", "hello", 1000, FORK_ID),
        makeAssistantMessage("f2", [makeTextPart("hi")], 1001, FORK_ID),
        makeUserMessage("f3", "do a task", 1002, FORK_ID),
        makeAssistantMessage("f4", [makeTextPart("doing it")], 1003, FORK_ID),
        makeAssistantMessage("f5", [makeStrippedCompressPart("call-1")], 1004, FORK_ID),
        makeUserMessage("f6", "new fork turn", 2000, FORK_ID),
    ]
    const client = makeClient(parentMessages)
    const forkState = createSessionState()
    forkState.sessionId = FORK_ID
    forkState.isSubAgent = false
    const recovered = await recoverFromParentState(client, forkState, forkMessages, PARENT_ID, logger)
    console.log("recovered (ACTIVE blocks transferred):", recovered)
    console.log("fork blocksById size:", forkState.prune.messages.blocksById.size)
    for (const [id, b] of forkState.prune.messages.blocksById) {
        console.log(`  fork b${id}: active=${b.active} anchor=${b.anchorMessageId}`)
    }
    if (recovered === 0) {
        console.log(">>> BUG CONFIRMED: parent-continued nested compression → transfer yields 0 → falls back to replay → 0 (runaway persists)")
    } else {
        console.log(">>> transfer works for nested case")
    }
}

main().catch((e) => { console.error(e); process.exit(1) })
