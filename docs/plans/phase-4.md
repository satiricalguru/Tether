# Phase 4 — Tool harness

## Goal

Local models (8B–32B) call tools reliably, whatever their capabilities, and
a first agent loop proves it on read-only tasks: navigate, open tabs, wait,
extract, answer. The harness does the heavy lifting: it picks the right
tool-calling tier per model, validates every call before running it, and
repairs bad output once before giving up.

## Three tiers (spec §5), chosen per model

| Tier          | When                                           | Request                                                                                                  | Parse                                                                                   |
| ------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1 native      | `capabilities.nativeTools`                     | OpenAI-shaped `tools`                                                                                    | `tool_calls`; if the model answers in text instead, the tier 3 parser runs on that text |
| 2 constrained | no native tools, but `grammar` or `jsonSchema` | llama.cpp: GBNF from the action union; others: JSON Schema `anyOf` of `{thought, action, args}` per tool | JSON                                                                                    |
| 3 text        | neither                                        | XML-ish `<action name="…"><arg name="…">…</arg></action>` protocol in the system prompt                  | tolerant parser                                                                         |

`E_TOOLS_UNSUPPORTED` from tier 1 (Phase 1's persisted downgrade) drops to
tier 2 automatically, mid-run. A setting (`agent.toolTier`) can force a tier.

## Modules

```
src/agent/
  types.ts          ToolSpec, ToolCall, ParseResult, AgentEvent, RunResult
  schema.ts         JSON-Schema subset validator with coercion (no ajv: it codegens with new Function, which the CSP forbids)
  tools/            tool specs + executors: navigate, newTab, switchTab, waitFor, extract, askUser, done
  harness.ts        tier selection, request building, response → validated ToolCall, one repair round
  loop.ts           observe → decide → validate → execute, with budgets (steps, wall clock, consecutive failures)
  observation.ts    compact page snapshot (URL, title, tabs, fenced readable text); Phase 5 adds the element action space
  guard.ts          URL policy for navigation: http(s) only, a default-deny list (banking, payments, *.gov, webmail), user lists
  trace.ts          every step → IndexedDB traces
src/prompting/
  system.ts         agent system prompts per tier
  tools-fallback.ts tolerant text parser (XML protocol plus leaked native formats: Hermes <tool_call>, Llama <|python_tag|>, Mistral [TOOL_CALLS], Gemma tool_code, Phi function calls, bare JSON)
  grammars/         GBNF generator and JSON Schema union builder
```

## Parser corpus

`tests/fixtures/model-outputs/*.json`: 30+ outputs, each with the expected
call or the expected error. Real captures from ornith-1.5:9b (via a
temporary `ollama serve`) are tagged `captured`. Hand-written failures
modelled on Llama 3.1 8B, Qwen3 8B, Mistral Nemo, Gemma 3 12B and Phi-4
quirks are tagged `handwritten`. Covered: missing close tags, stray prose,
markdown fences, duplicated blocks, args as attributes or JSON, wrong case,
near-miss tool names, string-typed numbers, truncated output.

## Agent run

- Background-owned `agent` stream (it drives tabs, so it must outlive panel
  re-renders). Stop = port disconnect.
- Events: `tier`, `step` (thought, action, args, outcome, observation
  summary), `status`. Done: `{ status: done | failed | stopped | needs-user,
summary, result?, steps }`.
- Progress memory: one compact line per step, with the last 8 in the prompt
  and reasoning never fed back.
- Budgets: 15 steps, 5 minutes, 3 consecutive failures (configurable).
  Phase 5 adds loop detection, critique and the full guard tiers.
- The panel shows a live step timeline inside the chat (Agent toggle in the
  composer); the final answer becomes the assistant message.
- Agent runs need site access: an in-flow request for all sites (or the
  task's site) before starting.

## Eval harness (`pnpm eval`)

Playwright with the real extension and model (temporary Ollama instance),
plus read-only fixture sites (a small shop and a trail guide). Each task has
a success assertion. The harness runs every task in each forced tier and
prints a pass-rate table with step counts. The baseline goes in the README.

## Tests

- Unit: validator and coercion, GBNF and schema generation (golden plus
  parse-ability of real model outputs), the parser corpus, tier selection,
  the repair round, the loop with a scripted fake model (budgets,
  consecutive failures, askUser, done), guard URL policy, tools against
  fake tabs.
- E2E (mock model with scripted tool calls): agent navigates fixture pages
  and answers; stop works; the trace is written; a blocked domain is refused.
- Eval: real model, three tiers.
