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
- `scripts/ref/hold-phases.mjs <clip> <crop>`: times a reference clip's hold phases (freeze, badge, card, type-out, exit) from frame changes.

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

Read this first in a new session. It says where the work stands, what to do next, what is waiting on the user, and what was learned the hard way.

### Where things stand

- **Branch:** `format-iterations` (current tip), stacked on `phase-4-analysis` → `phase-3-editor` → `phase-2-player` → `phase-1-ingest` → `phase-0-scaffold`. **Nothing is merged into `main`**; ask before merging. `apps/server/.env.example` shows as deleted in the working tree from before Oct 12; it is not ours, so leave it out of commits (`git add -A -- . ':!apps/server/.env.example'`).
- **Done:** Phases 0-4 (Phase 4 has two owed items, below), the creator's review iterations, and format iterations 1-4 of 7 (log below).
- **Not started:** Phase 5 (export/render) and Phase 6 (pitch build). The format iterations were inserted before Phase 5 at the user's request; the user has not said whether Phase 5 waits for all seven.
- **Checks at the tip:** `pnpm check` passes (182 tests). The browser checks pass: `phase2-checks`, `phase3-checks`, `typeout-checks` and `format-checks`.

### Next action: finish format iteration 6 (evaluation bar)

The user started iteration 6 before answering the sounds question (iteration 5 stays blocked, below). Plan agreed Oct 12; steps 1-2 are done, see item 6 of the log. Remaining:
- **Step 3, editor:** an eval lane under the timeline (a step plot, solid dots for cards and hollow ones for beats), a beat inspector (time, value, reason, delete), "add beat at playhead", an Eval field in the moment inspector (`parseEval`), the start value, `evalWarnings` shown like `momentWarnings`, and a **Re-evaluate** button. Re-evaluate is a Pass C endpoint that, like Regenerate, never writes `project.json`: it returns the evals, the editor applies them as one undoable edit, and its spend is logged beside the project.
- **Step 4, portraits:** the user chose to crop them from the video. In the Cast tab, pause on a frame and drag a square over a face; the server crops a still into the project folder (`SERVABLE_FILE` must allow it). Feed the URLs into `EpisodeProps.portraits`. Initials stay as the fallback.
- Then an `evalbar-checks.mjs` browser check, a walkthrough, and stop.

### Iteration 5 (sounds): blocked

Blocked on one user decision, asked at the end of iteration 4 and not yet answered: **where the sounds come from.** PLAN.md forbids copying Chess.com's sound effects, which the creator's clips (`media/creator-ref/style-sound-demo-*.mov`, which have audio) may use. Options offered:
1. **Recommended:** Claude listens to the demo clips' audio to match its character, then synthesises *original* sounds: a move sound per type or group (brighter for Brilliant/Great, duller for mistakes), plus a light key-tick loop under the type-out. No input from the user is needed, and files can be swapped later.
2. **The user supplies files:** one per move type (or group) plus a typing loop.

Fixed requirements whatever the source:
- Sounds are chess sounds, not creator sounds, so they are shared by every theme. Do not hang them on the theme, which today has only an optional `timing.sting`.
- They play in both the Player and the render.
- The typing loop follows `revealAt()`, so it starts with the first word and stops with the last.
- The user said sounds may be dropped ("sundered") if they become the bottleneck.

Also waiting on the user: whether speaker naming should prefer **first names** like the creator ("Frank", "Carl") over full names ("Walter White"). For now names can be edited in the Cast tab.

### Format iterations (the creator's list, Oct 12; each ends with a commit and a walkthrough)

1. **10% dim and the Book rule (done, `fb225f4`).** Holds dim 10%. Book is only allowed in the first 30 s (`BOOK_WINDOW_SEC`, `relabelLateBook()`): the Analyst is told, and later Book moves are relabelled Good in `snapMoves` and Regenerate. There is no editor warning, by the user's choice.
2. **Shorter, denser text (done, `ea48c00`).** `TEXT_CAPS`: label 24, breakdown 170, best move 32 (motif 20 was added in step 4), taken from the creator's cards. Breakdowns are two sentences: what the character visibly does, then the verdict in chess terms. The writing rules (concrete, no filler or hedging, no verdict-word openers) are in `prompts.ts`. `style/corpus.json` leads with the creator's five real cards (`source: creator`); the other ratings are Claude-written placeholders (`source: placeholder`).
3. **Type-out (done, `6ea986e`).** Only the explanation types, at the creator's measured speed: a word every 0.18 s (5.5 words a second; the user chose this over their first estimate of 2), each fading in over 0.12 s. The best move and motif fade in after the last word. Then 4 s with the finished card. The type-out lives in `revealAt()` (`packages/composition/src/card.ts`) and `typeOutSec()` and `typeOutStartSec()` (`packages/schema/src/rules.ts`). `autoHoldSec` = badge delay + pop + card in + type-out + reread + card out. A locked hold too short for its text types faster. Review mode stops when typing starts; the paused edit layer shows the full text.
4. **Creator theme (done, `a2945bb`).**
   - **Theme file:** `packages/theme/src/creator-theme.ts`.
   - **`headline` card layout:** "<Move> is <phrase>" in the rating colour, then a grey line "<number> <actor> · <Move><NOTATION>", the breakdown, "Better was: …" with a branch icon, and a motif chip.
   - **Badge:** round, 184 px, beside the card. It pops in at 0.3 s over 0.2 s with an overshoot; the card comes in after it.
   - **Measured values:** Arial, 640 px wide, 9 px accent edge, background `rgba(34,33,29,0.9)`. Sampled colours: Brilliant `#419ba7`, Great `#6386b1`, Best `#93b146`, Inaccuracy `#f2c247`. The other six are `TODO(open-decision)` placeholders until a reference video with those ratings is sampled.
   - **Hold edges:** the dim is instant and the card cuts away with no fade.
   - **Motifs:** the Analyst writes `motif` (nullable) per move.
   - **Sides:** the Analyst names `protagonist` in Pass B, and `assignSides()` (`apps/server/src/analysis/sides.ts`) gives them White, else a coin flip among the characters with moves. Sides already set are never overwritten.
   - **Move numbers:** `moveNumbers()` (`packages/composition/src/notation.ts`) follows chess turn order with implied moves (W, B, B → "1", "1...", "2...").
   - **Editor:** a Look picker in the header saves `themeId` as part of the editor document, so switching is undoable and holds re-time; a White/Black toggle in Cast; a Motif field in the inspector, also editable on the chip.
5. **Sounds:** next, blocked on the decision above.
6. **Evaluation bar (in progress; steps 1-2 done).** Reference: `media/creator-ref/style-ref-evaluation-bar.png` and the demo clips, measured Oct 12.
   - **Look:** the creator theme's optional `evalBar` block. Black's player is at the top and White's at the bottom; the bar's coloured part spans x 26-67 and y 112-968 at 1080p. The label is at the leader's end, unsigned ("1.0", "M4"). The default theme has no bar.
   - **Data:** `Moment.eval` (the eval after the move) and `project.evalBar` (`start` plus `beats`). An eval is `{pawns}` or `{mate}`, signed from White's side. Bar height is `evalFill()` = 0.5 + 0.5 tanh(0.184 pawns), fitted to the creator's bar.
   - **Settling:** each new eval steps through 2-4 readings (`settleReadings()` in `packages/composition/src/eval-bar.ts`, seeded by id), 0.18, 0.58, 1.13 and 1.78 s into the freeze. The label changes first and the bar eases after. Beats use 1-2 readings in about 0.5 s (the user's choice: quieter than cards).
   - **Beats (the user's idea):** Pass A over-generates about twice the target. The candidates Pass B does not card become beats: the bar moves during play with no freeze, so it reacts between cards. They are placed like spoken moves and kept 2.5 s clear of any other change (`placeBeats()`).
   - **Pass C (`evaluate` stage, Opus, after snap):** one call values every card and beat together, so the bar tells one story instead of wobbling. Code then enforces the rules in `applyEvaluation()`: a rating never moves the bar the wrong way for the mover (it holds instead), beats move it at most 6% and never start a mate, and evals on kept (approved or user) moves and user beats are fixed. Sizes per rating are a `TODO(open-decision)`. `evalWarnings()` flags the same rules in the editor.
   - **BB1:** has a hand-written Pass C (`analysis/recorded/claude-evaluate.json`): 7 cards and 7 beats. Hank opens up 1.5, the cancer card turns it, Walt reaches +6.1, and "Tread Lightly" flips it to M4 for Black.
   - **Dialogue fixture:** has a synthetic `claude-evaluate.json`, to be replaced with the real recording that is still owed.
7. **Burned-in subtitles** of the dialogue. The user put these after the features that set the format apart.

**Reference clip:** BB1 stays the reference until the format is proven, then BB2. `media/BB2.mov` is still the duplicate of BB1 (the user apologised and knows), so the real BB2 is needed before then.

### Creator reference (`media/creator-ref/`, gitignored, Catch Me If You Can motel scene)

These are four screenshots (`style-ref-*.png`) and five clips (`style-sound-demo-*.mov`, 1080p60 with audio). What they show:
- **Card text:** move names are 2-3 words in Title Case. Breakdowns are two sentences of about 27 words (150-160 characters). "Better was: <2-4 word command>" appears only on inaccuracies and worse. Motif chips: Quiet Move, Zwischenzug, Sacrifice, Check.
- **Move numbers:** "1 Carl", "1... Frank", "2... Frank", "3 Carl", "4... Frank". "4..." implies a card between "3 Carl" and "4... Frank" that wasn't in the clips.
- **Timing from the freeze:** dim on frame 1; badge pops at 0.3 s; card fades and slides in at 0.57 s; first word at 0.77 s; 27 words in about 5 s; 3.6-4.2 s of finished card; then an instant cut.
- **Eval bar and subtitles:** both are on screen throughout.

To measure more, use `scripts/ref/hold-phases.mjs <clip> <crop>` for timing, PIL (Python 3, installed) for colours, and `ffmpeg … tile=` contact sheets for reading text. Write scratch output to the session scratchpad, never into the repo.

### Real-clip project and the hand-off analyst

- **`projects/bb1-ea55`** is `media/BB1.mov` (Breaking Bad, Hank and Walt in the garage, 2:28). It has:
  - a real transcript (ElevenLabs) and real scene notes (Gemini)
  - seven draft moves written by Claude Code standing in for the Analyst, all still `ai`/`draft`
  - the creator theme, with Walter White as White and Hank Schrader as Black
  - Diarization put two of Hank's lines on Walt (u7 "And for what?", u22 "What's the point?").
  - The Pass B answers are kept in `analysis/recorded/`: `claude-annotate.v1-long-text.json` (Phase 4), `.v2-no-motif.json` (iterations 2-3) and `claude-annotate.json` (current), each with its `request-annotate*.json`.
- **The Anthropic balance is empty**, so Claude Code writes the Claude answers by hand through `ANALYST_HANDOFF_DIR` (`handoffAnalyst` in `providers/replay.ts`). The pipeline writes `request-<call>.json` and waits; a `claude-<call>.json` (`{"output": …}`) is then validated like a live answer and labelled `hand-written/claude-code-session` at $0. To redo only Pass B on BB1:
  1. Copy `claude-decisions.json` and `claude-speakers.json` from BB1's `analysis/recorded/` into a scratch hand-off folder (so Pass A and speaker naming are reused), and leave `claude-annotate.json` out.
  2. In `apps/server`, run `ANALYST_HANDOFF_DIR=<dir> node --env-file-if-exists=.env src/index.ts` (no `--watch`; see the lessons below).
  3. Send `POST /api/projects/bb1-ea55/analyze` with `{"rerun":"analyst"}`. It writes `request-annotate.json` and fails waiting.
  4. Write `claude-annotate.json` and POST again.
  5. Archive the previous answer in `analysis/recorded/` with a version suffix.

  A rerun replaces unapproved drafts, so first check they are unedited. Keep the same picks and ratings when testing a format change, so only one thing varies.
- **Still owed from Phase 4 (needs an Anthropic balance):**
  1. Run the dialogue clip once with `ANALYSIS_RECORD_DIR` and commit all six real responses together, replacing the synthetic ones in `fixtures/dialogue/recorded/`. Those were last hand-edited in iteration 4 to add `motif` and `protagonist`.
  2. Do one live Opus run on BB1, compare it with the hand-written moves, and report the real Claude cost per clip. The estimate is $0.25-0.40; the real Scribe cost was $0.011 and Gemini $0.008 for the 2:28 clip.
- **Vendor choices (user delegated, price-optimised):**
  - ElevenLabs Scribe v2 at $0.22/h, for the best independent WER among the candidates, plus sound tags
  - Gemini 3.5 Flash-Lite for scene notes
  - Claude Haiku 5.5 for speaker naming
  - Opus 5.5 for the Analyst and Sonnet 5.5 for Regenerate, per the plan

  The live keys are in `apps/server/.env`. Run the server from `apps/server` (or with `--env-file`), or it sees no keys.

### Standing decisions from the creator's reviews (also in PLAN.md)

- Holds follow the type-out (iteration 3). Spoken moves freeze 0.15 s after the last word, in that word's shot, clear of cuts.
- Holds dim the frozen frame by 10%.
- No Book moves after 30 s.
- Brilliant, Great, Best and Book moves never carry a best move.
- The video is 80% of the centre column and capped to the viewport height. Nothing auto-scrolls the page.
- The creator liked the peripheral editor features (cast, evidence, live feedback); keep that level of polish.
- **Demo data:** the creator's Dexter clip is local in `media/`; never commit it. Seed its moves with `pnpm seed:moments doakes-catching-dexter-b8f1 fixtures/demo/doakes-moments.json`. Claude wrote those moves from frames; they were not transcribed. They now carry sides and motifs.

### How each step ends (the user's standing workflow)

1. Run `pnpm check`.
2. Run the browser checks against `PROJECTS_DIR=<scratch> pnpm dev` with freshly seeded samples (`pnpm seed:sample`; each check edits its project, so seed one per check). `phase2-checks` needs the output frame count, currently 1143 for the sample under the default theme.
3. Look at screenshots.
4. Commit.
5. Update this section.
6. Give the user a short numbered walkthrough and stop.

### Lessons learned

- `pnpm dev` runs the server under `node --watch`. Killing the process on port 8787 is not enough: the watcher restarts it when files change, possibly against the user's real projects. Stop everything with `pkill -f "src/index.ts"; pkill -f vite`.
- The editor's edit layer covers a paused hold with the full, editable card, so screenshots of the drawn frame (type-out, badge pop) must hide `[data-testid=edit-layer]`. `typeout-checks.mjs` does this.
- The inspector's first input is the Regenerate box, not the label. Find fields by value or placeholder.
- A PUT to `/api/projects/:id` needs `themeId` as well as moments and characters.
- To set a React `<select>` from a check, use the native value setter and dispatch `change` (see `format-checks.mjs`).
