# Analysed Like Chess Studio

Single-user local web app: upload a movie scene clip, draft chess-style move annotations with cloud AI, edit them over live playback, render an MP4 with freeze-frames burned in. `PLAN.md` is the full build plan; read the section for the current phase before starting work.

## Commands

- `pnpm dev`: web (Vite, http://localhost:5173) and server (Hono, http://127.0.0.1:8787) together. Vite proxies `/api` to the server.
- `pnpm check`: lint, typecheck and tests. Run before every commit. It includes the render test (`apps/server/src/render/render.test.ts`, about 13 s), which renders the sample through headless Chrome.
- `pnpm test` / `pnpm lint` / `pnpm typecheck`: individually.
- `scripts/make-sample-clip.sh`: regenerates `fixtures/sample/source.mp4` (needs system ffmpeg).
- `scripts/make-dialogue-clip.sh`: regenerates `fixtures/dialogue/source.mp4`, a rights-free two-voice scene (macOS `say`) for analysis tests.
- `ANALYSIS_REPLAY_DIR=$PWD/fixtures/dialogue/recorded pnpm dev`: runs analysis on recorded responses, no keys or API calls. Card placement replays one recorded Gemini answer for every frame. `ANALYSIS_RECORD_DIR` records real ones.
- `ANALYST_HANDOFF_DIR=<dir> pnpm dev`: dev only, replaces the LLM calls with request/answer files a Claude Code session writes by hand (see Status).
- `pnpm seed:sample`: creates a project from the fixture (3 moments). `pnpm seed:moments <projectId> <file>` replaces a project's moments, e.g. `fixtures/demo/doakes-moments.json` for the Dexter demo clip.
- `scripts/browser/`: headless-Chrome checks (`phase2-checks.mjs`, `phase3-checks.mjs`, `typeout-checks.mjs`, `format-checks.mjs`, `evalbar-checks.mjs`, `sound-checks.mjs`, `subtitle-checks.mjs`, `render-checks.mjs`, `placement-checks.mjs`) over the DevTools protocol (no dependencies) against a running `pnpm dev`. The dev build exposes the Player as `window.__alsPlayer`.
- `scripts/ref/hold-phases.mjs <clip> <crop>`: times a reference clip's hold phases (freeze, badge, card, type-out, exit) from frame changes.
- `scripts/ref/format-metrics.py <project.json>...`: pacing, holds, text, ratings and bar of projects side by side, for tuning a format against a hand-edited benchmark.

## Layout

- `apps/web`: editor UI (Vite, React, Tailwind).
- `apps/server`: Hono API, jobs, ffmpeg, AI adapters, render. Runs TypeScript directly on Node (type stripping), so use only erasable syntax and `.ts` import extensions.
- `packages/schema`: Zod schemas and the types derived from them; the only source of types.
- `packages/composition`: Remotion `<Episode>`, `<MoveCard>`, `timeMap()`. Lint enforces purity. `render-entry.tsx` registers the composition for the renderer; the server imports only `@als/composition/timeline` (plain TypeScript, no JSX).
- `packages/theme`: classification tokens, badges, theme presets.
- `fixtures/`: test data, including the sample project and recorded provider responses.
- `projects/`: runtime project folders, gitignored. `PROJECTS_DIR` overrides the location.
- `media/`: local demo footage (copyrighted), gitignored. Never commit clips. `media/sounds/` holds the user's chess sound files (`SOUNDS_DIR` overrides it); never commit them either.

## Conventions

- All times are source-clip seconds; frames are derived, never stored.
- Theme sizes are theme units: pixels on a frame whose shorter side is 1080 (`themeUnit()` in `packages/schema/src/theme.ts`), so a vertical clip's text is the same size on a phone as a landscape clip's. Cards, the bar, subtitles and placement all use it; never divide by the frame height.
- Formats (`packages/schema/src/format.ts`): a project is `short` or `long` (`Project.format`; absent is guessed from the clip, vertical = short, by `projectFormat()`). `FORMAT_RULES` is the only place pacing lives: cards per second, minimum card gap, the reread after the last word, the Book window, beat spacing, size and count. Card text is the same in both formats (`CARD_TEXT_CAPS`, one set of writing rules in `prompts.ts`; the user's call, Oct 15: the two-sentence breakdown is what makes the videos entertaining). The theme owns the look and animation timing only. The format is part of the editor document (Format picker beside Look), and Regenerate and Re-evaluate send the editor's format.
- Holds follow the card text (`autoHoldSec`) unless `holdLocked`. Spoken moves freeze just after the last word, in that word's shot (`freezeAfterSpeech`); the editor's snapping uses the same helpers.
- Editor state is a Zustand store (`apps/web/src/editor/store.ts`) with undo, coalesced typing, gestures for drags, and versioned autosave (409 means reload, never overwrite). Pure edit operations live in `editor/doc.ts`.
- The edit layer draws the same `<MoveCard>` over the Player through its `editing` slots; the render path never passes them.
- Analysis (`apps/server/src/analysis/`): providers sit behind `Transcriber` / `SceneDescriber` / `Analyst` (ElevenLabs Scribe v2, Gemini, and OpenAI GPT-6 Luna; a `claude-` model name routes the Analyst to Claude instead). Stages cache by input hash in `<project>/analysis/manifest.json`; `rerun: 'analyst'` redoes only Pass A/B. Analyst schemas are built per clip with enums for cast, candidate and utterance ids. Prices for cost logging are in `analysis/prices.ts`. Regenerate never writes `project.json` (so an open editor is not forced to reload); its spend goes to `analysis/regenerate-usage.json`.
- The server imports `@als/theme/themes` (no JSX); the web app imports `@als/theme`. Themes: `default` (the app's own `stacked` card) and `creator` (the creator's `headline` card); a project's `themeId` is part of the editor document, so switching is saved and undoable and unlocked holds follow the new timing.
- Subtitles live in source time (`packages/schema/src/subtitles.ts`): a hold shows the line spoken before its freeze. Until the first edit they follow the transcript (`subtitlesFromTranscript()`, so `doc.subtitles` is absent); the first edit stores the whole list in the document, and "Rebuild from transcript" removes it again. The look is the theme's optional `subtitles` block, drawn over the dim.
- Chess sounds are shared by every theme, never on the theme. Files are `<id>.<ext>` per `SOUND_IDS` (`packages/schema/src/sounds.ts`); the server lists them with probed lengths at `GET /api/sounds`, and missing files are skipped. `soundCues()` (`packages/composition/src/sounds.ts`) is the only placement logic, so the Player and the render agree.
- Hard invariants (moment spacing, ordering, references) live in `ProjectSchema`. Soft rules (text caps, `bestMove` on best/brilliant) are `momentWarnings()`, so the editor warns without blocking saves.
- The output is the source with a hold at each moment. `buildTimeline()` in `packages/composition` is the only mapping between source and output frames; the Player, timeline UI and renderer all use it.
- `<Episode>` renders one `<Sequence>` per play-then-hold segment so the same `@remotion/media` `<Video>` plays into its `<Freeze>`; premounting loads the next segment. Verified frame-exact in the Player (Phase 2 spike), so the extracted-still fallback is not needed.
- Card placement: a card's `placement` is `auto` (placed clear of faces, and placed again when its move is retimed), `user` (set by hand; never moved), or absent (older cards: the theme's corner unless custom or resized, see `placedByHand()`). Each move keeps the `regions` (heads, eyes-to-mouth boxes, subject) of the frame it was looked at; `regionsFresh()` says whether they still match its time. `autoPlaceCard()` (`packages/composition/src/placement.ts`, plain TypeScript so the server uses it too) is the only placement logic; its weights put eyes and mouths first, a smaller card (never below `MIN_AUTO_SCALE`) second, the rest of a face third. Gemini answers are cached per frame and prompt in `analysis/regions-cache.json` (bump `REGIONS_PROMPT_VERSION` when the prompt changes); editor spend goes to `analysis/regions-usage.json`. Placement runs on discrete events only (regions arriving, a new look, Re-evaluate), never while typing, so a card never moves under the cursor.
- Rendering (`apps/server/src/render/`): `episodeProps()` (`packages/schema/src/episode.ts`) is the one way a document becomes `<Episode>` props, used by the Player and the renderer. A render reads a snapshot of the saved version (`renders/<id>.json`), loads the original source (not the proxy), portraits and sounds from this server over HTTP with absolute URLs, and writes `renders/<id>.mp4` (H.264 CRF 18, AAC 320k, BT.709). The bundle is made once and again only when composition, schema or theme sources change. Renders are listed in `renders/renders.json`; live progress goes out over `/api/events` as `render` events.
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

## Status and handoff (updated Oct 15, 2026)

Read this first in a new session. It says where the work stands, what to do next, what is waiting on the user, and what was learned the hard way.

### Where things stand

- **Branch:** work now happens on `main` (the user asked for this on Oct 12; commit and push to `main`). `main` was fast-forwarded to the tip of `format-iterations`, and all phase branches (`phase-0-scaffold` … `phase-4-analysis`, `format-iterations`) are pushed to GitHub as history; do not add new per-phase branches. `apps/server/.env.example` shows as deleted in the working tree from before Oct 12; it is not ours, so leave it out of commits (`git add -A -- . ':!apps/server/.env.example'`).
- **Done:** Phases 0-5 (Phase 4 has two owed items, below), the creator's review iterations, and all seven format iterations (log below).
- **Not started:** Phase 6 (pitch build).
- **Checks at the tip:** `pnpm check` passes (296 tests, including the render test). The browser checks pass: `phase2-checks`, `phase3-checks`, `typeout-checks`, `format-checks`, `evalbar-checks`, `sound-checks`, `subtitle-checks`, `render-checks` (on the sample and on a copy of BB1) and `placement-checks`.

### Next action: the user's review of short- and long-form, then Phase 5 (and iterations 5-7), then Phase 6

**Short- and long-form (Oct 15).** The user hand-edited `projects/snaptik-7541156735361289485-v3-82b5` ("Private Property", 70 s vertical) as the short-form benchmark. The flow's own output is in that project's `analysis/*.json` caches (4 cards) and in `private-property-baseline-61ac` ("Private Property (old flow)", a fresh run before the change). The new flow's output is `private-property-short-v1-d1f7` ("Private Property (short-form flow)", round 4). Compare runs with `python3 -I scripts/ref/format-metrics.py <project.json>...` (pacing, holds, text, ratings, bar).
- **Benchmark against the old flow:** 8 cards (one per 8.8 s, first at 4.4 s) against 4 (one per 17.5 s, first at 10.6 s); holds 2.7-5 s (median 2.9, about 1.4 s after the last word) against 9 s; one-sentence breakdowns of 3-9 words (median 37 characters; they give the payoff, e.g. the other side's reaction, and never describe the move again) against 26 words; labels are the line itself; 5 of 8 ratings negative, no Book or Good; the bar spans 5-75% (cards move it a median 16%) against 22-47% (4%); 6 beats, some 1.1 s apart in a rapid exchange.
- **Built:** `FORMAT_RULES.short` from those numbers (9 s per card, 4 s minimum gap, 1.4 s reread, Book only in the first 10 s, beats 1 s apart, up to 8% each, one per card); long keeps the creator's values (20 s, 4 s reread, 170, Book 30 s, beats 2.5 s and 6%); long's 8 s card gap and two beats per card are not measured. Prompts differ per format only in pacing and verdicts: in short-form at most one card in four is Book/Good/Excellent/Inaccuracy, the first card is the hook from the opening exchange, and Pass C keeps the bar within about ±5 until the last card.
- **Text reverted (Oct 15, the user's call):** the one-sentence short-form breakdowns (cap 90, `shortExplanation`/`shortVoice` examples, character's-words labels) read flatter than the old flow's. Both formats now write the old two-sentence card (labels, breakdown, best move, writing rules and examples as in `87bbb41`), so the benchmark's text is no longer a target, only its pacing. Holds follow: about 7 s for a 27-word breakdown with the 1.4 s reread. The round on this is `private-property-full-text-e4a2` ("Private Property (short-form, full text)").
- **Built for both formats:** Pass A names `moveLine` (the utterance and the move's last words), so a move freezes right after its own words, mid-utterance if need be, never after the reply (the new run froze at 12.2 s and 43.9 s, exactly the user's frames). Pass B names `allies`, who play White with the protagonist (the companion was on Black). Pass C has typical sizes per rating (inaccuracy 0.5-1 pawn, mistake about 2, great/best/miss 2.5-3.5, blunder/brilliant 3+), each card carries its own swing (the model had moved it onto the next beat), beats mostly carry the last card's direction, and the last value is the result (a scene nobody wins ends at 0.0, as the user's did).
- **Rounds on the benchmark (Luna, standard tier, about $0.013 each):** v1 matched cadence, holds and text but 24 beats pinned the bar at -9 and two cards came 1.1 s apart; v2 (card gap, beat cap) gave a sawtooth bar; v3 (beats follow momentum, committed ratings) came close: 7 cards, holds 3.4 s in the creator look, 42-character breakdowns, one middle rating, ending at 0.0; v4 fixed long-form's misplaced swings. Long-form on the BB1 Luna copy (`bb1-luna-7c3e`, round 4): cards move the bar a median 12%, beats 2%.
- **Still off:** the first card comes at 1.5 s (benchmark 4.4 s; BB1's at 0.5 s is "Hank", a weak card); short-form card swings are about half the benchmark's (median 8-9% against 16%); run-to-run noise is as large as the remaining gaps.
- **Waiting on the user:** review the short-form flow project (switch Look to Creator to compare with the benchmark); say whether the first card should wait for a real decision (a floor such as 3 s), and whether the ±5 limit in short-form is too tight. The 0.0 ending stands in for the coming end card (who won, tallies per rating, accuracy).
- **Old short projects:** `analysis.secondsPerMove` is now optional (absent follows the format). Projects made before Oct 15 have 20 stored; the Analysis panel's density field overrides it, and setting it to the format's value clears it.

**Analyst on OpenAI (Oct 13).** The user asked to use their OpenAI credit in place of Anthropic, with cost weighted heavily. `providers/openai.ts` calls the Responses API with `fetch` (no SDK dependency): strict structured outputs, `store: false`, explicit cache breakpoints after the system prompt and the timeline (gpt-5.6 and later only), and the Flex tier (half price, may queue; falls back to standard on 429/timeout) for background stages. Regenerate and Re-evaluate pass `interactive` and use standard. Every LLM call defaults to `gpt-6-luna` (and `.env` now says so). Claude code stays: a `claude-` model in `.env` routes back to Anthropic. Recordings are `openai-<call>.json`; replay falls back to the older `claude-<call>.json` fixtures.
- **Choice (Oct 13, prices from developers.openai.com/api/docs/pricing):** gpt-6-luna is $0.10/$0.50 (flex $0.05/$0.25); gpt-6.1-sol is $2/$10 and scores 52 vs Luna's 38 on Artificial Analysis' index. At about 16k input tokens per clip (measured from BB1's requests) plus 3k visible output and an estimated 15-25k reasoning, Luna on flex is about $0.005-0.01 per clip against Sol's $0.10-0.15 and Opus's $0.25-0.40. Upgrade path if Pass B's writing falls short: `ANALYST_MODEL=gpt-6.1-sol` only.
- **Requests:** background mode, polled every 1.5 s, because one Pass B on flex ran 13 minutes and the open connection dropped. A flex call past 10 minutes is cancelled and rerun on standard. The output schema is part of the cached prefix, so the pipeline passes (one schema each) never shared a cache; only interactive calls set breakpoints now (a repeat Re-evaluate read 4025 tokens from cache: $0.0013, then $0.0008).
- **Measured on BB1 (Oct 13, scratch copy, three rounds):** naming $0.0001 (5 s), Pass A $0.0007-0.0010 (35-95 s), Pass B $0.0022-0.0027 (100-260 s on flex), Pass C $0.0006-0.0007 (50 s). The LLM costs about $0.004 per clip, against $0.25-0.40 estimated for Opus. Card placement (Gemini) is $0.0036, so a whole 2:28 clip with Scribe ($0.011) and scene notes ($0.008) is about $0.027. Regenerate is $0.001 on standard.
- **Prompt changes for Luna (`prompts.ts`):** round 1 hedged every verdict ("but"), rated everything good to mistake, left six of seven motifs empty and repeated a generic best move. The rules now ask for committed ratings (turning points are brilliant, great or blunder), a chess verdict with no "but/though/while", labels from the character's words or a nickname (never an abstract noun), a motif on most moves, in-character best moves never repeated, a first move from the opening exchange, and a checklist at the end of the Pass B task. Pass C is told to let the bar travel (no sizes per rating; still the open decision). Round 3 gave Tread Lightly brilliant, motifs on all seven cards, and a bar from -0.9 to +5.
- **Still weaker than the hand-written moves:** some best moves are generic ("Press For Proof"), and the occasional "for now" hedges. Its reading of the scene differs too: Walt starts behind, and Tread Lightly wins the scene where the hand-written version reads it as a blunder to M4 for Black. Round 3's answers and project are in `projects/bb1-ea55/analysis/recorded/luna-oct13/` (not read by replay). BB1's own drafts are untouched. Upgrade path if quality matters more than cost: `ANALYST_MODEL=gpt-6.1-sol`.
- **Tier (`OPENAI_TIER`, default `flex`; `standard` for speed):** timed on BB1 Oct 13. Flex took 197-350 s over four runs (Pass B alone 100-260 s); standard took 118 and 152 s (Pass A 26-31 s, B 65-96 s, C 18-24 s). The LLM costs $0.0036-0.0043 per clip on flex and $0.006-0.008 on standard. Regenerate and Re-evaluate always use standard. The chain is sequential by data (naming, A, B, snap, then placement and C), so the tier is the only real lever on time.
- **Next:** record the dialogue fixture once with `ANALYSIS_RECORD_DIR` (Phase 4's owed item; about $0.02 with Scribe and Gemini) so `fixtures/dialogue/recorded/` holds real `openai-*` answers.

**Vertical clips, project names and bar size (Oct 13).** Reference: `projects/snaptik-7541156735361289485-v3-82b5` (576×1024 TikTok clip). The user's choices (asked Oct 13): sizes follow the shorter side; the bar's corner padding is 3% of the shorter side; subtitles scale the same way and sit above the bottom player tag on narrow frames; the bar size is per project.
- **Sizes:** `themeUnit()` = shorter side / 1080. 16:9 is unchanged; on the snaptik clip the Creator card is 341 px plus a 111 px badge, and the Default card shrinks from about 516 px to 341 px too.
- **Bar (`evalBarLayout()`, `packages/composition/src/layout.ts`):** portraits sit `inset` (0.03 of the shorter side) from the top-left and bottom-left corners; the bar runs between them with the measured gaps (`gap: {top: -2, bottom: 6}`). At 1080p the corner is now 32 px (the creator's was 22-26 px). Placement's no-go zones come from the same layout.
- **Bar size:** `Project.evalBarScale` (0.9 or 0.8; absent is 100%), a "Bar" picker beside Look (only for looks with a bar), saved and undoable; every part shrinks, the corners stay, the bar gets longer. Changing it re-places automatic cards.
- **Subtitles:** `subtitleBaseline()` keeps the theme's height unless the longest possible line (42 characters or `maxWidth`) could reach the bottom portrait; then every line sits just above it. 16:9 is unchanged.
- **Names:** `Project.title`, edited by clicking the title in the editor header (Enter saves, Esc cancels, blank goes back to the movie title or file name). It is part of the editor document, so it autosaves and undoes; restoring a history version keeps the current name. `projectName()` is the one fallback chain. The movie title stays separate because the Analyst reads it.
- **Render presets** now scale the shorter side: 1080p of a vertical clip is 1080×1920.
- **Verified:** all browser checks pass on fresh samples; `render-checks` on the snaptik copy passes (576×1024, holds 31-32 dB against preview). The real snaptik project's cards are still where the old sizes put them (Creator cards in the top-right fallback, clipped); switching Look away and back re-places automatic cards from their cached regions at no cost, or press Re-evaluate per card.
- **Waiting on the user:** review the snaptik clip in both looks and at 90/80% bar; say whether the smaller Default card on vertical is right, and whether the 1080p bar corner (32 px instead of the creator's 22-26 px) is acceptable. Cards can cover the clip's own burned-in captions (placement does not detect text).

Phase 5 (Oct 13) is built and waiting on the user's review. See "Phase 5: export" below.

Waiting on the user:
- **Sounds (iteration 5):** listen in Preview mode. Four questions are open:
  1. **Typing level.** The user re-exported the typing files 12 dB louder (Oct 13). Measured after that, the loop averages -42.1 dB against the creator's typing at -35.7 dB (mean over the type-out of three clips, -35.2 to -36.0), so it is still about 6 dB quiet. The loop peaks at -19.8 dB, so +6 dB more would not clip. No gain is added in code.
  2. **`move-capture`** is served but nothing plays it yet. Which moves should?
  3. **Inaccuracies** play `move-mistake`, as the creator's clips do (0.99 match), not `move-self`/`move-opponent` as the user's rule said. One line to undo: `BORROWED` in `sounds.ts`.
  4. **Missing files:** `move-miss` and `hold-open` (the segment opening). Dropping them in `media/sounds` makes them play; nothing else changes.
- **Evaluation bar (iteration 6):** review it on BB1. Its Pass C was written by hand. BB1 now has portraits.
- **Size per rating** (`TODO(open-decision)` on `EVAL_DIRECTION`): the code fixes only the direction; the Analyst picks the size.
- **Card placement (built Oct 13):** review it on BB1 (see "Card placement" below). Existing projects keep their cards until Re-evaluate is pressed; new analysis runs place drafts automatically.

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
   - **Game:** `game-start` 1 s in (`GAME_START_SEC`, the user's choice on Oct 13 so it is heard; frame 0 on a video shorter than that), `game-ten-seconds-remaining` 10 s before the end, and `game-end` finishing on the last frame.
   - **Holds:** `hold-open` (no file yet) on the first frozen frame, then the move sound at `badgeDelaySec`. The move sound is the rating's own `move-<rating>` if the file exists, else a borrowed one (inaccuracy → mistake), else `move-self` for White and `move-opponent` for Black.
   - **Typing** follows `revealAt()` (and `typeOutSpeed()` for short locked holds): `typing-start-middle` from the first word, looping if needed, then `typing-end` placed so its last keystroke (1.24 s in, `TYPING_END_LAST_KEY_SEC`) lands on the last word. A short type-out starts partway into the ending. The recording plays at its own 97 WPM, never sped up (that would raise its pitch).
   - **Spaces:** a press every 60/97 s (a WPM word is five keystrokes including its space), each snapped to a word appearing, varied among `typing-space-1..3` and seeded by the move's id.
   - **Plumbing:** `SoundLibrary` (`apps/server/src/media/sounds.ts`) and `GET /api/sounds[/:file]`. The editor fetches the bank into `EpisodeProps.sounds`, and `<Episode>` draws one premounted `<Audio>` per cue.
   - `sound-checks.mjs` strips the scratch project's audio, plays the whole episode under both looks and compares the Web Audio schedule with `soundCues()`. All cues land within 0.6 frames.
6. **Evaluation bar (done: `147731b`, `2da3bdf`, `c81ca21` and the portraits commit).** Reference: `media/creator-ref/style-ref-evaluation-bar.png` and the demo clips, measured Oct 12.
   - **Look:** the creator theme's optional `evalBar` block. Black's player is at the top and White's at the bottom; measured at 1080p, the bar's coloured part spanned x 26-67 and y 112-968 (since Oct 13 the portraits sit 3% of the shorter side from the corners and the bar runs between them; see "Vertical clips" above). The label is at the leader's end, unsigned ("1.0", "M4"). The default theme has no bar.
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
     - A sentence over `SUBTITLE_MAX_CHARS` (42, confirmed by the user Oct 13) splits at the most even comma or dash where both halves fit, else at the most even word.
     - A line stays at least 0.8 s unless the next one starts first, and gaps under 0.25 s close.
     - A line under 0.3 s on screen (a mis-timed word) folds into an unfinished line before it.
     - A leading "..." and sound tags are dropped.
   - **Data:** `Project.subtitles` and `ProjectEdit.subtitles` are absent while the lines follow the transcript. `EpisodeProps.subtitles` carries the lines.
   - **Rendering:** `<SubtitleLine>` (`packages/composition/src/Subtitles.tsx`) draws the line at the frame's source time. Themes: creator as measured; the default look has its own (system sans 600, 44 px).
   - **Editor:** a Subtitles tab lists every line, with the live one highlighted. Click a time to show it. Text, start and end are editable, × deletes a line, and "Rebuild from transcript" drops all edits. Every change is undoable and autosaved.
   - `subtitle-checks.mjs` covers: the line during speech and through a hold, the measured look, edit, save, reload, rebuild, undo, delete, and the default look.

### Decisions, Oct 13

- Speaker names stay full names ("Walter White"), not the creator's first names.
- `SUBTITLE_MAX_CHARS` 42 is right as seen in the video.
- `game-start` plays 1 s in.

### Card placement (built Oct 13; assessment first)

The creator places each card by hand per shot, clear of faces (`media/creator-ref` screenshots: mid-left between two men, top-right over a curtain, upper-centre over a door), with the badge on the side toward the action. Ours use the theme's corner, which covered 40-100% of a face on 5 of 13 BB1 and Dexter freeze frames.

- **Spike:** each freeze frame went through macOS Vision (faces, people, saliency; local, about 65 ms) and Gemini 3.5 Flash-Lite (named faces plus the move's subject; about 2.3 s and $0.0007 a frame).
  - **Faces:** both found every visible face. Gemini also found heads seen from behind and tiny distant figures, and named each face.
  - **Subject:** Gemini's single subject box was tight only sometimes (the gun, the raised hands); often it was the whole person or half the frame, so it can only be a soft preference.
- **Placement search:** card plus badge on either side; no-go zones for the bar strip, name corners and the subtitle line; on close-ups only the eyes-to-mouth band is protected. Result: faces fully clear on 8 of 13 frames, eyes and mouth clear on 12 of 13. Close-ups leave no face-free spot for a full card.
- **The user's decisions (Oct 13):**
  - The purpose is not to hide the drama, so eyes and mouths weigh most. On a close-up the card may cover hair, forehead, chin or shoulders, never the eyes-to-mouth band.
  - A retime keeps any position or scale the user set by hand. A card never changed by hand is placed again on the new frame.
  - A "Re-evaluate" button beside the position and scale controls places the card again on demand, replacing a manual position.
- **Built with Gemini 3.5 Flash-Lite at medium resolution** (the user's choice). How it works:
  - **Detection:** Gemini returns each head and a tight eyes-to-mouth box (asked for directly; boxes derived from the head sat too low on close-ups and let a card cover Walt's eyes in testing), plus the move's subject. One call is about $0.0005 and 2 s.
  - **Weights:** any touch of eyes or mouth costs 100 plus 1000 times the share covered, more than the smallest card (85%: 90, 92%: 30), so a card that can clear them by shrinking always does. An 8% margin around them costs 200 times its share, the rest of a head 60, the subject 25. Nothing smaller than 85% is tried, so a covered face beats a tiny card.
  - **Where it runs:** a `place` stage after `snap` (not fatal: on error the drafts keep the theme's corner); `POST /projects/:id/regions` for the editor; `useAutoPlacement()` in the editor re-places `auto` cards after a retime or a new move, folded into that edit's undo step with the store's `amend`; Re-evaluate in the Move tab (beside position and size) places any card again as its own undo step; a new look re-places `auto` cards for its card and badge.
  - **Verified:** on BB1 live (Oct 13), Re-evaluate on all 7 moves cost $0.0039 and every hold keeps both men's eyes and mouths visible (three close-ups at 92%). `placement-checks.mjs` passes, and the card-size estimate is within 1-2% of the drawn card in both looks.
- **Gemini costs (sourced Oct 13 from ai.google.dev pricing, updated Oct 9, 2026, and the spike's logged tokens):**
  - **Rates and image cost:** Gemini 3.5 Flash-Lite costs $0.30 per 1M input tokens and $2.50 per 1M output tokens, including thinking; `prices.ts` already matches. A Gemini 3 image costs up to 1120 tokens by default (`high`) or 560 at `medium`.
  - **Per frame, measured on 13 frames:**
    - Default (`high`): 1274 tokens in and 127 out, so $0.0007 a frame.
    - `medium`: 700 in and 119 out, so $0.0005 a frame. Output is most of the bill.
    - Calls take about 2 s.
  - **Accuracy:** `medium` matched every face Vision found (14/14), and its face boxes agree with `high`'s (median IoU 0.96). Run to run, the boxes agree at a median IoU of 0.98, but one run missed a tiny distant figure.
  - **Per clip:** BB1's 7 cards cost about $0.004 at `medium`, plus $0.0005 for each retime or Re-evaluate. That is about 1-2% of a clip's analysis, which Claude dominates at $0.25-0.40.
  - **Alternatives:**
    - Gemini 2.5 Flash-Lite ($0.10/$0.40, about $0.0002 a frame) is untested for this.
    - Gemini 3.8 Flash ($0.75/$3.75, doubling on Jan 1, 2027) costs about 2-3 times as much.
    - The Batch API halves prices but can take hours, which is no use for Re-evaluate.

### Phase 5: export (done, Oct 13)

- **Render menu** in the editor header (beside History): pick a size (Source, plus 1080p or 4K where the clip scales evenly to it), then press Render MP4. The editor saves first and renders that saved version (`POST /projects/:id/renders` with `version`; 409 if a newer save exists). The header button shows "Rendering N%"; the menu shows the stage, a progress bar and Cancel. A toast announces the result. Finished renders have Play (opens the MP4 in a tab), Show in Finder (`open -R`) and Delete.
- **Server:** `RenderService` (`apps/server/src/render/renders.ts`) runs one render per project through a `JobQueue`. A server restart marks interrupted renders failed (`recover()`). On start it opens the browser and bundles in the background (`warmUp()`). Chrome Headless Shell (about 170 MB) downloads on first use into `apps/server/node_modules/.remotion`.
- **Speed:** BB1 (2:28 source, 3:38 output, 5230 frames at 1080p) renders in about 2 minutes, 76 MB. The sample renders in about 14 s.
- **Verified on BB1:**
  - The MP4 has every output frame, at exactly 24000/1001.
  - Cards, badges, the eval bar with portraits, and subtitles all draw as in the Player.
  - Audio: the source is silent during holds. The move sound lands at about 0.27 s into the freeze, typing runs under the type-out, and the reread is silent.
- **Render test** (`render.test.ts`): renders two moments of the 10 s sample. It checks the length (source plus holds, within one frame, and the exact frame count), the freeze, and silence in holds against a tone between them.
  - **Freeze tolerance:** identical frames do not always decode bit for bit from H.264 (rounding moves a few values by up to 4), so "two frames in each hold are the same" allows 8 levels instead of comparing hashes. A control requires play frames 5 apart to differ by more than 50.
- **Preview match** (`render-checks.mjs`): renders from the menu, then compares three holds' reread frames in the MP4 with the Player's frames.
  - **Measure:** PSNR after an RGB conversion and a 1.5 px blur, because the Player draws text at page scale from the 720p proxy.
  - **Measured:** BB1 scores 34 dB, the synthetic sample 29-31 dB, and the no-card controls 14-22 dB. The check requires at least 27 dB and 8 dB over the control.
- **Not built (PLAN "later"):** overlay-only alpha export and an edit list.

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
- **The Anthropic balance is empty** (the Analyst now runs on OpenAI, above). Before that, Claude Code wrote the Claude answers by hand through `ANALYST_HANDOFF_DIR` (`handoffAnalyst` in `providers/replay.ts`). The pipeline writes `request-<call>.json` and waits; a `claude-<call>.json` (`{"output": …}`) is then validated like a live answer and labelled `hand-written/claude-code-session` at $0. To redo only Pass B on BB1:
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
2. Run the browser checks against `PROJECTS_DIR=<scratch> pnpm dev` with freshly seeded samples (`pnpm seed:sample`; each check edits its project, so seed one per check). `phase2-checks` needs the output frame count, currently 1143 for the sample under the default theme. `sound-checks` and `render-checks` also take the projects folder (`render-checks` reads the MP4 from it; `--reuse` compares the newest render without making another). `placement-checks` needs the dev server started with `ANALYSIS_REPLAY_DIR=$PWD/fixtures/dialogue/recorded`, so Gemini is replayed.
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
- Remotion downloads its browser under the nearest `package.json` above the working directory. The server runs from `apps/server`, so the render test changes into that folder too and shares one copy (each copy is about 580 MB).
- The renderer's browser loads media from this server at another origin. It runs with `disableWebSecurity` rather than the server sending CORS headers, which any web page could then use.
- When comparing a Player screenshot with an MP4 frame in ffmpeg, force both to `rgb24` (a PNG and an MP4 frame otherwise convert differently) and close any menu over the stage first.
- A server restart under `pnpm dev` could leave a page's `/api/events` stream silent for good behind Vite's proxy, so the Render menu sat at "Rendering 0%" while renders ran and finished (Oct 13, the Private Property project). Now the server pings on connect and every 5 s, the client reopens a stream that is silent for 12 s or closed after a 502 (and the Render menu and project list refetch on reconnect), and the Vite proxy closes the browser's side when the server's side closes. A render's progress is never written to `renders.json`, so a cancelled render always reads 0% there.
- The editor is now taller than a 1150-1300 px window, so the page can show a scrollbar. Measure a container and its children in the same pass.
