# Phase 6 — Local RAG, inline compose, prompt library

Spec: [docs/spec.md](../spec.md) §7 (copilot features): local RAG, inline
compose, slash commands and the prompt library.

## 1. Local RAG (`src/rag/`)

When page, tab or PDF text doesn't fit its share of the window, Tether
sends the parts most relevant to the question instead of the first N
tokens.

- **Chunking** (`chunk.ts`): about 800 tokens per chunk with 15% overlap
  (120 tokens), heading-aware. A chunk never spans a heading when that can
  be avoided, and each chunk carries its heading path ("Pricing › Plans")
  so it reads on its own. Paragraphs are kept whole where possible, and
  over-long paragraphs are split at sentence boundaries.
- **Vectors** (`vector.ts`): cosine similarity, top-k, then MMR (λ = 0.7)
  to drop near-duplicate chunks. Pure functions, unit-tested.
- **Embeddings:** through the active provider's `embed()`. The model is
  `settings.rag.embeddingModel`; if that's empty, the first installed of
  `nomic-embed-text`, `bge-m3`, `embeddinggemma`, then any model the
  provider marks as an embedding model. Vectors are cached in IndexedDB
  (`embeddings`, keyed by url + content hash + model), so asking again
  about the same page embeds only the question.
- **Fitting:** retrieved chunks fill the attachment's token share and are
  sent in document order, with `[…]` marking gaps and a header naming how
  many chunks of how many were kept. The attachment records
  `retrieval: { model, kept, total }`.
- **Graceful fallback:** no embedding model, embedding failed, or RAG off
  means head truncation as before. The attachment records why, and the
  context bar says so with the fix (`ollama pull nomic-embed-text`).
- **Settings:** Page context → "Find the relevant parts of long pages" (on
  by default) and the embedding model (automatic, or pick one).
- **Background:** `bg:rag:fit` takes the attachments, their shares and the
  question, and returns fitted attachments. It runs in the background so
  the panel never holds vectors.

## 2. Inline compose (`src/content/compose.ts`)

- **Opening it:** Cmd/Ctrl+K while focus is in a text field (`input`
  text-like types, `textarea`, `contenteditable`) opens a small popover
  anchored to the field, in a closed shadow root. It doesn't open in
  password, one-time-code or card fields (same rules as the agent). The
  "Compose with Tether" context menu on editable fields opens it on sites
  where Tether isn't registered (activeTab).
- **Actions:** a free prompt ("write a polite decline"), plus Rewrite,
  Shorten, Fix spelling & grammar and Change tone (formal / friendly /
  concise). It acts on the selection if there is one, otherwise the whole
  field. With an empty field the prompt generates new text.
- **Preview:** the result streams in as a word-level diff against the
  original (insertions and deletions marked, not colour alone). Accept
  replaces the selection or field text through native setters /
  `insertText`, so frameworks see the change and Undo works. Reject or
  Esc closes it with nothing changed. Regenerate tries again.
- **Model:** the panel's selected model (site rules apply), streamed over
  a new `compose` port stream. The field's text is fenced as content to
  edit, never as instructions.
- **Registration:** the bridge is registered when the bubble or compose is
  enabled (`page.compose`, on by default), on the origins Tether has
  access to.

## 3. Prompt library and slash commands (`src/prompts/`)

- **Templates:** `{ id, command, name, template, description? }`. The
  variables are `{{selection}}`, `{{page}}`, `{{url}}`, `{{title}}` and
  `{{input}}` (text typed after the command). Stored in
  `chrome.storage.local` under `tether:prompts`. There are built-in
  defaults (summarize, explain, tldr, bullets, translate, reply, eli5),
  and you can edit or reset them.
- **Expansion:** `{{page}}` / `{{selection}}` attach the page / selection
  chip, so the content stays fenced, budgeted and visible as a chip. The
  placeholder becomes a reference ("the page above"). `{{url}}`,
  `{{title}}` and `{{input}}` are substituted inline.
- **Composer:** `/` at the start opens a filtered menu (arrows, Enter or
  Tab to pick, Esc to close). Sending `/summarize focus on pricing`
  expands the template.
- **Settings → Prompt library:** list, add, edit, delete, reset to
  defaults, and import/export JSON. Imports are validated, and an invalid
  file says what's wrong and changes nothing.

## Ownership (parallel work)

| Area    | Owner  | Shared files touched (small additive edits only)                                                                                                                                                                                                  |
| ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RAG     | fork R | `src/lib/protocol.ts` (`bg:rag:fit`), `src/lib/settings.ts` (`rag`), `src/entrypoints/background.ts`, `src/components/chat/chat-view.tsx` (one call in `send`), `src/components/chat/context-bar.tsx`, `src/components/settings/page-section.tsx` |
| Compose | fork C | `protocol.ts` (`compose` stream, `content:compose-open`), `settings.ts` (`page.compose`), `background.ts`, `src/entrypoints/content.ts`, `src/background/context.ts` (registration), `page-section.tsx`                                           |
| Prompts | main   | `composer.tsx`, `chat-view.tsx` (slash expansion in `send`), `options/App.tsx` (new section)                                                                                                                                                      |

Builds and E2E share `.output`, so they're serialised with a lock
directory.

## Tests

- **Unit:** chunker (sizes, overlap, headings, long paragraphs), cosine /
  MMR, fitting with and without embeddings, the cache hit, template
  expansion, import validation, word diff, compose prompt building.
- **E2E (mock server):** a long page asked a question about its end (the
  answer only fits through retrieval), the fallback note with no embedding
  model, Cmd+K rewrite with accept and with reject in a textarea and a
  contenteditable, the password field refusal, a slash command with
  `{{page}}`, and prompt-library import/export.
- The bundle egress scan stays green.
