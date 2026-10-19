# Phase 0 — Scaffold

## Goal

A loadable MV3 extension skeleton where every later phase has a place to land:
side panel opens, options page renders, background ↔ panel messaging works
(request/response **and** long-lived port streaming), persistence layers exist,
and the quality gate (`lint`, `typecheck`, `test`, `build`, `e2e`) runs locally
and in CI.

## Deliverables

1. **Tooling**
   - `package.json` (pnpm), WXT 0.21 + `@wxt-dev/module-react`, Vite 7.
   - TypeScript 5.9 `strict`, `noUncheckedIndexedAccess`, path alias `@/` → `src/`.
   - ESLint flat config (typescript-eslint strict-type-checked + react-hooks),
     Prettier, `--max-warnings 0`.
   - Tailwind v4 via `@tailwindcss/vite`, design tokens as CSS variables
     (light/dark) in `src/styles/globals.css`.
2. **Manifest** (`wxt.config.ts`) — full permission set from spec §8:
   required, optional, host permissions, `commands` (`Ctrl/Cmd+Shift+L` → open
   panel), strict CSP (`script-src 'self'; object-src 'self'`).
3. **Entrypoints**
   - `background.ts` — message router, port handler, side panel behaviour,
     command handler, alarm-based keepalive scaffolding.
   - `sidepanel/` — React app shell: header, connection status (live ping to
     background), placeholder composer wired to an echo stream over a port to
     prove the streaming path end-to-end.
   - `options/` — React settings shell rendering persisted settings (theme)
     read/written through the settings module.
   - `content.ts` — minimal DOM bridge answering `content:ping` with page
     title/URL (proves background → content round-trip).
   - `offscreen/` — offscreen document entry (registered, unlisted page) with
     a ping handler; creation helper in `src/platform/offscreen.ts`.
4. **`src/lib/`**
   - `messaging.ts` — typed request/response protocol (discriminated union map
     of `type → {req, res}`), `sendMessage<T>()`, `onMessage()` router with
     error envelopes (`{ok:false,error}`) so exceptions never cross as `undefined`.
   - `ports.ts` — typed port streaming: `openStream(name, payload)` returns an
     `AsyncIterable` + `abort()`; background `registerStreamHandler(name, fn)`
     with `AbortSignal` wired to port disconnect.
   - `logger.ts` — leveled logger with redaction of API-key-like strings.
   - `settings.ts` — typed settings with defaults + deep-merge migration over
     `chrome.storage.local`, change subscription.
   - `db.ts` — Dexie schema v1: `conversations`, `messages`, `traces`,
     `embeddings` (tables created now so later phases only add indices).
5. **`src/platform/`** — `sidePanel.ts` (Chromium `sidePanel` vs Firefox
   `sidebarAction` vs tab fallback), `capabilities.ts` (feature detection).
6. **Tests**
   - Vitest (jsdom + `fake-indexeddb` + WXT's `fakeBrowser`): messaging router,
     port streaming (abort + error), settings merge/migration, logger redaction,
     db schema open.
   - Playwright: persistent Chromium context with the unpacked build loaded;
     specs: service worker registers, side panel page renders + ping shows
     "connected", echo stream renders streamed tokens, options page renders and
     persists theme across reload.
7. **CI** — `.github/workflows/ci.yml`: install → lint → typecheck → test →
   build → e2e (xvfb).
8. **Docs** — `README.md` (dev setup, scripts, permission rationale),
   `DECISIONS.md` (assumptions + ADRs), `docs/providers.md` / `docs/safety.md`
   stubs are **not** created yet (they ship with real content in phases 1/5).

## Non-goals for Phase 0

No provider calls, no real chat, no agent. The echo stream is a test fixture
for the port transport and is labelled as such in the UI ("transport check").

## Commit plan

1. `chore: scaffold wxt + react + typescript toolchain`
2. `chore: add eslint, prettier, tailwind`
3. `feat(lib): typed messaging, port streaming, settings, logger, db`
4. `feat(platform): side panel + offscreen shims`
5. `feat(ui): side panel and options shells`
6. `test: vitest suite for lib`
7. `test(e2e): playwright harness with unpacked extension`
8. `ci: github actions workflow`
9. `docs: readme + decisions`

## Gate

`pnpm build && pnpm typecheck && pnpm test` green, plus `pnpm lint` and
`pnpm e2e` green locally.
