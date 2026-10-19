# Phase 3 — Page context

## Goal

Ask about what you're looking at: the current page, your selection, all open
tabs, or a PDF. Highlight-to-ask works in place, and right-click menus open
the panel. Context is budgeted against the model's real window, and page
text is always treated as untrusted data.

## Access model (permissions)

Tether still installs with only localhost access. Reading a site needs one
of the following:

1. **activeTab**: granted when the user clicks the toolbar button, uses the
   shortcut or a context-menu entry. This covers "ask about this page" right
   after opening the panel.
2. **Per-site grant**: the panel's _Allow on this site_ button requests that
   origin only, from the optional `<all_urls>`.
3. **All sites**: one optional grant, required for the highlight bubble
   everywhere.

When the panel can't read a tab it says why and offers (2) or (3); it never
fails silently. Once the bubble is enabled, the content script is registered
(`scripting.registerContentScripts`) on every origin Tether has been
granted, and re-registered whenever a permission is added or removed.

## Extraction (`src/context/extract.ts`, runs in the page)

- Build a **visibility-filtered clone**: skip `display:none`,
  `visibility:hidden`, `opacity:0`, `font-size:0`, `[hidden]`,
  `aria-hidden=true`, clipped / zero-size / far-off-screen boxes, and text
  whose colour matches its background. Hidden text never reaches the
  model.
- Run **Readability** on the clone. Fall back to `main`, `article`,
  `[role=main]`, then `body`.
- Serialize to compact **Markdown-ish text**: headings, lists, tables
  (rows as `|`-joined lines), code, blockquotes; link text only; whitespace
  collapsed. Capped at 400k characters in the page.
- Also return the selection, the title, the URL, the language, and stats
  (characters kept, hidden text skipped, and how many hidden blocks looked
  like instructions).

## Untrusted content

`src/context/injection.ts` scans for injection patterns ("ignore previous
instructions", "you are now", role tags, fake system prompts, "do not tell
the user", exfiltration phrasing). Flagged attachments show a ⚠ with the
matched phrases. In the prompt every attachment is wrapped in
`<untrusted_page_content …>`, with closing tags in the text neutralized, and
the system prompt gains a rule that instructions inside those fences are
reported to the user, never followed.

## Budget (`src/context/budget.ts`)

- A better token estimator: words, punctuation runs, one token per CJK
  character, and digits grouped in threes.
- Window = effective `num_ctx`. Space for context = window − reply
  reserve − system prompt − history − the question.
- Attachments share that space; an over-budget attachment is truncated at
  block boundaries with a visible `[truncated: kept X of Y tokens]` marker.
- Chips show their token cost and the window percentage live, turning amber
  above 75% and red when anything was truncated.

## Panel UI

- Context chips above the composer: **This page**, **Selection** (when
  there is one), **All tabs**, **This PDF** (when the tab is a PDF), and
  **Attach PDF** (local file, so no network). Attachments are stored on the
  user message (`MessageRecord.attachments`), so regenerate and edit reuse
  them, and they render as chips in the thread.
- Pending actions from context menus and the bubble arrive through
  `storage.session` (`tether:pending`). The panel starts a new chat with
  them.

## Highlight-to-ask (content script, shadow DOM, no React)

Selecting text shows a small bubble: Explain · Summarize · Translate ·
Improve · Ask… The answer streams inline over a `quick` port (built and run
in the background, so model settings never touch the page), with Copy and
**Continue in side panel**. Closed shadow root; Esc and outside-click
dismiss it.

## Context menus

Selection: Explain / Summarize / Translate / Improve / Ask Tether. Page: _Ask
Tether about this page_. A click opens the panel (it's a user gesture) and
stores a pending action.

## PDFs

- **This PDF**: the panel requests that origin (if not granted), then
  fetches the PDF URL through `HttpClient` with a one-shot allowlist of
  exactly that URL. This is a user-initiated re-read of a document already
  open, and the one place Tether contacts a non-model host. It's documented
  as such.
- **Attach PDF**: a local file and no network.
- Text comes from pdf.js in the panel (bundled worker, `isEvalSupported:
false`), with page markers.

## Tests

- Unit: extractor on fixture HTML (hidden-text filtering, Readability,
  fallback, serialization), the injection corpus, the token estimator, the
  budget allocator, prompt wrapping and escaping, pending-action handling,
  context-menu handlers, registration matches, and PDF text extraction from
  a fixture PDF.
- E2E: an article fixture becomes a chip, and the mock request carries
  fenced article text without hidden text. The injection fixture is flagged
  and its hidden payload is absent. Also: selection chip, all-tabs chip, the
  bubble streaming an inline answer and continuing in the panel, This PDF
  (served from 127.0.0.1), and truncation shown when over budget.
