# Analysed Like Chess Studio — Build Plan

Oct 10, 2026 · @Noah

## Context and v1 scope

v1 is a single-user local web app. It takes a movie scene clip, drafts chess-style move annotations with cloud AI, lets the creator edit them over live playback, and renders a finished MP4 with freeze-frames burned in.

The tool is built to pitch to the Analysed Like Chess creator. Two things follow from that. First, output must match their existing format closely enough that an episode made with it is indistinguishable from one made by hand. Second, the drafts have to sound like them, not like a generic model.

**In scope for v1**

- Upload a clip (MP4, MOV, MKV) and make a browser-safe playback proxy
- Cloud analysis that drafts timestamped moments with classification, breakdown and best move
- Player with the overlay drawn over the video and colour-coded moment markers on the timeline
- Editing of every field, timing and overlay position while the video plays or sits paused on a freeze
- One-click render to MP4 that matches the preview frame for frame

**Out of scope for v1**

- Voiceover or text-to-speech
- Full-length films (clips only)
- Accounts, auth, billing, multi-user
- Uploading to YouTube
- Local AI models (all AI calls go to cloud APIs; ffmpeg and rendering run locally)

**Working assumptions** (correct any of these before Phase 4)

- Clips run up to about 10 minutes
- Explanations are on-screen text only
- The AI proposes moments and the creator curates them
- Dialogue is mostly English

## Architecture

Every project has one annotation track, a JSON list of moments. The analysis pipeline writes it, the editor changes it, and the player and renderer only read it. Because preview and export draw from the same data with the same code, what the creator approves is exactly what renders.

&#91;embedded content: system architecture · 4 pipeline stages, 1 track, 3 consumers\]

Analysis runs left to right once per clip. After that, only the editor writes to the track; the player and the renderer read the same data.

**Core decisions**

- **One Remotion composition, used twice.** `@remotion/player` runs it in the browser for preview and editing; `@remotion/renderer` runs it on the local server to produce the MP4. The move card is a React component whose only inputs are the moment, the theme and an animation progress value.
- **Freeze-frames are a pure time-mapping function** shared by player and renderer (see Player, overlay and timeline).
- **A local Node server owns the heavy parts:** files, ffmpeg, API keys, the job queue and rendering. The browser never sees an API key.
- **AI providers sit behind three interfaces** (`Transcriber`, `SceneDescriber`, `Analyst`), so a model or vendor can be swapped without touching the rest.

**Stack**

| Layer | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript across all packages | One schema shared by web, server and composition |
| Web app | Vite, React, Tailwind | Remotion is React; fast local dev |
| Server | Node (current LTS) with Hono | Upload, ffmpeg, jobs, progress over SSE, render |
| Schemas | Zod | Types, request validation and the JSON Schema sent to the Analyst all come from one source |
| Media | ffmpeg and ffprobe (system install) | Probe, proxy, audio extract, frame grabs, cut detection |
| Preview and render | Remotion Player and Renderer | Same component in both places |
| Editor state | Zustand with an undo middleware | Simple store, undo and redo for free |
| Storage | One folder per project, `project.json` plus media | Inspectable and diffable; no database in v1 |

**Repo layout**

```
als-studio/
  apps/
    web/           editor UI (Vite + React)
    server/        Hono API, jobs, ffmpeg, AI adapters, render
  packages/
    schema/        Zod schemas, derived types, JSON Schema export
    composition/   Remotion: <Episode>, <MoveCard>, timeMap()
    theme/         classification tokens, badge SVGs, theme presets
  projects/        runtime data, gitignored
    <id>/          source.*, proxy.mp4, audio.wav, frames/,
                   project.json, renders/
  CLAUDE.md
  PLAN.md
```

## Data model

All times are stored in source-clip seconds; frames are always derived, never stored. `moments` is the annotation track and the only part the editor changes after analysis. Define these in `packages/schema` with Zod and export the types from there.

```ts
type Classification =
  | 'brilliant' | 'great' | 'best' | 'excellent' | 'good' | 'book'
  | 'inaccuracy' | 'mistake' | 'miss' | 'blunder';

interface Project {
  id: string;
  version: number;              // +1 on every save, used for conflict checks
  source: {
    file: string; proxy: string;
    fps: number; durationSec: number;
    width: number; height: number; hasAudio: boolean;
  };
  context: {                     // optional, typed by the creator at upload
    movieTitle?: string;
    sceneNote?: string;          // e.g. "Heist planning scene, act 2"
    characters: Character[];
  };
  transcript?: { words: Word[]; utterances: Utterance[] };
  shots?: Shot[];                // cut boundaries
  sceneNotes?: SceneNote[];      // timestamped visual descriptions
  moments: Moment[];             // THE annotation track, sorted by sourceTime
  themeId: string;
  analysis: {
    status: 'idle' | 'running' | 'done' | 'error';
    stages: { name: string; status: string; error?: string }[];
    models: Record<string, string>;   // which model produced what
  };
}

interface Character { id: string; name: string; speakerLabels: string[] }
interface Word { i: number; text: string; start: number; end: number; speaker: string }
interface Utterance {
  id: string; speaker: string; start: number; end: number;
  text: string; wordRange: [number, number];
}
interface Shot { start: number; end: number }
interface SceneNote { start: number; end: number; text: string }

interface Moment {
  id: string;
  sourceTime: number;            // where the video freezes
  holdSec: number;               // freeze length in the output
  actorId?: string;              // Character who made the move
  classification: Classification;
  moveLabel: string;             // what they did, short
  explanation: string;           // why it earned this rating
  bestMove?: string;             // omitted for best and brilliant
  card: {
    anchor: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'custom';
    x?: number; y?: number;      // 0-1 of frame size, only for custom
    scale: number;
  };
  evidence: { utteranceIds: string[]; note?: string };  // why the AI chose this time
  origin: 'ai' | 'user';
  status: 'draft' | 'approved';
  confidence?: number;           // 0-1, from the Analyst
}
```

**Rules the schema enforces**

- Moments sit at least 0.5 s apart in source time and never inside another moment's hold.
- Text has character caps so a card is readable during its hold. Start with `moveLabel` 40, `explanation` 220 and `bestMove` 160, then tune them against the creator's real videos.
- `holdSec` follows the card's text: card-in time, plus the explanation typing out word by word (5.5 words a second, each word fading in over 0.12 s), plus 4 s with the finished card, plus card-out time, all measured on the creator's videos. The rates live in the theme. A hold the creator sets by hand is locked (`holdLocked`) and stops following the text until reset; if it is too short for the type-out, the text types faster so it is complete before the card leaves. *(Decided Oct 12, 2026, replacing 34 characters a second plus 1 s from Oct 10.)*

## Analysis pipeline

Analysis is a staged job with three kinds of work. Cheap local media prep runs first. Two cloud perception calls then run in parallel: speech and visuals. Last, a cloud reasoning model writes the moves, and a deterministic snapping step places them on exact frames. Each stage writes its output into the project folder and is skipped on re-run when its inputs are unchanged, so tweaking the Analyst never re-pays for transcription.

**Stage 1: Ingest (local, ffmpeg)**

1. `ffprobe` the upload to get fps, duration, size and audio presence.
2. Make `proxy.mp4` (H.264 and AAC, a keyframe every second) so the browser can scrub smoothly. The renderer reads the original file.
3. Extract `audio.wav` as mono 16 kHz for the Transcriber.
4. Detect cuts with ffmpeg's scene filter and store them as `shots`. Grab one thumbnail per shot for the timeline filmstrip.

**Stage 2: Perception (cloud, run in parallel)**

1. **Transcriber.** Use any speech-to-text API that returns word-level timestamps and speaker diarization. Wrap it in an adapter and verify both features before choosing a vendor. Output: `words` and `utterances` with speaker labels.
2. **SceneDescriber.** Use a Gemini model with native video input, which reads both the frames and the audio track and can cite timestamps ([Google docs](https://ai.google.dev/gemini-api/docs/interactions/video-understanding?hl=zh-cn)). Upload the proxy and ask for JSON scene notes: who is on screen, actions, reactions, reveals and objects that matter. Gemini's timestamps are coarse; File API uploads have historically been sampled at 1 frame per second ([mirror of the docs](https://hex.pm/packages/ex_llm/0.7.1/files/docs/gemini/GEMINI-DOCS-18-VIDEO-UNDERSTANDING.md)). Use scene notes for understanding, never for freeze placement.
3. **Speaker naming.** One cheap call maps diarization labels (A, B, C) to character names, using the transcript, the scene notes and any characters the creator typed at upload. The creator can correct this in the UI before running the Analyst.

**Stage 3: Analyst (cloud, Claude with structured outputs)**

The Analyst gets one merged, time-ordered text timeline: utterances with ids and speaker names, scene notes, and shot boundaries. Use Claude's JSON outputs (`output_config.format` with `type: "json_schema"`) so every response matches the Zod-derived schema ([Claude docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)).

1. **Pass A: decision points.** Find every moment where a character makes a choice with real alternatives. Over-generate on purpose, roughly twice the target count. Each candidate carries the actor, what they did, the evidence utterance ids, and the alternatives that were open to them.
2. **Pass B: annotate.** Pick the final set at the target density (default one move per 20 s, set per project). Rate each move and write `moveLabel`, `explanation` and `bestMove` in the creator's voice. Pass B also runs alone for a single candidate, which is how per-moment Regenerate works in the editor.

**Classification rubric** (goes in the Pass B system prompt; tune with the creator)

| Rating | Use it when the character… |
| --- | --- |
| Brilliant | makes a non-obvious, risky sacrifice or gambit that pays off |
| Great | finds the only good move in a tough spot |
| Best | plays the clearly optimal move |
| Excellent | plays a near-optimal move |
| Good | makes a solid, reasonable choice |
| Book | does the textbook genre move everyone makes in this situation |
| Inaccuracy | picks something slightly worse than what was available |
| Mistake | picks something clearly worse while a better option was open |
| Miss | fails to seize an opportunity that was right there |
| Blunder | makes a move that loses: gets caught, killed, dumped or exposed |

Pass B prompt rules:

- `bestMove` must be something the character could plausibly do with what they knew at that moment, unless hindsight is the joke.
- Mix the ratings across the scene's arc instead of making every move a blunder.
- Stay under the text caps from the Data model section.

**Style corpus (the pitch's real differentiator)**

Store 20 to 40 of the creator's real breakdowns in `style/examples.json`, each with its rating, label, explanation, best move and a one-line scene context. Pass B gets them as few-shot examples, plus a short voice guide (humour, sentence length, recurring phrasings). For the pitch, build the corpus from the creator's published videos. Once they are a client, they supply it and can edit it in the app.

**Stage 4: Snap (local, deterministic)**

1. For a spoken move, freeze 0.15 s after the last word of the evidence utterance, on a frame in the same shot as that last word: if the padding would cross a cut, freeze on the shot's last clean frame instead (`freezeAfterSpeech` in `packages/schema`). For a visual move, freeze at the scene-note time and refine it with the shot boundaries.
2. Never freeze within 2 frames of a cut, because a frozen transition frame looks broken. Push the freeze to the nearest clean frame.
3. Enforce the spacing rules from the Data model section and save the moments as `origin: 'ai'`, `status: 'draft'`.

**Model configuration** (in `.env`; Claude Code must verify current model IDs in the docs before coding)

```
TRANSCRIBER_PROVIDER=        # chosen after verifying word timestamps + diarization
SCENE_MODEL=                 # current Gemini model with video input
ANALYST_MODEL=claude-opus-5-5      # Pass A and full Pass B
REGEN_MODEL=claude-sonnet-5-5      # single-moment regenerate, faster
```

Log tokens, latency and model per stage into `project.analysis`, so per-clip cost is known before pricing the pitch.

## Player, overlay and timeline

The output video is the source clip with a hold inserted at every moment. Output duration is source duration plus the sum of all holds. One pure function in `packages/composition` defines that mapping, and the player, the timeline and the renderer all call it.

```ts
// segments: play [0, t1] · hold t1 for h1 · play [t1, t2] · hold t2 for h2 · … · play [tn, end]
timeMap(outSec, moments) => {
  sourceSec: number;
  hold?: { momentId: string; progress: number };   // progress runs 0 to 1 across the hold
}
sourceToOut(sourceSec, moments) => number;          // places markers, handles seeking
outDuration(sourceDuration, moments) => number;
```

**Composition** (`<Episode>`)

- Play segments render the video trimmed to their source range.
- Hold segments wrap the video in Remotion's `<Freeze>` at the moment's frame and draw `<MoveCard>` over it. If seeking inside the Player proves unreliable during the Phase 2 spike, fall back to a still extracted with ffmpeg at the exact frame (re-extracted whenever a moment is retimed).
- Source audio stops during a hold, because source time is not advancing. The theme can add an optional sting sound when the card appears.
- Burned-in subtitles (format iteration 7) follow source time, so the line spoken before a freeze stays up through the hold. They are built from the transcript and editable in the Subtitles tab; the theme's `subtitles` block sets the look.
- Chess sounds (format iteration 5) are shared by every theme: `soundCues()` places game start/end, the ten-second warning, a move sound on the badge and typing under the type-out. The files are the user's, local in `media/sounds` and never committed; `EpisodeProps.sounds` carries their URLs and lengths.
- The card animates from hold progress only, for example in over 0.25 s and out over 0.2 s, so the preview and the render stay identical.
- The composition must stay pure: no editor state, no network, no clocks. Everything comes in through props.

**Playback modes**

- **Review** (default while editing): playback pauses at the start of each hold, so the creator can read and edit the card, then continue.
- **Preview**: plays straight through exactly as the MP4 will, holds included.

**Timeline** (custom, under the Player; the Player's built-in controls are off)

- The axis is output time, so the creator sees the length they will export.
- Each hold is a block filled with its classification colour, as wide as its hold. A badge sits on top, the label shows on hover, and a click seeks there and pauses.
- Dragging a block retimes the moment. It snaps to word ends and away from cuts; holding Shift turns snapping off.
- Context lanes sit under the main track: a filmstrip with one thumbnail per shot, and transcript bars coloured by speaker.
- Draft moments are drawn hatched, approved moments solid, so progress is visible at a glance.

**Keyboard**

| Key | Action |
| --- | --- |
| Space | Play or pause |
| J, K, L | Back, pause, forward |
| N, P | Next or previous moment |
| M | Add a moment at the playhead |
| 1 to 0 | Set classification (Brilliant to Blunder) |
| A | Approve the current moment |
| Delete | Remove the current moment |
| Ctrl+Z, Ctrl+Shift+Z | Undo, redo |

## Editor

Edits happen on the video itself. When playback sits on a hold, an edit layer appears exactly over the rendered card and every field becomes editable in place. The Player re-renders from the changed props on the next frame, so there is no separate preview step.

**Edit layer over the Player**

- It is a plain DOM layer above the Player, not part of the composition. A shared `cardRect(moment, frameSize, theme)` function places it, so it lines up with the card the composition draws.
- Text fields are edited inline. Clicking the badge opens a classification picker showing all ten ratings with their icons.
- Dragging the card moves it (anchor becomes `custom`), and a corner handle sets its scale.
- Live character counters show against the caps. Going over warns but does not block.

**Panels**

- **Moments list** (left): every moment in order with badge, label and status. Filter by draft or approved, with bulk approve.
- **Inspector** (right): every field of the selected moment, including actor, hold length and confidence. It also shows the evidence transcript lines; click one to seek to it.
- **Transcript** (bottom drawer): click a line to seek. Selecting words and choosing "Make this a move" creates a moment there and runs Pass B on it.
- **Characters**: rename, merge and reassign speaker labels. Speaker names flow through to every card.

**Regenerate**

Each moment has a Regenerate button with an optional instruction box ("funnier", "rate it a blunder instead", "shorter"). It runs Pass B for that one moment with `REGEN_MODEL` and shows the result next to the current text. The creator accepts or discards it, and nothing is overwritten silently.

**State and saving**

- Every edit is a patch in a Zustand store with undo and redo.
- Autosave sends the project with its `version` 500 ms after the last edit. The server answers 409 if the version is stale, and the app reloads instead of overwriting.
- The server keeps the last 20 saved versions on disk, so a bad edit or a bad AI run is always recoverable.
- The render button warns when drafts remain, but still allows the render.

## Export

Rendering runs the same `<Episode>` composition through `@remotion/renderer` on the local server and writes an H.264 MP4 into the project's `renders/` folder. Because the render and the preview share the composition and `timeMap()`, there is nothing to convert.

**Render job**

1. Bundle the composition once at server start with `@remotion/bundler`, and rebundle only in dev when files change.
2. When the creator clicks Render, freeze a snapshot of `project.json`. Edits made during a render then cannot change the output.
3. Call `selectComposition` and `renderMedia` with the snapshot as input props. Serve the original source file to the renderer over the local server's HTTP.
4. Stream progress to the browser over SSE, then show the finished file with an Open folder button.

**Output defaults** (set per project)

- Resolution and fps match the source, with 1080p and 4K presets. Built Oct 13: the size is chosen per render in the Render menu, which defaults to the project's last one.
- H.264 video and AAC audio at a quality-first CRF, ready for YouTube.
- During holds the source audio is silent, apart from the chess sounds and the theme's optional sting.

**Render test** (automated, part of Phase 5)

- Render a 10-second fixture with two moments.
- Use `ffprobe` to check that output duration equals source duration plus both holds, within one frame.
- Compare two frames inside each hold and confirm they are identical, which proves the freeze is real. Built Oct 13: H.264 does not decode identical frames bit for bit, so they must match within 8 of 255 levels, with a control showing play frames differ.

**Later, not v1**

An overlay-only export with an alpha channel, plus an edit list for the freezes, so the creator can drop the cards into their own Premiere or Resolve timeline. This depends on how they finish videos today; ask them during the pitch.

## Theming and icon set

All visual choices live in a theme JSON in `packages/theme`, never hard-coded in components. That lets the pitch build ship in the creator's exact look while the default theme stays the app's own.

**Default badge set**

Ship original SVG badges built on the standard chess annotation glyphs, which no one owns. Do not copy Chess.com's badge artwork, exact colours or sound effects into the repo. (The sound files are the user's own, kept local and gitignored like the demo footage.) The icon pack is swappable, so the creator can load whatever assets they already use in their videos.

| Classification | Glyph | Colour family |
| --- | --- | --- |
| Brilliant | !! | Teal |
| Great | ! | Pale blue |
| Best | Star | Green |
| Excellent | Thumbs up | Green, lighter |
| Good | Check | Muted green |
| Book | Open book | Tan |
| Inaccuracy | ?! | Yellow |
| Mistake | ? | Orange |
| Miss | X | Coral |
| Blunder | ?? | Red |

**What a theme controls**

- Per classification: display name, badge asset and colour token
- Card: font family and sizes, background, corner radius, padding, max width, line clamp
- Layout defaults: anchor corner, scale, safe margins (keep cards clear of YouTube's player controls)
- Freeze treatment: none, slight dim, or slow push-in on the frozen frame (default theme: 10% dim, decided Oct 12, 2026, replacing none)
- Timing: default hold, card in and out durations, optional sting sound

**Card placement** (built Oct 13, 2026)

The creator places each card by hand, clear of faces. Drafts do the same: Gemini finds every head and its eyes-to-mouth box on the frozen frame, and `autoPlaceCard()` (`packages/composition/src/placement.ts`) searches the safe area, clear of the evaluation bar, its players and the subtitles. The order of what matters, the user's: eyes and mouths stay visible; then a slightly smaller card (92%, then 85%, never smaller); then the rest of a face; then the move's subject. A covered face beats a tiny card. Cards set by hand keep their position and size through retimes; automatic ones are placed again on the new frame; Re-evaluate places any card again.

**Matching the creator**

Built early, Oct 12, 2026, from four screenshots and five clips (`media/creator-ref/`): the `creator` theme matches their card layout ("<Move> is <phrase>", a move-number line with the annotation symbol, the breakdown typing out, "Better was", a motif chip), the round badge beside the card, Arial, measured sizes and four sampled rating colours, and their hold timing. The other six rating colours are placeholders until a video with those ratings is sampled. A theme editor screen with live preview would make later tweaks fast for them.

## Running costs and top-ups

Estimates from list prices in `analysis/prices.ts` for one 3-minute clip, until Phase 4's real run replaces them with logged numbers. Each stage's cost shows in the project's Analysis tab.

| Service | What it does | Per 3-min clip | Per Regenerate | Suggested top-up |
| --- | --- | --- | --- | --- |
| ElevenLabs (Scribe v2) | Transcript, speakers | about $0.012 ($0.22 per hour, plus 20% for character-name key terms) | none | Nothing separate: it draws on the account's plan credits. A 30 s test cost $0.002 |
| Gemini (3.5 Flash-Lite) | Scene notes from video | about $0.02 | none | $5 prepay covers about 200 clips. Prepay credits at zero return a 402 and stop analysis |
| Gemini (3.5 Flash-Lite, medium image resolution) | Faces and the move's subject on each frozen frame, for card placement | about $0.004 (BB1's 7 cards: $0.0039, measured Oct 13) | about $0.0005 per retime or Re-evaluate; frames already looked at are free | Shares the scene-notes prepay |
| Anthropic (Opus 5.5 Analyst, Haiku 5.5 naming) | Pass A, Pass B, speaker naming | about $0.25 to $0.40 | about $0.01 (Sonnet 5.5) | $10 covers about 30 clips of testing |

Rule of thumb: a clip costs under half a dollar all in, and Claude is nine tenths of it. Re-running only the Analyst costs the Claude share again and nothing else. Pitch prep (two demo episodes plus tuning the style corpus, about 30 runs) fits inside $15 of Anthropic and $5 of Gemini.

## Build phases

Build the editor on a hand-written fixture before any AI exists, so the hardest UX problem (editing over a frozen frame) is solved on stable data. Each phase ends only when its checks pass.

**Phase 0: Scaffold**

Set up the pnpm monorepo from the Architecture section, `packages/schema` with Zod, a fixture `project.json` with 3 hand-written moments on a short sample clip, `CLAUDE.md`, lint and Vitest.

- [ ] `pnpm dev` starts web and server together
- [ ] Fixture validates against the schema; schema unit tests pass

**Phase 1: Ingest**

Upload, probe, proxy, audio extract, cut detection, shot thumbnails and a projects list page.

- [ ] A 3-minute MKV upload becomes a project whose proxy plays and scrubs smoothly in the browser
- [ ] Shots and thumbnails appear; re-running ingest on the same file is a no-op

**Phase 2: Player, overlay and timeline** (fixture data, no AI)

Build `timeMap()`, `<Episode>`, `<MoveCard>`, the default theme, the custom timeline and both playback modes. Spike `<Freeze>` against an extracted still on day one of this phase.

- [ ] `timeMap` unit tests cover zero moments, a moment at 0 s, one at the last frame, adjacent moments, and round-trips with `sourceToOut`
- [ ] Review mode pauses at every hold; Preview plays straight through
- [ ] Timeline blocks line up with holds to within one frame

**Phase 3: Editor**

Build the edit layer, panels, add, delete and retime, undo and redo, autosave and version history.

- [ ] Text typed during a hold shows in the card on the next frame
- [ ] Dragging a block retimes it, with snapping on and Shift turning it off
- [ ] Undo restores the previous state; a reload keeps every edit; a stale save gets a 409 and reloads

**Phase 4: Analysis**

Build the provider adapters, all four stages with caching, progress over SSE, the speaker naming screen, Pass A and B, snapping, and Regenerate.

- [ ] A 3-minute clip goes from upload to editable drafts with no manual steps
- [ ] Every moment's evidence ids exist in the transcript
- [ ] No freeze lands within 2 frames of a cut
- [ ] Re-running the Analyst skips Stages 1 and 2
- [ ] Tokens and cost per stage show in the project

**Phase 5: Export**

Build the render job, progress and the render test.

- [ ] The automated render test passes
- [ ] Three spot-checked holds in the MP4 match the preview

**Phase 6: Pitch build**

Build the style corpus, the `creator` theme and two demo episodes (see Pitch strategy).

- [ ] Both demos render in the creator's look
- [ ] Upload to render takes under 30 minutes including review, timed end to end

## Pitch strategy, open decisions and risks

The pitch should show the tool doing the creator's job in their voice, not tell them about AI. Bring two demos: one that proves it understands their format, and one finished video they could post.

**Pitch strategy**

1. **Parity demo.** Run a scene the creator has already published and put the tool's drafts next to their real breakdown. Matching moments show the AI finds what they find, and the editor shows how fast the rest gets fixed.
2. **Gift demo.** A scene they have not covered yet, delivered as a finished MP4 in their look. A concrete, postable video lands harder than any feature list.
3. **Frame it as control.** Lead with time saved per episode and the fact that the AI drafts while they decide. Creators guard their voice, so "it writes your videos" loses the room.

**Open decisions**

| Decision | Default until decided | Decide by |
| --- | --- | --- |
| Transcription vendor | Chosen after verifying word timestamps and diarization | Start of Phase 4 |
| How the creator finishes videos | Finished MP4 straight from the app | The pitch |
| Voiceover | Not supported | The pitch |
| Whose machine and API keys | Runs on the creator's machine with their own keys | Before handover |
| Pricing | Undecided: one-off build fee or monthly | After per-clip cost is known from Phase 4 logs |
| Text caps and hold length | Values in the Data model section | Phase 6 |

**Risks**

| Risk | Mitigation |
| --- | --- |
| Draft quality is the product; flat or wrong ratings sink the pitch | Style corpus, over-generation in Pass A, Regenerate with instructions. Track how much of each AI draft the creator keeps as the quality metric |
| Diarization struggles with film audio (music, overlaps, effects) | Speaker naming screen before the Analyst runs; scene notes cross-check who is on screen |
| `<Freeze>` seeking is unreliable in the Player | Day-one spike in Phase 2; extracted-still fallback |
| Gemini timestamps are too coarse for freezes | Stage 4 snaps to word ends and shot boundaries |
| Remotion licensing | Free for individuals and for-profit teams of up to 3, but collaborators' headcounts combine and the licence falls on whoever owns the output ([Remotion licence FAQ](https://www.remotion.dev/docs/license/faq), [pricing](https://www.remotion.dev/docs/pricing)). You plus a solo creator should qualify; re-check before selling to anyone larger |
| Footage rights | The tool only processes clips the creator already uses, so their current practice is unchanged. Check each AI provider's terms on uploaded media |

## Working rules for Claude Code

Copy the rules below into `CLAUDE.md`.

1. Build one phase at a time. Do not start a phase until the previous phase's checks pass, and stop to report at the end of each phase.
2. Before writing any call to Remotion, the Claude API, Gemini or the speech-to-text vendor, read that SDK's current docs. Never write API calls from memory. Pin exact dependency versions.
3. `packages/schema` is the only source of types. Never hand-write a type that duplicates a Zod schema.
4. `packages/composition` stays pure: no imports from `apps/`, no network, no clocks, no editor state.
5. Tests never call cloud APIs. Record one real response per provider into `fixtures/` and replay it.
6. API keys live only in the server's `.env`, which is gitignored. Nothing secret reaches the browser.
7. Ask before adding a dependency that is not in the Stack table.
8. Where the creator's format is unknown (exact card look, text length, hold timing), leave a `TODO(open-decision)` comment rather than guessing.
9. Commit after each working step with a message that says what now works.

## Sources

- [Claude API: structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Gemini API: video understanding](https://ai.google.dev/gemini-api/docs/interactions/video-understanding?hl=zh-cn)
- [Gemini video docs mirror (File API sampling)](https://hex.pm/packages/ex_llm/0.7.1/files/docs/gemini/GEMINI-DOCS-18-VIDEO-UNDERSTANDING.md)
- [Remotion licence FAQ](https://www.remotion.dev/docs/license/faq)
- [Remotion pricing](https://www.remotion.dev/docs/pricing)
