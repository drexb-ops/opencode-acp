/*
 * Vendored verbatim from @opencode/core@2.0.3 (MIT License),
 * https://github.com/anomalyco/opencode — packages/core dist build d44b52c
 * (OpenCode v2.0.3). Used ONLY by regression tests to exercise the real host
 * toLLMMessages lowering; never imported by lib/. Do not edit.
 */
import {
  __export
} from "./mime-9rqn6x4v.js";

// src/session/provider-context.ts
var exports_provider_context = {};
__export(exports_provider_context, {
  Info: () => Info9,
  SessionProviderContext: () => exports_provider_context,
  compatible: () => compatible2,
  decode: () => decode2,
  encode: () => encode2,
  isCheckpoint: () => isCheckpoint2,
  provenance: () => provenance2,
  validate: () => validate2
});
import { Message } from "@opencode/ai";
import { SessionProviderContext } from "@opencode/schema/session-provider-context";
import { Schema } from "effect";
import { isDeepStrictEqual } from "node:util";
import { Hash } from "@opencode/util/hash";
var Info9 = SessionProviderContext.Info;
var messages = Schema.toCodecJson(Schema.Array(Message));
function provenance2(resolved) {
  const model = resolved.model;
  const endpoint = model.route.endpoint;
  if (!endpoint.baseURL || typeof endpoint.path !== "string")
    return;
  return {
    providerID: resolved.ref.providerID,
    provider: model.provider,
    modelID: model.id,
    route: model.route.id,
    protocol: model.route.protocol,
    endpoint: Hash.sha256(JSON.stringify([
      endpoint.baseURL,
      endpoint.path,
      Object.entries(endpoint.query ?? {}).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    ]))
  };
}
var compatible2 = (source, target) => target !== undefined && isDeepStrictEqual(source, target);
var isCheckpoint2 = (message) => message.type === "compaction" && message.status === "completed" && message.providerContext !== undefined;
var encode2 = (provenance, replacement) => ({
  version: 1,
  provenance,
  messages: Schema.decodeSync(Schema.fromJsonString(Schema.Json))(JSON.stringify(replacement.map((message) => ({
    ...message,
    content: message.content.map((part) => part.type === "media" && part.data instanceof Uint8Array ? { ...part, data: Buffer.from(part.data).toString("base64") } : part)
  }))))
});
var decode2 = (context) => Schema.decodeUnknownSync(messages)(context.messages);
var validate2 = (context) => Schema.decodeUnknownEffect(messages)(context.messages);

export { Info9, provenance2, compatible2, isCheckpoint2, encode2, decode2, validate2, exports_provider_context };
