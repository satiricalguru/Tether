# Phase 1 — Providers

## Goal

Every supported local backend can be discovered, health-checked, diagnosed,
listed, capability-probed and streamed from, all through the background
worker, with the user told exactly how to fix anything that doesn't work.

## Module layout

```
src/providers/
  types.ts              Provider interface, ModelInfo, Capabilities, ChatRequest, ChatChunk
  http.ts               guarded fetch: origin allowlist, timeouts, error classification
  stream.ts             incremental SSE + NDJSON parsers over ReadableStream<Uint8Array>
  think.ts              streaming <think>/<thinking> splitter
  openai-core.ts        shared OpenAI chat/models/embeddings implementation
  ollama.ts             native /api/* (+ optional /v1 compat path)
  lmstudio.ts           /api/v0/models + /v1/*
  llamacpp.ts           /props, /health + /v1/*
  openai-compatible.ts  generic: optimistic tools + persisted runtime downgrade
  overrides.ts          persisted per-model capability downgrades
  registry.ts           configs → Provider instances, discovery, status, caches
src/background/chat.ts  'chat' stream: TTFT watchdog, status events, metrics
src/components/doctor/  Setup Doctor UI (options page + side panel)
tests/fixtures/mock-llm Mock backend server (Ollama / OpenAI / LM Studio / llama.cpp flavours)
tests/fixtures/streams  Captured raw response bodies used by parser + adapter tests
```

## Key contracts

- `Provider` follows spec §4.1, plus `instanceId`, `label`, and an optional
  `isLoaded(model)` used by the TTFT watchdog. `health()` returns
  `{ ok, version?, latencyMs, diagnosis }` where diagnosis is one of
  `ok | unreachable | timeout | origin-blocked | needs-permission |
auth-required | http-error | bad-response`.
- `ChatChunk`: `text | reasoning | reclassify-reasoning | tool_calls | usage`.
  Tool-call deltas are accumulated by the adapter and emitted once, complete.
- Every network call goes through `http.ts`, which refuses any origin not in
  the configured provider set (runtime half of the zero-egress guarantee; the
  bundle scan in `tests/bundle/` is the static half).
- 400/422 on a request carrying `tools` → persist `nativeTools:false` for that
  (instance, model) and throw `E_TOOLS_UNSUPPORTED` so the Phase 4 harness can
  fall back to tier 2/3. 400 mentioning `stream_options` → persist
  `streamUsage:false` and retry once without it.

## Discovery

Probe in parallel with a 1.2 s timeout: Ollama :11434, LM Studio :1234,
llama.cpp :8080, vLLM :8000, Jan :1337, KoboldCpp :5001,
text-generation-webui/TabbyAPI :5000. Fingerprint (`/api/version`,
`/api/v0/models`, `/props`, `/v1/models`) so e.g. LocalAI on :8080 is not
mistaken for llama.cpp. Found-but-unconfigured endpoints are added to settings.

## Diagnosis rules

- `TypeError` from fetch to a permitted host → **unreachable** (not running).
- Abort after 1.2 s → **timeout**.
- HTTP 403 from an Ollama endpoint (or any 403 with an empty body) →
  **origin-blocked**, with OS-specific `OLLAMA_ORIGINS` snippets containing
  the real extension ID.
- Non-local host without a granted origin permission → **needs-permission**
  (UI requests just that origin from the optional `<all_urls>` grant).
- 401 → **auth-required**.

## UI

- Options → _Providers_: Setup Doctor (status per backend, fix snippets with
  copy, rescan), per-provider edit (URL, API key, enable, Ollama compat
  toggle), add custom OpenAI-compatible endpoint, model list (hot first,
  params/quant/context/capability badges), per-model _Test_ that streams a
  short reply and shows TTFT / tok/s / prompt tokens / load time.
- Side panel: Doctor summary when nothing is reachable; otherwise a model
  picker + quick prompt that streams via the `chat` stream with live metrics
  and "loading model…" status (full chat is Phase 2). The Phase 0 echo
  transport check is removed; the real chat stream replaces it.

## Tests

- Unit: SSE/NDJSON parsers over fixture bodies split at **every** byte
  offset (incl. inside multi-byte UTF-8); think splitter; each adapter
  against fixture bodies via an injected fetch; downgrade persistence;
  http classification + origin guard; registry discovery/fingerprinting;
  chat service metrics + watchdog (fake timers).
- Mock LLM server with its own tests: slow TTFT, mid-stream disconnect,
  400 on tools, cold-load delay, Ollama-style origin rejection.
- E2E against the mock: Doctor shows connected + models, origin-blocked
  diagnosis shows the extension ID, quick prompt streams with metrics,
  stop aborts, cold model shows "loading model…".
- Bundle egress scan: every URL literal in `.output/chrome-mv3` must be a
  local default endpoint or an explicitly allow-listed non-fetched string.
