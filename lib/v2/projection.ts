/** Stable V2 projection API. Implementation is split by responsibility. */
export type * from "./projection/types"
export { normalizeV2ProjectedHistory, normalizeV2Messages } from "./projection/normalize"
export { applyV2ContextPatch, deriveV2ContextPatch, patchV2Messages } from "./projection/patch"
export { isAcpOwnedId, isAcpOwnedNoticeId, isAcpSyntheticId } from "./projection/shared"
