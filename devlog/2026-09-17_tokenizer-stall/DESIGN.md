# DESIGN — Reuse the stateless tokenizer vocabulary

`@anthropic-ai/tokenizer@0.0.4` exports getTokenizer(), while its countTokens()
convenience function constructs and frees a tokenizer on every call. ACP's
request-level accounting magnifies that pre-existing cost across hundreds of
messages and multiple transform stages.

Use one lazily initialized encoder per module/runtime. Preserve the library's
NFKC normalization and allowed-special-token policy. Synchronous encoding is
serialized by the JavaScript runtime; no session state or text-result cache is
shared. Encoder failure must preserve the existing heuristic fallback and permit
safe reinitialization. The vocabulary allocation is bounded and lives with the
loaded module rather than one request or session.

Verification separates algorithm equivalence, repeated-call cost, realistic
long-history replay, and actual private OpenCode health/stream responsiveness.
Increasing watchdog timeouts or re-enabling the shared plugin to test is not the
chosen remedy.
