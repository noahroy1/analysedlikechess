# Analysed Like Chess Studio

Single-user local web app: upload a movie scene clip, draft chess-style move annotations with cloud AI, edit them over live playback, render an MP4 with freeze-frames burned in. `PLAN.md` is the full build plan; read the section for the current phase before starting work.

## Commands

- `pnpm dev`: web (Vite, http://localhost:5173) and server (Hono, http://127.0.0.1:8787) together. Vite proxies `/api` to the server.
- `pnpm check`: lint, typecheck and tests. Run before every commit.
- `pnpm test` / `pnpm lint` / `pnpm typecheck`: individually.
- `scripts/make-sample-clip.sh`: regenerates `fixtures/sample/source.mp4` (needs system ffmpeg).
- `scripts/make-dialogue-clip.sh`: regenerates `fixtures/dialogue/source.mp4`, a rights-free two-voice scene (macOS `say`) for analysis tests.
- `ANALYSIS_REPLAY_DIR=$PWD/fixtures/dialogue/recorded pnpm dev`: runs analysis on recorded responses, no keys or API calls. `ANALYSIS_RECORD_DIR` records real ones.
- `ANALYST_HANDOFF_DIR=<dir> pnpm dev`: dev only, replaces the Claude calls with request/answer files a Claude Code session writes by hand (see Status).
- `pnpm seed:sample`: creates a project from the fixture (3 moments). `pnpm seed:moments <projectId> <file>` replaces a project's moments, e.g. `fixtures/demo/doakes-moments.json` for the Dexter demo clip.
- `scripts/browser/`: headless-Chrome checks (`phase2-checks.mjs`, `phase3-checks.mjs`, `typeout-checks.mjs`, `format-checks.mjs`) over the DevTools protocol (no dependencies) against a running `pnpm dev`. The dev build exposes the Player as `window.__alsPlayer`.

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
- Analysis (`apps/server/src/analysis/`): providers sit behind `Transcriber` / `SceneDescriber` / `Analyst` (ElevenLabs Scribe v2, Gemini, Claude). Stages cache by input hash in `<project>/analysis/manifest.json`; `rerun: 'analyst'` redoes only Pass A/B. Analyst schemas are built per clip with enums for cast, candidate and utterance ids. Prices for cost logging are in `analysis/prices.ts`. Regenerate never writes `project.json` (so an open editor is not forced to reload); its spend goes to `analysis/regenerate-usage.json`.
- The server imports `@als/theme/themes` (no JSX); the web app imports `@als/theme`. Themes: `default` (the app's own `stacked` card) and `creator` (the creator's `headline` card); a project's `themeId` is part of the editor document, so switching is saved and undoable and unlocked holds follow the new timing.
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

## Status and handoff (updated Oct 12, 2026)

Read this first in a new session, then the PLAN.md section for the next phase.

- **Done:** Phases 0-3, the creator's review iterations, and Phase 4 code (analysis pipeline, providers, Regenerate, Make this a move, Analysis tab). Branches are stacked and **not merged into `main`**: `phase-0-scaffold` → `phase-1-ingest` → `phase-2-player` → `phase-3-editor` → `phase-4-analysis` (current tip). Ask before merging.
- **Phase 4 live run, Oct 11, 2026:** ElevenLabs and Gemini work live with the keys in `apps/server/.env` (the `keyterms` field is accepted as repeated multipart fields; whether it changes spelling is unverified). The Anthropic API balance is empty, so with the user's agreement **Claude Code stood in for Claude by hand** through `ANALYST_HANDOFF_DIR` (`handoffAnalyst` in `providers/replay.ts`): the pipeline writes `request-<call>.json`, a session writes `claude-<call>.json` (`{"output": …}`), and the next run validates it like a live answer, labelled `hand-written/claude-code-session` at $0. Delete a `claude-*.json` to redo that call. Run the server from `apps/server` (or with `--env-file`) or it sees no keys. A failing vendor no longer discards the other's paid result.
- **Real clip done:** `projects/bb1-ea55` is `media/BB1.mov` (Breaking Bad, Hank and Walt in the garage, 2:28) with real transcript and scene notes and 7 hand-written draft moves, all Phase 4 checks passing; its raw responses and requests are in `analysis/recorded/`. `media/BB2.mov` is a duplicate of BB1 (identical frames), not a 3-minute cut. Diarization labelled two Hank lines (u7 "And for what?", u22 "What's the point?") as Walt.
- **Still owed (needs an Anthropic balance):** (1) run the dialogue clip once with `ANALYSIS_RECORD_DIR` and commit all six real responses together, replacing the synthetic ones in `fixtures/dialogue/recorded/`; (2) one live Opus run to compare with the hand-written moves and report real Claude cost per clip (estimate $0.25-0.40; real Scribe $0.011 and Gemini $0.008 for the 2:28 clip). Then stop for the user's review before Phase 5.
- **Vendor choices (user delegated, price-optimised):** ElevenLabs Scribe v2 ($0.22/h; best independent WER among candidates; sound tags), Gemini 3.5 Flash-Lite for scene notes, Claude Haiku 5.5 for speaker naming, Opus 5.5 Analyst and Sonnet 5.5 Regenerate per the plan. Expected per 3-min clip: about $0.01 transcription, $0.02 scene notes, the rest Claude (Pass A + B).
- **Decisions from the creator's reviews** (also in PLAN.md):
  - Holds follow the explanation's type-out (Oct 12, measured on the creator's clips, replacing the Oct 10 34 characters a second plus 1 s): card in, a word every 0.18 s (5.5 words a second) each fading in over 0.12 s, then 4 s with the finished card, then card out. Only the explanation types; the best move fades in after the last word. Review still stops once the card is in, so resuming plays the type-out; the paused edit layer always shows the full text.
  - Spoken moves freeze 0.15 s after the last word, in that word's shot, clear of cuts.
  - Holds dim the frozen frame by 10% (Oct 12; replaces the Oct 10 "no dim").
  - No Book moves after the first 30 s (`BOOK_WINDOW_SEC`): the Analyst is told, and later ones are relabelled Good in `snapMoves` and Regenerate. No editor warning, by the creator's choice.
  - Brilliant, Great, Best and Book moves never carry a best move (the editor clears it, cards never show it, the Analyst is told not to write one).
  - The video is 80% of the centre column and capped to the viewport height so the frame and its card are always visible; nothing auto-scrolls the page.
  - The creator liked the peripheral editor features (cast, evidence, live feedback); keep that level of polish.
- **Format iterations (from Oct 12, branch `format-iterations` on `phase-4-analysis`):** the creator's list, in this order, one commit and walkthrough each: (1) 10% dim and the Book rule, done; (2) shorter, denser text, done: caps 24/170/32 from the creator's cards, two-sentence breakdowns, writing rules in `prompts.ts`, BB1 re-drafted through the hand-off (old answer kept as `claude-annotate.v1-long-text.json`); (3) type-out of the explanation, done: the creator's 5.5 words a second (the user chose the clips over their first estimate of 2), `revealAt()` in `packages/composition/src/card.ts`, checked by `scripts/browser/typeout-checks.mjs`; (4) the `creator` theme, done: `packages/theme/src/creator-theme.ts` (`headline` card layout, badge beside the card popping in first, measured sizes, colours and timing), motif chips written by the Analyst, White/Black sides (the Analyst names the protagonist for White, else a coin flip; set by hand in the Cast tab) driving chess move numbers (`moveNumbers()`), and a Look picker in the editor header saved as `themeId` (undoable). BB1 uses it; its Pass B answers are kept as `claude-annotate.v1-long-text.json`, `.v2-no-motif.json` and the current one; (5) sounds per move type plus a typing loop, shared by every theme (chess sounds, not creator sounds), and droppable if they block progress; (6) evaluation bar (`media/creator-ref/style-ref-evaluation-bar.png`); (7) burned-in subtitles of the dialogue, after the features that set the format apart. BB1 stays the reference clip until the format works, then BB2. `media/BB2.mov` is still the duplicate of BB1, so the real cut is needed then.
- **Creator reference (`media/creator-ref/`, Catch Me If You Can):** cards read "<Name> is a/an <rating>" in the rating colour, then a grey line "<move no.>[...] <actor> · <Name><glyph>", a coloured left border, the explanation (streams in word by word, each new word fading in), then "Better was: <move>" in green and a grey motif chip (Quiet Move, Zwischenzug, Sacrifice, Check). The round badge sits apart from the card, beside the character; the badge appears first, then the card. Timing in both reference clips: freeze and dim, badge pops in 0.25 s later, card slides in over 0.25 s, 27 words type in about 5 s, the finished card stays about 4 s, then the card cuts away instantly as playback resumes. The eval bar sits on the left edge between the two characters' portraits, labelled Black and White, with a number or "M6". The clips also have burned-in subtitles.
- **Style corpus:** `style/corpus.json` holds the creator's five cards (`source: creator`) plus Claude-written placeholders in the same format for the other ratings; Phase 6 replaces the placeholders.
- **Demo data:** the creator's Dexter clip is local in `media/` (never commit it). Their project is `doakes-catching-dexter-b8f1` in `projects/`; seed demo moves with `pnpm seed:moments doakes-catching-dexter-b8f1 fixtures/demo/doakes-moments.json`. Those moves were hand-written by Claude from frames, not transcribed.
- **How each phase has ended:** run `pnpm check`, run the phase's checks in headless Chrome (`scripts/browser/`, against `pnpm dev` with `PROJECTS_DIR` pointed at a scratch folder so the user's projects stay clean), look at screenshots, commit, then give the user a short numbered test walkthrough and stop.
