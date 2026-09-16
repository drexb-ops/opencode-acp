import type { QualityGateResult } from "./types"

export interface RejectionPlanInfo {
    startId: string
    endId: string
    summary: string
    messageIds: string[]
    messageTokenById: Map<string, number>
}

/**
 * A pre-commit quality failure is an expected, retryable tool outcome rather
 * than an ordinary execution failure.  The V2 tool transaction boundary uses
 * this marker to retain only the retry arm; every other speculative mutation
 * remains rolled back.
 */
export class QualityGateRejectionError extends Error {
    readonly code = "QUALITY_GATE_REJECTION"
    readonly plan: RejectionPlanInfo
    readonly result: QualityGateResult

    constructor(plan: RejectionPlanInfo, result: QualityGateResult) {
        super(formatQualityRejectionMessage(plan, result))
        this.name = "QualityGateRejectionError"
        this.plan = plan
        this.result = result
        Object.setPrototypeOf(this, new.target.prototype)
    }
}

function formatMetric(result: QualityGateResult, name: string): string {
    const m = result.metrics.find((x) => x.name === name)
    if (!m) return "?"
    switch (m.format) {
        case "percent":
            return `${m.value.toFixed(2)}%`
        case "ratio":
            return m.value.toFixed(4)
        default:
            return String(m.value)
    }
}

function computeStats(plan: RejectionPlanInfo): {
    originalTokens: number
    summaryChars: number
    ratio: string
    retentionPct: string
} {
    let originalTokens = 0
    for (const id of plan.messageIds) {
        originalTokens += plan.messageTokenById.get(id) || 0
    }
    const summaryChars = plan.summary.length
    const ratio =
        originalTokens > 0 ? (originalTokens / Math.max(summaryChars / 4, 1)).toFixed(1) : "?"
    const retentionPct =
        originalTokens > 0 ? ((summaryChars / (originalTokens * 4)) * 100).toFixed(2) : "?"
    return { originalTokens, summaryChars, ratio, retentionPct }
}

function formatQualityRejectionMessage(plan: RejectionPlanInfo, result: QualityGateResult): string {
    const stats = computeStats(plan)
    const metrics = [
        `Reason: ${result.reason || "unknown"}`,
        `Original: ~${stats.originalTokens} tokens`,
        `Summary: ${stats.summaryChars} chars`,
        `Ratio: ${stats.ratio}:1`,
        `Retention: ${stats.retentionPct}%`,
        `Gate layer: ${result.layer ?? "unknown"}`,
        `rougeF1: ${formatMetric(result, "rougeF1")}`,
        `top20Recall: ${formatMetric(result, "top20Recall")}`,
    ]

    // Keep this payload small: it is returned to the model as tool output on
    // every rejection, and the full HOW TO COMPRESS rules already live in the
    // system prompt (lib/prompts/system.ts) — re-injecting them here defeats
    // compression. Restate only a targeted retry hint.
    const message = `⚠️ COMPRESSION REJECTED — QUALITY GATE FAILURE

Range: ${plan.startId}–${plan.endId}
${metrics.join("\n")}

Retry: rewrite a more complete summary that preserves critical details (file paths, decisions, exact values, errors) and call compress again on the same range — the gate re-evaluates automatically. Full compression rules are already in your system prompt. If you are confident the summary is correct despite the metrics, add "acknowledgeRisk": true to bypass the quality gate on your next compress call.`

    return message
}

export function buildQualityRejectionError(
    plan: RejectionPlanInfo,
    result: QualityGateResult,
): QualityGateRejectionError {
    return new QualityGateRejectionError(plan, result)
}
