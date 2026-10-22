# Phase 5 — Computer use

## Goal

The agent operates pages, not just reads them: click, type, select, check,
scroll, press keys, fill forms across pages and frames. Anything
irreversible waits for the user's explicit confirmation, every step is
traced and viewable, and the user can stop a run from the panel, the page
or the keyboard.

## Page engine (content script, `src/agent/page/`)

- **Snapshot** (spec §6.1): interactive elements (`a[href]`, `button`,
  inputs, `select`, `textarea`, ARIA widget roles, `[onclick]`,
  `[contenteditable]`, `summary`, pointer-cursor elements). Filtered to
  visible, not `aria-hidden`, not disabled, and within 1.5 viewports. Each
  gets a per-snapshot id (`12`, or `3.12` inside same-origin frame 3) held
  in a `Map` in the content script, so actions never use brittle
  selectors. Per element: role, accessible name (label → aria-label →
  aria-labelledby → placeholder → text → title → nearest heading), value
  and state, and a hierarchy hint (form, dialog, nav, frame). Open shadow
  roots are pierced; cross-origin frames are listed as opaque. Includes the
  readable text digest and links, a DOM hash for no-op detection, and
  CAPTCHA detection. A token cap (default 4000) prioritizes by proximity to
  the last action, viewport centrality and words shared with the task, and
  reports what was dropped.
- **Actions**: realistic event sequences (`pointerdown → mousedown → focus
  → pointerup → mouseup → click`; per-character `beforeinput`/`input`
  using the native value setter, so React and Vue controlled inputs
  update). Elements are scrolled into view and briefly outlined.
- **Stability**: after an action, wait until the DOM has been quiet for
  350 ms, or `readyState` is complete, capped at 8 s.

## Background (`src/agent/`)

- **Tools**: the full §6.2 set except `screenshot`, which is Phase 7's
  vision tier.
- **Two input backends**: *scripting* (default, through the page engine)
  and *debugger* (optional `debugger` permission; CDP
  `Input.dispatchMouseEvent` / `insertText` at the element's coordinates,
  for sites that check `isTrusted`). The UI explains the "being debugged"
  bar before enabling it.
- **Guard tiers** (spec §6.6):
  - *read* (snapshot, scroll, extract, waitFor) and *navigate* (links,
    tabs, ordinary buttons) run automatically within the domain policy.
  - *write* (type, select, check) runs automatically, but never into
    password, one-time-code or card fields; card, SSN and token patterns are
    redacted from traces.
  - *irreversible* (form submits, submit-on-type, Enter in a form, buttons
    matching buy/purchase/pay/delete/remove/send/confirm/transfer/
    unsubscribe/post/publish, downloads) **always waits for the user's
    confirmation**, which shows the exact element and page.
- **Navigation exfiltration**: a URL the agent wants to open is checked
  against page-derived data patterns. Query strings that carry text from
  the user's pages or conversation to a new host are refused (ADR-037).
- **Loop**: validate that ids exist in the current snapshot. Detect no-ops
  (same DOM hash and URL: "That click produced no change. Try a different
  element."). Loop detection hashes `(url, action, target name)`: a warning
  at 3 repeats, abort at 5. An optional critique pass before `done`
  (default on). CAPTCHA → hand back to the user.
- **Confirmations** travel over the agent port: ports gain client → server
  messages.
- **Kill switch**: a banner on the controlled tab ("Tether is controlling
  this tab · Stop") with Esc, the panel's Stop and Esc, all aborting the
  run.
- **Trace viewer**: a panel view of runs and steps (action, element, URL,
  outcome, before/after hash), exportable as JSON.
- `docs/safety.md`: the permission model.

## Eval (spec §10)

12+ fixture sites: search form, multi-step checkout stub, login form,
infinite scroll, modal plus shadow DOM, iframe form, table to extract,
CAPTCHA wall, a page whose visible text tells the agent to do something
destructive, cookie banner, plus Phase 4's shop, trails and injection pages.
Each task has a programmatic check on the final page state and the run
record (answered, asked the user, requested confirmation, refused). The
injection task must assert the agent reported the injection and did not
follow it.

## Tests

Unit tests for the engine (jsdom: roles, names, visibility, ids, frames and
shadow DOM, actions and events, React-style controlled inputs, stability),
guard classification, the exfiltration check, loop and no-op detection, and
critique. E2E with scripted mock runs on the fixture apps: form fill,
confirmation approve and deny, password refusal, kill switch from the
banner, trace view. Eval with the real model.
