# Analysed Like Chess Studio

Single-user local web app: upload a movie scene clip, draft chess-style move annotations with cloud AI, edit them over live playback, render an MP4 with freeze-frames burned in. `PLAN.md` is the full build plan; read the section for the current phase before starting work.

## Commands

- `pnpm dev`: web (Vite, http://localhost:5173) and server (Hono, http://127.0.0.1:8787) together. Vite proxies `/api` to the server.
- `pnpm check`: lint, typecheck and tests. Run before every commit.
- `pnpm test` / `pnpm lint` / `pnpm typecheck`: individually.
- `scripts/make-sample-clip.sh`: regenerates `fixtures/sample/source.mp4` (needs system ffmpeg).
- `pnpm seed:sample`: creates a project from the fixture (3 moments). `pnpm seed:moments <projectId> <file>` replaces a project's moments, e.g. `fixtures/demo/doakes-moments.json` for the Dexter demo clip.
- `scripts/browser/`: headless-Chrome checks (`phase2-checks.mjs`, `phase3-checks.mjs`) over the DevTools protocol (no dependencies) against a running `pnpm dev`. The dev build exposes the Player as `window.__alsPlayer`.

## Layout

- `apps/web`: editor UI (Vite, React, Tailwind).
- `apps/server`: Hono API, jobs, ffmpeg, AI adapters, render. Runs TypeScript directly on Node (type stripping), so use only erasable syntax and `.ts` import extensions.
- `packages/schema`: Zod schemas and the types derived from them; the only source of types.
- `packages/composition`: Remotion `<Episode>`, `<MoveCard>`, `timeMap()`. Lint enforces purity.
- `packages/theme`: classification tokens, badges, theme presets.
- `fixtures/`: test data, including the sample project and recorded provider responses.
- `projects/`: runtime project folders, gitignored. `PROJECTS_DIR` overrides the location.
- `media/`: local demo footage (copyrighted), gitignored. Never commit clips.

## Conventions

- All times are source-clip seconds; frames are derived, never stored.
- Holds follow the card text (`autoHoldSec`) unless `holdLocked`. Spoken moves freeze just after the last word, in that word's shot (`freezeAfterSpeech`); the editor's snapping uses the same helpers.
- Editor state is a Zustand store (`apps/web/src/editor/store.ts`) with undo, coalesced typing, gestures for drags, and versioned autosave (409 means reload, never overwrite). Pure edit operations live in `editor/doc.ts`.
- The edit layer draws the same `<MoveCard>` over the Player through its `editing` slots; the render path never passes them.
- Hard invariants (moment spacing, ordering, references) live in `ProjectSchema`. Soft rules (text caps, `bestMove` on best/brilliant) are `momentWarnings()`, so the editor warns without blocking saves.
- The output is the source with a hold at each moment. `buildTimeline()` in `packages/composition` is the only mapping between source and output frames; the Player, timeline UI and renderer all use it.
- `<Episode>` renders one `<Sequence>` per play-then-hold segment so the same `@remotion/media` `<Video>` plays into its `<Freeze>`; premounting loads the next segment. Verified frame-exact in the Player (Phase 2 spike), so the extracted-still fallback is not needed.
- Ingest stages are cached by content hash in each project's `ingest.json`. Bump a step's `STEP_VERSION` in `apps/server/src/ingest/ingest.ts` when its command changes.
- Cut detection uses ffmpeg `scdet` plus peak picking (`apps/server/src/media/cuts.ts`), tuned on dark film footage where real cuts score only 5-10. Check changes against a contact sheet of real footage, not just the synthetic fixture.
- Dependencies are pinned to exact versions (`save-exact` in `.npmrc`). TypeScript stays below 6.1 until typescript-eslint supports newer versions.

## Working rules

1. Build one phase at a time. Do not start a phase until the previous phase's checks pass, and stop to report at the end of each phase.
2. Before writing any call to Remotion, the Claude API, Gemini or the speech-to-text vendor, read that SDK's current docs. Never write API calls from memory. Pin exact dependency versions.
3. `packages/schema` is the only source of types. Never hand-write a type that duplicates a Zod schema.
4. `packages/composition` stays pure: no imports from `apps/`, no network, no clocks, no editor state.
5. Tests never call cloud APIs. Record one real response per provider into `fixtures/` and replay it.
6. API keys live only in the server's `.env`, which is gitignored. Nothing secret reaches the browser.
7. Ask before adding a dependency that is not in the Stack table.
8. Where the creator's format is unknown (exact card look, text length, hold timing), leave a `TODO(open-decision)` comment rather than guessing.
9. Commit after each working step with a message that says what now works.

## Status and handoff (updated Oct 10, 2026)

Read this first in a new session, then the PLAN.md section for the next phase.

- **Done:** Phases 0-3 (scaffold, ingest, player/overlay/timeline, editor), each with its checks passing, plus the creator's review iterations after Phase 3. Branches are stacked and **not merged into `main`**: `phase-0-scaffold` → `phase-1-ingest` → `phase-2-player` → `phase-3-editor` (current tip). Ask before merging.
- **Next: Phase 4 (analysis).** Start with the plan's open decision: recommend a speech-to-text vendor after verifying word timestamps and diarization in its current docs, and ask the user before choosing. Then read the current Claude structured-outputs and Gemini video docs (rule 2), verify model IDs, and build Stages 1-4 with caching, SSE progress, the speaker naming screen, Pass A/B, snapping (use `freezeAfterSpeech`) and Regenerate. Hooks waiting for it: `TODO(phase-4)` in `TranscriptDrawer.tsx` ("Make this a move" should run Pass B); `analysis` in the project schema.
- **Decisions from the creator's reviews** (also in PLAN.md):
  - Holds follow the card text at 34 characters a second (half the time per character of the 17 cps subtitle norm) plus 1 s reread padding plus card in/out.
  - Spoken moves freeze 0.15 s after the last word, in that word's shot, clear of cuts.
  - No dim during holds in the default theme.
  - Brilliant, Great, Best and Book moves never carry a best move (the editor clears it, cards never show it, the Analyst must not write one).
  - The video is 80% of the centre column and capped to the viewport height so the frame and its card are always visible; nothing auto-scrolls the page.
  - The creator liked the peripheral editor features (cast, evidence, live feedback); keep that level of polish.
- **Demo data:** the creator's Dexter clip is local in `media/` (never commit it). Their project is `doakes-catching-dexter-b8f1` in `projects/`; seed demo moves with `pnpm seed:moments doakes-catching-dexter-b8f1 fixtures/demo/doakes-moments.json`. Those moves were hand-written by Claude from frames, not transcribed.
- **How each phase has ended:** run `pnpm check`, run the phase's checks in headless Chrome (`scripts/browser/`, against `pnpm dev` with `PROJECTS_DIR` pointed at a scratch folder so the user's projects stay clean), look at screenshots, commit, then give the user a short numbered test walkthrough and stop.
