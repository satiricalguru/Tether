# Phase 2 — Chat

## Goal

A side-panel chat usable every day: streaming markdown with highlighted
code, stop, regenerate, edit-and-resend, branching, per-conversation model
and settings, searchable/pinnable history with export, and a settings page
for generation parameters, system prompt, shortcuts and data management.

## Design

### Conversation tree (Dexie)

Messages form a tree (`parentId`), walked in memory per conversation (IndexedDB can't index the `null` root parent). A conversation stores `activeLeafId`;
the visible thread is the path root → leaf.

- **Regenerate** adds an assistant _sibling_ (same parent).
- **Edit and resend** adds a user sibling, then an assistant child.
- **Sibling navigation** (`‹ 2/3 ›`) selects a sibling and descends to its
  most recently created leaf.
- **Branch** copies the path up to a message into a new conversation.

`MessageRecord` gains `reasoning`, `status` (`streaming | done | stopped |
error`), `error`, `metrics`, `instanceId`, `model`. Reasoning lives in its
own field, so it never ends up in `content` and is never sent back to the
model.

### Request building (`src/chat/request.ts`, pure)

System prompt (conversation override → settings) + the thread's
`user`/`assistant` contents. Errored and empty messages are skipped, and so
is the reasoning field always. The token budget is `numCtx` (or the model's
window) minus `maxTokens` reserve. The oldest turns are dropped first; the
system prompt and the latest user turn are never dropped. Character-based
token estimate (chars / 3.5) until Phase 3 adds a better counter.

### Runner (`useConversationRunner`)

UI-side: creates the assistant record, streams `chat` into it (writes
throttled to about 4/s plus a final write), and records status, metrics and
errors. Closing the panel aborts the port, and the partial reply is saved as
`stopped`.

### Markdown (`src/components/markdown/`)

`marked` lexer → React elements. **No `dangerouslySetInnerHTML` anywhere.**
Raw HTML renders as text. Links are limited to `http(s)`/`mailto`, open in a
new tab with `rel=noopener noreferrer`, and are only followed on click.
**Images are never loaded**: they render as a link chip, because a remote
`<img>` would be network egress and a tracking pixel. Code blocks use shiki
core with the **JavaScript regex engine** (no WASM, so no CSP relaxation),
lazily loaded languages, dual light/dark themes via CSS variables, and a copy
button. Streaming re-lexes the message on each frame; an unterminated fence
renders as code.

### UI

- Side panel views: **chat** and **history** (Zustand for view/draft state;
  `useLiveQuery` for data).
- Chat: message list, collapsible "Thought for N s" reasoning (hidden by
  default), per-message actions (copy, regenerate, edit, branch, sibling
  nav), metrics footer under each finished assistant message, a composer
  with model switcher, send/stop, Esc to stop, and Enter / Shift+Enter.
- History: search across titles and message text, pinned first, rename,
  pin, delete, export Markdown / JSON.
- Settings page: generation defaults (temperature, top_p, max tokens,
  num_ctx, seed), system prompt, reasoning mode (auto/on/off), per-site
  default model rules, keyboard shortcuts (with a link to
  `chrome://extensions/shortcuts`), export all and wipe data.
- Per-conversation settings popover: system prompt, temperature, max tokens.

## Tests

- Unit: tree operations, request building (reasoning never sent, trimming),
  title derivation, export formats, search, site-rule matching, settings
  migration, and the markdown renderer (XSS cases, `javascript:` links,
  images not loaded, unterminated fences, tables, task lists) with shiki
  highlighting.
- E2E (mock): stream markdown and code, stop, regenerate → `2/2`, edit and
  resend, reasoning hidden then shown, and the next request contains no
  reasoning. History persists across reload, search, pin, delete and export
  work, settings change the request body, and Esc stops.
- Real Ollama (opt-in): multi-turn conversation with a thinking model.
