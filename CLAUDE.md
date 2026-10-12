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
- `scripts/browser/`: headless-Chrome checks (`phase2-checks.mjs`, `phase3-checks.mjs`, `typeout-checks.mjs`, `format-checks.mjs`, `evalbar-checks.mjs`, `sound-checks.mjs`, `subtitle-checks.mjs`) over the DevTools protocol (no dependencies) against a running `pnpm dev`. The dev build exposes the Player as `window.__alsPlayer`.
- `scripts/ref/hold-phases.mjs <clip> <crop>`: times a reference clip's hold phases (freeze, badge, card, type-out, exit) from frame changes.

## Layout

- `apps/web`: editor UI (Vite, React, Tailwind).
- `apps/server`: Hono API, jobs, ffmpeg, AI adapters, render. Runs TypeScript directly on Node (type stripping), so use only erasable syntax and `.ts` import extensions.
- `packages/schema`: Zod schemas and the types derived from them; the only source of types.
- `packages/composition`: Remotion `<Episode>`, `<MoveCard>`, `timeMap()`. Lint enforces purity.
- `packages/theme`: classification tokens, badges, theme presets.
- `fixtures/`: test data, including the sample project and recorded provider responses.
- `projects/`: runtime project folders, gitignored. `PROJECTS_DIR` overrides the location.
- `media/`: local demo footage (copyrighted), gitignored. Never commit clips. `media/sounds/` holds the user's chess sound files (`SOUNDS_DIR` overrides it); never commit them either.

## Conventions

- All times are source-clip seconds; frames are derived, never stored.
- Holds follow the card text (`autoHoldSec`) unless `holdLocked`. Spoken moves freeze just after the last word, in that word's shot (`freezeAfterSpeech`); the editor's snapping uses the same helpers.
- Editor state is a Zustand store (`apps/web/src/editor/store.ts`) with undo, coalesced typing, gestures for drags, and versioned autosave (409 means reload, never overwrite). Pure edit operations live in `editor/doc.ts`.
- The edit layer draws the same `<MoveCard>` over the Player through its `editing` slots; the render path never passes them.
- Analysis (`apps/server/src/analysis/`): providers sit behind `Transcriber` / `SceneDescriber` / `Analyst` (ElevenLabs Scribe v2, Gemini, Claude). Stages cache by input hash in `<project>/analysis/manifest.json`; `rerun: 'analyst'` redoes only Pass A/B. Analyst schemas are built per clip with enums for cast, candidate and utterance ids. Prices for cost logging are in `analysis/prices.ts`. Regenerate never writes `project.json` (so an open editor is not forced to reload); its spend goes to `analysis/regenerate-usage.json`.
- The server imports `@als/theme/themes` (no JSX); the web app imports `@als/theme`. Themes: `default` (the app's own `stacked` card) and `creator` (the creator's `headline` card); a project's `themeId` is part of the editor document, so switching is saved and undoable and unlocked holds follow the new timing.
- Subtitles live in source time (`packages/schema/src/subtitles.ts`): a hold shows the line spoken before its freeze. Until the first edit they follow the transcript (`subtitlesFromTranscript()`, so `doc.subtitles` is absent); the first edit stores the whole list in the document, and "Rebuild from transcript" removes it again. The look is the theme's optional `subtitles` block, drawn over the dim.
- Chess sounds are shared by every theme, never on the theme. Files are `<id>.<ext>` per `SOUND_IDS` (`packages/schema/src/sounds.ts`); the server lists them with probed lengths at `GET /api/sounds`, and missing files are skipped. `soundCues()` (`packages/composition/src/sounds.ts`) is the only placement logic, so the Player and the render agree.
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

- **Branch:** work now happens on `main` (the user asked for this on Oct 12; commit and push to `main`). `main` was fast-forwarded to the tip of `format-iterations`, and all phase branches (`phase-0-scaffold` … `phase-4-analysis`, `format-iterations`) are pushed to GitHub as history; do not add new per-phase branches. `apps/server/.env.example` shows as deleted in the working tree from before Oct 12; it is not ours, so leave it out of commits (`git add -A -- . ':!apps/server/.env.example'`).
- **Done:** Phases 0-4 (Phase 4 has two owed items, below), the creator's review iterations, and all seven format iterations (log below).
- **Not started:** Phase 5 (export/render) and Phase 6 (pitch build). The format iterations were inserted before Phase 5 at the user's request and are now all built; Phase 5 is next once the user has reviewed them.
- **Checks at the tip:** `pnpm check` passes (224 tests). The browser checks pass: `phase2-checks`, `phase3-checks`, `typeout-checks`, `format-checks`, `evalbar-checks`, `sound-checks` and `subtitle-checks`.

### Next action: the user's review of iterations 5-7, then Phase 5

Waiting on the user:
- **Sounds (iteration 5):** listen in Preview mode. Four questions are open:
  1. **Typing level.** The typing files sit about 20 dB below the creator's typing; the move sounds match the creator's level. Options: the user re-exports them louder, or a per-sound gain is added (Web Audio allows volume above 1).
  2. **`move-capture`** is served but nothing plays it yet. Which moves should?
  3. **Inaccuracies** play `move-mistake`, as the creator's clips do (0.99 match), not `move-self`/`move-opponent` as the user's rule said. One line to undo: `BORROWED` in `sounds.ts`.
  4. **Missing files:** `move-miss` and `hold-open` (the segment opening). Dropping them in `media/sounds` makes them play; nothing else changes.
- **Subtitles (iteration 7):** review them on BB1 (Subtitles tab). One open decision: `SUBTITLE_MAX_CHARS` (42). The creator's lines seen so far are short single sentences, and how they split a long one is unknown.
- **Evaluation bar (iteration 6):** review it on BB1. Its Pass C was written by hand. BB1 now has portraits.
- **Size per rating** (`TODO(open-decision)` on `EVAL_DIRECTION`): the code fixes only the direction; the Analyst picks the size.
- Whether speaker naming should prefer **first names** like the creator ("Frank", "Carl") over full names ("Walter White"). For now names can be edited in the Cast tab.

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
5. **Sounds (done).** The user supplied the files (`media/sounds`, 48 kHz, gitignored). Placement was measured on the creator's clips (Oct 12) by cross-correlating the files with their audio: the freeze is silent, the move sound starts 0.27-0.29 s in as the badge pops, and typing runs from the first word to about the last, with a silent reread.
   - **Game:** `game-start` on frame 0, `game-ten-seconds-remaining` 10 s before the end, and `game-end` finishing on the last frame.
   - **Holds:** `hold-open` (no file yet) on the first frozen frame, then the move sound at `badgeDelaySec`. The move sound is the rating's own `move-<rating>` if the file exists, else a borrowed one (inaccuracy → mistake), else `move-self` for White and `move-opponent` for Black.
   - **Typing** follows `revealAt()` (and `typeOutSpeed()` for short locked holds): `typing-start-middle` from the first word, looping if needed, then `typing-end` placed so its last keystroke (1.24 s in, `TYPING_END_LAST_KEY_SEC`) lands on the last word. A short type-out starts partway into the ending. The recording plays at its own 97 WPM, never sped up (that would raise its pitch).
   - **Spaces:** a press every 60/97 s (a WPM word is five keystrokes including its space), each snapped to a word appearing, varied among `typing-space-1..3` and seeded by the move's id.
   - **Plumbing:** `SoundLibrary` (`apps/server/src/media/sounds.ts`) and `GET /api/sounds[/:file]`. The editor fetches the bank into `EpisodeProps.sounds`, and `<Episode>` draws one premounted `<Audio>` per cue.
   - `sound-checks.mjs` strips the scratch project's audio, plays the whole episode under both looks and compares the Web Audio schedule with `soundCues()`. All cues land within 0.6 frames.
6. **Evaluation bar (done: `147731b`, `2da3bdf`, `c81ca21` and the portraits commit).** Reference: `media/creator-ref/style-ref-evaluation-bar.png` and the demo clips, measured Oct 12.
   - **Look:** the creator theme's optional `evalBar` block. Black's player is at the top and White's at the bottom; the bar's coloured part spans x 26-67 and y 112-968 at 1080p. The label is at the leader's end, unsigned ("1.0", "M4"). The default theme has no bar.
   - **Data:** `Moment.eval` (the eval after the move) and `project.evalBar` (`start` plus `beats`). An eval is `{pawns}` or `{mate}`, signed from White's side. Bar height is `evalFill()` = 0.5 + 0.5 tanh(0.184 pawns), fitted to the creator's bar.
   - **Settling:** each new eval steps through 2-4 readings (`settleReadings()` in `packages/composition/src/eval-bar.ts`, seeded by id), 0.18, 0.58, 1.13 and 1.78 s into the freeze. The label changes first and the bar eases after. Beats use 1-2 readings in about 0.5 s (the user's choice: quieter than cards).
   - **Beats (the user's idea):** Pass A over-generates about twice the target. The candidates Pass B does not card become beats: the bar moves during play with no freeze, so it reacts between cards. They are placed like spoken moves and kept 2.5 s clear of any other change (`placeBeats()`).
   - **Pass C (`evaluate` stage, Opus, after snap):** one call values every card and beat together, so the bar tells one story instead of wobbling. Code then enforces the rules in `applyEvaluation()`: a rating never moves the bar the wrong way for the mover (it holds instead), beats move it at most 6% and never start a mate, and evals on kept (approved or user) moves and user beats are fixed. Sizes per rating are a `TODO(open-decision)`. `evalWarnings()` flags the same rules in the editor.
   - **Editor:**
     - A Bar lane under the moves shows the curve as a step plot, with solid dots for cards and hollow ones for beats (click a beat to select it).
     - With nothing selected, the Move tab shows the bar panel: the start value, "Add beat here" (or `B`), and **Re-evaluate**.
     - Re-evaluate is `POST /projects/:id/evaluate`, Pass C on the editor's track. Like Regenerate, it never writes `project.json`. Its result goes on as one undoable edit, and its spend goes to `analysis/evaluate-usage.json`. A track with no bar gets beats placed from the cached Pass A.
     - Moves have a "Bar after this move" field (`parseEval`: "1.0", "-0.8", "M4", "-M6"), and the beat inspector edits time, value, who, what happened and why.
     - `evalWarnings` show beside `momentWarnings`. `Delete` removes a selected beat.
     - Fixed on the way: leaving a paused hold now drops the playhead anchor. Before, a later edit pulled the playhead back to the card.
   - **Portraits (the user's choice: cropped from the video):**
     - In the Cast tab, click a character's face box: a square appears over the stage. Drag it onto the face, resize it from the corner, then press Use (Enter) or Cancel (Esc).
     - `POST /projects/:id/portraits` crops that source frame with ffmpeg into `portraits/<character>-<hash>.jpg` (256 px). It saves only the image; the editor sets `Character.portrait` as an undoable edit.
     - `EpisodeProps.portraits` maps character ids to URLs. Without one, the bar shows initials in the side's colours. The bar shows the character with the most moves on each side.
   - **BB1:** has a hand-written Pass C (`analysis/recorded/claude-evaluate.json`): 7 cards and 7 beats. Hank opens up 1.5, the cancer card turns it, Walt reaches +6.1, and "Tread Lightly" flips it to M4 for Black.
   - **Dialogue fixture:** has a synthetic `claude-evaluate.json`, to be replaced with the real recording that is still owed.
7. **Burned-in subtitles (done).** Measured on the creator's clips (Oct 12):
   - **Look:** Arial Bold 50 px, white, with a 5 px black outline outside the letters. One line, centred, baseline 65 px above the bottom, no box, not dimmed by the hold.
   - **Timing:** lines are on throughout and hold through a freeze. They go off 0.18 s of source time after playback resumes, so about 0.3 s after the last word. Gaps between lines stay empty.
   - A 1080p frame of ours matches the creator's within 1-2 px (width 634 vs 638, letter height 37 vs 37, centre 958 vs 958).
   - **Building lines:**
     - `subtitlesFromTranscript()` gives one sentence per line from its first word to `SUBTITLE_TAIL_SEC` (0.3 s) after its last.
     - A sentence over `SUBTITLE_MAX_CHARS` (42, `TODO(open-decision)`) splits at the most even comma or dash where both halves fit, else at the most even word.
     - A line stays at least 0.8 s unless the next one starts first, and gaps under 0.25 s close.
     - A line under 0.3 s on screen (a mis-timed word) folds into an unfinished line before it.
     - A leading "..." and sound tags are dropped.
   - **Data:** `Project.subtitles` and `ProjectEdit.subtitles` are absent while the lines follow the transcript. `EpisodeProps.subtitles` carries the lines.
   - **Rendering:** `<SubtitleLine>` (`packages/composition/src/Subtitles.tsx`) draws the line at the frame's source time. Themes: creator as measured; the default look has its own (system sans 600, 44 px).
   - **Editor:** a Subtitles tab lists every line, with the live one highlighted. Click a time to show it. Text, start and end are editable, × deletes a line, and "Rebuild from transcript" drops all edits. Every change is undoable and autosaved.
   - `subtitle-checks.mjs` covers: the line during speech and through a hold, the measured look, edit, save, reload, rebuild, undo, delete, and the default look.

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
  1. Run the dialogue clip once with `ANALYSIS_RECORD_DIR` and commit all seven real responses together, replacing the synthetic ones in `fixtures/dialogue/recorded/`. Those were last hand-edited in iteration 4 to add `motif` and `protagonist`; `claude-evaluate.json` was written by hand in iteration 6.
  2. Do one live Opus run on BB1, compare it with the hand-written moves and bar, and report the real Claude cost per clip (now four Claude calls: naming, Pass A, Pass B, Pass C). The estimate is $0.25-0.40; the real Scribe cost was $0.011 and Gemini $0.008 for the 2:28 clip.
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
2. Run the browser checks against `PROJECTS_DIR=<scratch> pnpm dev` with freshly seeded samples (`pnpm seed:sample`; each check edits its project, so seed one per check). `phase2-checks` needs the output frame count, currently 1143 for the sample under the default theme. `sound-checks` also takes the projects folder, because it strips that project's audio.
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
- To type into an input from a check, focus it and send `Input.insertText` (a synthetic `input` event followed at once by `blur()` commits the old value). Select a move with the Player outside any hold: a paused hold keeps its own move selected.
- Headless Chrome can't be listened to. To check sounds, hook `AudioBufferSourceNode.prototype.start` before the page loads (see `sound-checks.mjs`). Log even before the Player reports playing, because frame 0's sounds are scheduled while the audio context resumes.
- `<Sequence premountFor>` does not allow `layout="none"`. Give `<Audio>` its own `from`, `durationInFrames` and `premountFor` instead.
- The editor is now taller than a 1150-1300 px window, so the page can show a scrollbar. Measure a container and its children in the same pass.
