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
