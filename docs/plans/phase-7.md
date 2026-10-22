# Phase 7 — Vision tier, Firefox, polish, packaging

Spec: [docs/spec.md](../spec.md) §6.5 (vision tier), §2 (targets), §9
(Phase 7), §10 (evals on two models).

## 1. Vision tier (opt-in)

- **When it's used:** the agent's model reports `vision: true` _and_
  _Settings → Agent → "Show the model screenshots"_ is on (off by default:
  images cost prompt time on small machines).
- **Capture:** `tabs.captureVisibleTab` (JPEG) in the background, after the
  DOM snapshot of the same step.
- **Set-of-marks:** numbered boxes drawn on the snapshot's in-viewport
  elements, using the same ids as the text list, labelled `[12]`. The
  compositing happens in the offscreen document (Chromium) or the
  background page (Firefox has a DOM there). Rects are scaled by
  `devicePixelRatio`.
- **Downscale:** the long side to 1024 px (`agent.visionMaxSide`), JPEG
  quality 0.7, sent as a base64 image part with the text observation. Only
  the current step's image is sent; earlier steps never carry images.
- **DOM ids stay authoritative.** The model answers with an element id, as
  on the text tiers. Coordinates in a reply are ignored, never clicked.
- **`screenshot()` tool:** listed only when vision is active. It refreshes
  the image without acting.
- **Trace:** a small thumbnail (max 320 px) is stored with the step, and the
  trace viewer shows it.
- **Fallback:** a page that can't be captured (chrome://, PDF viewer,
  minimised window), or a model that rejects images, continues text-only
  with a warning in the run.

## 2. Firefox (secondary target)

- **Builds:** `pnpm build:firefox` and `pnpm zip:firefox` produce a valid
  MV3 add-on (gecko id, `strict_min_version`). The manifest is checked by a
  unit test of the generated output.
- **Platform shims** (`src/platform/*`), so Firefox degrades and never
  crashes:
  - **side panel:** `sidebar_action` (the panel page becomes the sidebar),
    opened from the toolbar and the shortcut;
  - **offscreen:** not available, so canvas work runs in the background
    page;
  - **debugger:** absent, so the trusted-input option is hidden, with an
    explanation;
  - **storage.session, scripting, contextMenus:** checked;
  - **optional host permissions:** requested the same way.
- **Docs:** the Firefox install and its limits go in the README.

## 3. Polish, packaging, docs

- `pnpm zip` (Chrome) and `pnpm zip:firefox` produce release zips, plus
  the unpacked `.output/chrome-mv3`. A `pnpm release` script builds both,
  runs the egress scan on both, and writes checksums.
- **README:** install from zip or unpacked (Chrome, Edge, Brave, Arc,
  Firefox), a "first two minutes" walkthrough (the spec's definition of
  done), screenshots, and the demo GIF.
- **Screenshots:** taken by a Playwright script against the mock server
  (deterministic): chat with page context, highlight bubble, inline
  compose diff, an agent run awaiting confirmation, the trace viewer, and
  Setup Doctor. Saved to `docs/images/`.
- **Demo GIF:** a Playwright-recorded agent run on the fixture shop (search
  → results → confirmation), converted with ffmpeg (a dev-only tool, not a
  dependency) and kept under about 3 MB.
- **Polish:** an accessibility pass on the new UI (labels, focus, contrast),
  error copy, and empty states.

## 4. Evals on two small models

`pnpm eval` (both suites, all three tiers) on `ornith-1.5:9b` and
`llama3.2:3b`, with both tables in the README. `pnpm eval` builds into
`.output-eval`, so it runs alongside other work. RAG is checked once
against the real `nomic-embed-text`.

## Ownership

| Area                                       | Owner  |
| ------------------------------------------ | ------ |
| Vision tier                                | fork V |
| Firefox                                    | fork F |
| Packaging, screenshots, GIF, README, evals | main   |

Shared files (`protocol.ts`, `settings.ts`, `background.ts`,
`agent-section.tsx`) get small re-read-then-edit changes. Builds and E2E
on `.output` are serialised with `/tmp/tether-output.lock`.
