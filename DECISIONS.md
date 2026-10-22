# Decisions

Assumptions made without asking, and architecture decisions with their
reasoning. Newest entries at the bottom of each section.

## Assumptions

- **Repo root is `tether/`** inside the working directory, matching the
  structure in the build spec. Git is initialised there.
- **Plan mode = written plan.** Each phase's plan is written to
  `docs/plans/phase-N.md` and then executed without waiting for an approval
  round-trip; the spec forbids clarifying-question loops.
- **TypeScript 5.9**, not 7.x. The spec fixes "TypeScript 5.x", and
  typescript-eslint supports `<6.1`.
- **Vite 8.** `@wxt-dev/module-react` pulls `@vitejs/plugin-react@6`, which
  requires Vite 8. WXT, Tailwind's Vite plugin and Vitest 5 all accept it.
- **pnpm 12** (current via corepack). It blocks dependency build scripts by
  default; `pnpm-workspace.yaml` allow-lists only `esbuild`.
- **Firefox minimum 128** (ESR). Firefox targets MV3 (`--mv3`); WXT would
  otherwise default Firefox to MV2.
- **Side panel E2E opens `sidepanel.html` as a page.** Playwright can't click
  the toolbar button, so tests assert the action is configured to open the
  panel (`getPanelBehavior`) and exercise the panel page directly.

- **Built-in endpoints are disabled, not deleted.** Ollama, LM Studio,
  llama.cpp and vLLM always exist in settings (re-added by sanitization if
  missing); custom endpoints can be removed.
- **LM Studio has no grammar support** in Tether: its OpenAI endpoint takes
  `response_format: json_schema` but no GBNF parameter. Spec §4.1 lists it
  among grammar backends; the capability is reported as `false`.
- **llama.cpp context length is `n_ctx`** (what the server allocated), not
  the model's trained maximum, because that is the limit requests hit.
- **No real model runs in this environment** (no Ollama/LM Studio
  installed), so the stream fixture corpus in `tests/fixtures/streams` is
  hand-written to match each server's documented wire format, including
  usage/timings blocks, tool-call deltas and multi-byte text.

- **Verified against a real model.** Ollama 0.40.6 with ornith-1.5:9b
  (Q4_K_M) on an Apple M2 (16 GB): about 8 s cold load, about 15 tok/s,
  about 0.6 s warm TTFT. Real stream captures live in
  `tests/fixtures/streams/real-*`.
- **Ollama 0.40.6 still rejects `chrome-extension://` origins by default**
  (403 with an empty body on GET and POST). The `OLLAMA_ORIGINS` fix stays
  necessary.
- **`num_ctx` defaults to 8192.** Ollama's own default (4096 in 0.40.6) is
  too small for multi-turn chat with a system prompt. Changing `num_ctx`
  makes Ollama reload the model once.
- **Version navigation shows the newest leaf.** Selecting an earlier version
  of a message descends to that branch's most recent reply, rather than
  remembering the last one viewed.

- **Headless Chromium downloads PDFs** instead of opening the viewer, so
  _This PDF_ is covered by unit tests of the loader (exact URL, permission
  gate, viewer-URL unwrapping) rather than E2E. _Attach PDF_ is covered
  end to end.
- **The highlight bubble defaults on**, but only appears where Tether may
  read: localhost out of the box, plus whatever sites the user allows.
- **The real-model injection check**: ornith-1.5:9b, given the injection
  fixture, recommended the review's real pick and told the user it was
  ignoring the embedded instruction.

- **The agent doesn't prompt for all-sites access up front.** Playwright
  showed that an unanswerable prompt blocks the run forever, and many users
  would decline before seeing what the agent needs. Runs start with the
  current access; unreadable pages are reported to the model as such, and
  the run card offers _Allow on all sites_.
- **Phase 4 tool set is read-only**: navigate, back, newTab, switchTab,
  waitFor, extract, askUser, done. The parser corpus and grammar tests use
  the full spec §6.2 action space, so they stay valid for Phase 5.
- **GBNF is verified without llama.cpp** (not installed here) by a
  hand-written GBNF recognizer in `tests/helpers/gbnf.ts`. Tier 2 on Ollama
  uses JSON Schema `format`, which Ollama compiles to a grammar itself.

## Architecture decisions

### ADR-001 Content script is injected on demand, not declared for all sites

The content script uses WXT `registration: 'runtime'` and is injected with
`scripting.executeScript` (via `activeTab`, or localhost host permissions).
WXT copies the script's `<all_urls>` matches into `host_permissions`; a
`build:manifestGenerated` hook strips it so installing Tether does not ask
for "read and change all your data on all websites". `<all_urls>` stays an
optional permission requested in-flow when the user enables features that
need it on every page (highlight bubble, inline compose — Phase 3/6), at which
point the script is registered with `scripting.registerContentScripts`.

### ADR-002 Message namespaces by handling context

All `runtime.sendMessage` traffic uses an envelope `{__tether:1, type,
payload}` and types are prefixed by the context that answers them (`bg:`,
`content:`, `offscreen:`). A router only responds to types it registered, so
the side panel, options page and offscreen document can all listen on
`runtime.onMessage` without racing to answer. Handler errors travel back as
`{ok:false, error}` and are rethrown on the caller's side with their `code`.

### ADR-003 Streaming over `runtime.Port` with client heartbeats + alarm

Model output streams over a port (ordered, cancellable by disconnect, keeps
the MV3 worker alive while messages flow). Two mechanisms cover silent
periods such as a 60 s cold model load:

1. the client posts a heartbeat every 20 s over the port;
2. the background runs a `chrome.alarms` keepalive while any stream is
   active. Chrome clamps alarm periods to ≥30 s, so the alarm period is 30 s,
   not the 20 s in the spec; the 20 s requirement is met by (1).

### ADR-004 Background-only helpers live in `src/background/`

The spec's tree puts the router in `entrypoints/background.ts`. Handlers that
are background-only but unit-testable (e.g. the echo stream) live in
`src/background/` so the entrypoint stays a thin wiring file.

### ADR-005 Settings merge over defaults with type guards

Settings are one object in `chrome.storage.local`, always merged over
`DEFAULT_SETTINGS` with a type-checking deep merge. New fields therefore never
need migrations, and corrupted values fall back to defaults rather than
crashing the UI. Reshapes go through numbered `MIGRATIONS`.

### ADR-006 Offscreen document gets nothing but messaging

Offscreen documents can only use `runtime` messaging (no `getManifest`,
`storage`, `tabs`). Anything else must come from the background worker or be
baked in at build time. Found by the E2E suite, not assumed.

### ADR-007 Dependencies added in Phase 0

| Package                                                       | Why                                                                                           |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `wxt`, `@wxt-dev/module-react`                                | Fixed by spec.                                                                                |
| `react`, `react-dom` 19                                       | Fixed by spec.                                                                                |
| `tailwindcss` 4, `@tailwindcss/vite`                          | Fixed by spec.                                                                                |
| `radix-ui`                                                    | Fixed by spec (Radix primitives); the unified package avoids a dozen `@radix-ui/*` entries.   |
| `class-variance-authority`, `clsx`, `tailwind-merge`          | The standard shadcn-style variant trio for vendored components.                               |
| `lucide-react`                                                | Icon set used by shadcn; tree-shaken, bundled.                                                |
| `zustand`, `@tanstack/react-query`                            | Fixed by spec (used from Phase 1/2).                                                          |
| `dexie`                                                       | Fixed by spec.                                                                                |
| `vitest`, `jsdom`, `fake-indexeddb`, `@testing-library/react` | Unit tests; WXT's `fakeBrowser` covers extension APIs.                                        |
| `@playwright/test`                                            | Fixed by spec.                                                                                |
| `@types/chrome`                                               | Only for `chrome.*` inside Playwright `evaluate()` callbacks; source code uses `wxt/browser`. |

### ADR-008 Ollama health check includes a POST origin probe

Verified in real Chromium (E2E): Chrome sends the extension's `Origin`
header from the service worker on **POST only, not GET**. Ollama's
`OLLAMA_ORIGINS` check therefore lets `GET /api/version` through and
rejects `POST /api/chat` with an empty 403. The Ollama health check follows
the GET with `POST /api/show` for a model that doesn't exist: 404 means the
origin is allowed, 403 means blocked. Without this the Doctor would report
"Connected" for a server that refuses every chat.

### ADR-009 One guarded HTTP client; discovery widens it only while probing

`HttpClient` refuses origins outside configured endpoints + the fixed
discovery ports. `discover()` adds its candidates' origins before probing
(probing _is_ contacting). Non-local origins also need a granted host
permission, checked before any socket is opened.

### ADR-010 Capability downgrades are persisted per (endpoint, model)

Generic OpenAI servers can't be probed, so capabilities start optimistic.
A 400/422 (or llama.cpp's 500 "requires --jinja") on a request carrying
`tools`, unless the message is about context length, persists
`nativeTools:false` and raises `E_TOOLS_UNSUPPORTED` for the Phase 4
harness to fall back to tier 2/3. `stream_options` rejections persist
`streamUsage:false` and retry once. Stored in `chrome.storage.local`
(`tether:capability-overrides`); a "Forget learned limits" button clears
them per endpoint.

### ADR-011 Tool-call deltas are assembled in the adapter

OpenAI-style servers stream tool calls as fragments; Ollama sends them
whole. Adapters always emit one complete `tool_calls` chunk, so the tool
harness never sees partial JSON.

### ADR-012 Inline `<think>` handling lives in the provider layer

`ThinkSplitter` normalizes inline reasoning tags into `reasoning` chunks, so
every consumer gets the same shape whether the server separates reasoning
(`message.thinking`, `reasoning_content`) or not. An opening tag counts only
before visible text, and a closing tag with no opening tag reclassifies the
text so far (`reclassify-reasoning`), which covers templates that put
`<think>` in the prompt.

### ADR-013 TTFT watchdog keyed on "was it resident?"

The `chat` stream asks the provider whether the model is loaded
(`/api/ps`, LM Studio `state`) while the request is in flight. No first
token after 1.5 s for a known-cold model, or 3 s when unknown, shows
"Loading model…". A hot model shows "Processing the prompt…" after 5 s.
Users can tell a cold load from a hang.

### ADR-014 Bundle egress scan runs as its own Vitest config

`tests/bundle/egress.test.ts` needs `.output/`, so it runs after
`pnpm build` (`pnpm test:bundle`, in `pnpm check` and CI) instead of in the
unit suite, which must pass without a build.

### ADR-015 Distinct React keys for buttons that swap type

Found by E2E: when Stop (`type=button`) and Send (`type=submit`) shared one
reconciled `<button>`, settling the stream inside the click flipped the
element to `type=submit` before the browser's activation behaviour ran, and
the form resubmitted. Swapping buttons get distinct keys.

### ADR-016 Dependencies added in Phase 1

None. The parsers, HTTP client and mock server use platform APIs only
(`fetch`, `ReadableStream`, `TextDecoder`, `node:http`).

### ADR-017 Effective context window, not the model maximum

Found against real Ollama: ornith-1.5:9b advertises 262,144 tokens but runs
with a 4,096 window unless `num_ctx` is set. `Provider.runtimeContext()`
(Ollama `/api/ps`, llama.cpp `n_ctx`, LM Studio `loaded_context_length`)
feeds the metrics. The footer shows the window the request ran with, and the
model maximum separately.

### ADR-018 Markdown is rendered from tokens, never from HTML

`marked`'s lexer feeds a React renderer. There is no `innerHTML` anywhere.
Model output is untrusted and the side panel runs with extension
privileges. Raw HTML renders as text, and links are limited to
http(s)/mailto with `noopener`. **Images are never loaded**: a remote
`<img>` would be egress and a tracking pixel, so they render as a chip that
links out. Code highlighting uses shiki's JavaScript regex engine, so the CSP
needs no `wasm-unsafe-eval`. Grammars are code-split per language (about
2–190 KB each, C++ about 850 KB) and loaded on first use. The total bundle
grew to about 2.9 MB, almost all of it lazy grammar chunks.

### ADR-019 The conversation tree is walked in memory

Messages point at their parent; regenerate and edit create siblings. The
tree is not indexed by `[conversationId+parentId]`, because IndexedDB can't
index the `null` root parent. Conversations are small, so all messages of one
conversation are loaded and walked. Sibling order uses strictly increasing
per-conversation timestamps.

### ADR-020 The generation runner lives in the panel

The runner writes the reply into IndexedDB (throttled to about 4 writes a
second, plus a final write). Closing the panel aborts the port, and the
partial reply is kept as `stopped`. Replies left `streaming` by a crashed
panel are marked `stopped` on the next open. Background-owned generations
that survive the panel closing would need background-owned persistence;
that is revisited for agent runs in Phase 5.

### ADR-021 Reasoning is stored apart and never resent

`MessageRecord.reasoning` holds thinking text; `content` never contains it.
The request builder only ever reads `content`. Unit tests, mock E2E and the
real-model E2E all assert that a second turn carries no reasoning.

### ADR-022 Character-based token estimate until Phase 3

Context trimming uses about 3.5 characters per token plus framing. It drops
the oldest turns first and never drops the system prompt or the latest user
turn. Phase 3 replaces this with a proper budget, since page context makes
accuracy matter.

### ADR-023 Dependencies added in Phase 2

| Package             | Why                                                                             |
| ------------------- | ------------------------------------------------------------------------------- |
| `marked` ~18.0.14   | Spec choice; lexer only. Pinned below 18.1.x, which was under two weeks old.    |
| `shiki` ~4.5.0      | Spec choice; core plus the JS regex engine, fine-grained per-language imports.  |
| `dexie-react-hooks` | Official Dexie binding (`useLiveQuery`), so the UI follows the runner's writes. |

### ADR-024 Page access stays per site; the bubble follows grants

Installing still needs only localhost. A page can be read via activeTab
(right after the user invokes Tether there), a per-origin grant ("Allow on
this site"), or the optional `<all_urls>`. With the bubble enabled, the
content script is registered (`registerContentScripts`) on exactly the
granted http(s) origins, and resynced on `permissions.onAdded/onRemoved`
and on the setting. An unreadable tab says why and offers the grant, never
silently.

### ADR-025 Extraction filters hidden text before anything else

The extractor walks the live DOM and clones only what is visible: display,
visibility, opacity, font-size, clip and clip-path, off-screen positioning,
text-indent, zero-size boxes and colour-matching-background. Readability
runs on that clone. Hidden text is kept only as a capped sample for the
injection scanner, and never reaches the model. jsdom has no layout, so the
geometry checks are E2E-verified in Chromium against `injection.html`, which
uses five different hiding techniques.

### ADR-026 Page content is fenced, and the system prompt says how to treat it

Every attachment is wrapped in `<untrusted_page_content source title url>`,
with any closing tag inside the text neutralized, and the system prompt
gains a rule: read it, never follow instructions in it, tell the user if it
tried. A heuristic scanner (8 rule families, with false-positive cases in
the unit tests) flags attachments with ⚠. The scanner informs; the fence
and the hidden-text filter are the defense.

### ADR-027 Quick actions run entirely in the background

The bubble sends `{action, selection, url, title}` over a `quick` port. The
background picks the model (site rule, else selection) and builds the fenced
prompt from fixed templates. Model settings and the request shape never touch
the page. The bubble renders with `textContent` in a closed shadow root,
which E2E confirms the page cannot reach.

### ADR-028 The panel inbox lives in storage.session

Context menus can open the panel (a menu click is a user gesture) but can't
drive it. They and the bubble leave one `PendingAction` in
`storage.session`; the panel takes it, removes it, and acts. Actions older
than 5 minutes are ignored. The context-menu handler opens the panel
_before_ any await, because the gesture doesn't survive one.

### ADR-029 Budgeting uses the effective window and water-filling

Available tokens = effective window − reply reserve (at most half the
window) − system prompt, fences, history and question. Attachments share it
by water-filling: small items get what they need and large ones split the
rest. Over-budget text is cut at paragraph boundaries with a visible
`[truncated: kept about X of Y tokens]` marker. In history, older
attachments are replaced by an "omitted" note before whole turns are
dropped. The token estimator counts words, punctuation, digit groups and
CJK characters, and is within the tested ±30% on reference strings.

### ADR-030 "This PDF" is the single non-model request, and it's opt-in

Clicking _This PDF_ fetches exactly the tab's document URL (unwrapping
Chrome's viewer URL) through an `HttpClient` whose allowlist is that one
origin, only with the user's permission for that origin. It is documented
in the README's privacy section. pdf.js runs in the panel from the
**legacy** build: the modern 6.3 build needs `Uint8Array.prototype.toHex`
(Chrome 140+), and the extension supports 120+. pdf.js and its worker are
lazily loaded; the background imports only `pdf-url.ts`.

### ADR-031 "This page" skips Tether's own tab

When the panel runs as a tab (where no side panel API exists), the active
tab is the panel itself. `currentPageTab()` uses the most recently used
non-extension tab in the window instead.

### ADR-032 Dependencies added in Phase 3

| Package                      | Why                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `@mozilla/readability` 0.6.0 | Firefox Reader View's algorithm; the de-facto standard for main-content detection.    |
| `pdfjs-dist` ~6.3.289        | Spec choice for PDF text. Legacy build (see ADR-030); lazy chunk plus emitted worker. |

### ADR-033 Tool-calling tier per model, with mid-run fallback

`selectTier`: native if `capabilities.nativeTools`, else constrained if the
server has a grammar or JSON-schema mode, else text. `E_TOOLS_UNSUPPORTED`
(Phase 1's persisted downgrade) drops a running agent to the next tier
without losing the step. `agent.toolTier` forces a tier, which is what the
eval uses. A native-tier model that answers in text instead of calling a
tool is parsed with the tier-3 parser rather than failed.

### ADR-034 Stateless steps with a compact progress log

Every step is one fresh request: system prompt, then task, then the last 8
progress lines, then the current observation. It is not a growing
transcript, because small context windows are the binding constraint and
long histories degrade small models. Model reasoning is never included
(a test injects a marker into reasoning and asserts it never reappears).

### ADR-035 Validate before execute; repair once, free

Every call is validated against its tool's schema by a CSP-safe validator
(`ajv` is out: it code-generates with `new Function`), with unambiguous
coercions (`"42"` → 42, `"true"` → true, case-insensitive enums). An
unusable reply gets exactly one repair round: the model sees its own reply
and the specific error. Unusable replies don't count as steps, but three in
a row end the run.

### ADR-036 One tolerant parser for every text format small models emit

`parseToolCall` accepts the protocol (`<action name>` / `<arg>`) and the
native formats models leak (Hermes `<tool_call>`, Llama `<|python_tag|>`,
Mistral `[TOOL_CALLS]`, Gemma `tool_code`, Phi function calls, bare and
OpenAI-style JSON). Values are converted by the tool's schema. Name
resolution normalizes case and separators and accepts only unambiguous
one-letter typos on longer names. Errors are short and specific because
they are fed back to the model. The corpus is 54 outputs: 25 captured from
ornith-1.5:9b, which showed child-element args, copied placeholders and an
invented nested action, plus hand-written quirks for Llama 3.1, Qwen3,
Mistral Nemo, Gemma 3 and Phi-4.

### ADR-037 Agent navigation is browsing, gated by the URL guard

Tether's zero-egress guarantee covers requests Tether makes; those still go
only to configured model endpoints. Agent navigation is different: the
browser loads pages on the user's behalf, as if the user clicked. Every
navigation passes `checkUrl`: http(s) only; default-deny for banking,
payment, government and webmail hosts; a user allow-list can override the
defaults and a user block-list always wins. Phase 5 must also treat
navigation as a possible exfiltration channel (an injected page steering the
agent to a URL that carries user data), and add action tiers and
confirmations.

### ADR-038 Navigation waits for a loading → complete cycle

The listener is attached before the navigation starts, and only a
"loading" followed by "complete" ends the wait, so the previous page's
status can't end it early. Same-document navigations never report
"loading", so a complete tab after a 1.5 s grace period is accepted. A
timeout resolves rather than fails, because a slow page is still usable.

### ADR-039 extract is a model sub-call

`extract(schema)` sends the fenced page text to the same model with a
JSON-schema response format. Schemas can be shorthand (`{"price":"number"}`,
`[{…}]`) and are expanded to JSON Schema. DOM-level extraction of tables
and lists can join it in Phase 5.

### ADR-040 Runs are stored on their assistant message; traces separately

The live step timeline is saved on the assistant message (`agent`), so it
renders after a reload and in history. Every step also goes to the
`traces` table, with card numbers, SSN-like patterns and token-like strings
redacted, ready for Phase 5's trace viewer.

### ADR-041 Dependencies added in Phase 4

None.

## Phase 5 — Computer use

### ADR-042 Actions are classified by the harness, never by the model

`src/agent/tiers.ts` puts every call in one of four tiers before it runs:
read, navigate, write or irreversible. A fifth outcome, refuse, covers
credential fields and secret-looking text. Irreversible means a form
submit, a download, or an element whose name matches a fixed word list
(buy, pay, place order, delete, send, submit, publish …). "Checkout" and
"share" are deliberately left out, because they usually just open the next
page. The model never sees or sets the tier. The full model is in
[docs/safety.md](docs/safety.md).

### ADR-043 Confirmations travel over the run's own port

An irreversible action pauses the loop on a promise. The background sends a
`confirm` event down the agent stream, and the panel answers with the new
client→server `input` message (`{type:'confirm', id, approved}`). No second
channel, no polling. Time spent waiting is added back to the run's
deadline. With no panel listening (no confirmer), the action is refused,
never silently allowed. A denial isn't a failure: the model is told the
user declined and must not retry it.

### ADR-044 Credentials are refused twice

The background guard refuses `type`/`setValue` into password,
one-time-code and `cc-*` fields, fields labelled like PIN/CVV/IBAN/SSN, and
text that looks like a card number, SSN or API key in any field. The page
engine checks the live element again before acting, in case the snapshot
was stale. A login page therefore ends a run in `needs-user`.

### ADR-045 Navigation is checked for exfiltration

Before `navigate`/`newTab`, `carriesData` compares the URL's path, query
and fragment with text the agent saw in the task or on pages from other
hosts. Both sides are normalised to words of four or more letters, and a
shared run of six words refuses the navigation. This catches the classic
injection "open evil.example/?q=<what you read>" without blocking ordinary
search URLs. Paraphrased or encoded leaks aren't caught (documented
limit).

### ADR-046 No-op and loop detection from page hashes

After every action, a fresh snapshot is taken and cached as the next step's
observation, so there's no extra cost. If the URL and the snapshot hash are
unchanged, the step is marked `noop` and the model is told to try a
different element. The same action on the same element (by role and name,
not id, because ids change) warns the model at 3 and aborts the run at 5.

### ADR-047 One critique call before accepting "done"

Small models often claim success early. When `agent.critique` is on (the
default), the first `done` triggers one JSON-schema call that checks the
claim against the final page: `{complete, reason}`. If it says incomplete,
the run continues with the reason as feedback. A second `done` is
accepted. A critique that errors never blocks finishing.

### ADR-048 Scripted events by default, CDP as an opt-in backend

Content-script events work on almost every site and need no extra
permission. The `debugger` permission is optional and requested in the
click handler that enables it. When it's enabled, click, hover, type and
key events go through `Input.dispatch*` at the element's centre point.
Everything else, and any failure, falls back to scripting. Chrome's own
"is being debugged" bar is the user-visible signal.

### ADR-049 The kill switch lives in the page, in a closed shadow root

Each controlled tab shows a banner. Its Stop button and Esc on the page end
the run via `bg:agent:stop`. Both respond only to `isTrusted` events, so a
page script can't press them. The page can't style or remove the closed
shadow root's contents either. The banner follows the active tab.

### ADR-050 Interactive evals check app state, not words

Phase 5 adds 13 tasks across 12 fixture apps (search filters, a
three-step checkout with approve and deny variants, login and CAPTCHA
hand-offs, infinite scroll, a shadow-DOM modal, same-origin iframe forms,
a paged table, an injection that asks for an account deletion, a todo app,
custom controls and a cookie wall). Each check reads what the app wrote to
storage, the final URL and the confirmations the harness answered. The
harness answers confirmations by clicking the real panel buttons.

### ADR-051 Agent budgets come from the window the model really has

Ollama and LM Studio load a model with a 4K window by default, whatever its
maximum. Budgeting from the maximum overflowed it: a four-scroll run hit
"request (4503 tokens) exceeds the available context size (4096)". The
window is now, in order: the configured `num_ctx`, the window the server
reports for the loaded model, or 4096. The fixed cost of a step is measured
first: the system prompt plus tool schemas, or the text-tier prompt,
whichever is larger. Room for the task, progress notes (600 tokens) and the
reply (512) is also reserved. 85% of the remainder is split 60/40 between
the element list and the page text.

At 8K or less the agent gets the 14 core tools. It drops newTab,
switchTab, forward, reload, closeTab, rightClick and hover. Every schema
costs prompt space, and small tasks rarely need these seven.

### ADR-052 A decline is remembered; removing a cart item isn't irreversible

The first eval runs showed two problems. In one, the model retried a
declined click four times, and each retry asked the user again. Declined
actions are now remembered for the run, keyed by page, action and element
like loop detection, and a repeat is refused without asking. In the other,
"Remove <item>" on a cart counted as irreversible, though it's easy to
undo. The word list now gates only "remove account/user/member"; "delete"
still counts.

### ADR-053 Loops are judged by page state; page text follows the scroll

The first full interactive eval (18/37) showed two harness faults on the
infinite-scroll task. Five scrolls that each loaded new entries were
stopped as a loop. And PAGE TEXT always began at the top of the page, so
entries loaded at the bottom never reached the model. Loop detection now
counts repeats twice. The same action in the same page state (content
hash and scroll position) warns at 3 and stops at 5. The same action
whatever the state warns at 5 and stops at 8, for pages that change
without getting anywhere. The page text sent each step is the slice that
matches the scroll position, with a note on how much is above and below.

The same run showed two eval tasks that couldn't be passed:
`injection-action` and `todo-edit` denied every confirmation, including
saving the form the task asked for. A task's `confirm` can now be a
pattern: approve everything except matching actions (here, deletions).
Eval runs also cap the agent at 4 minutes, inside the test's own timeout.
