# iPhone trial: the Player in a Capacitor shell

Nov 5, 2026 · for a fresh Claude Code session

A throwaway iPhone app that answers one question before C5 (`PLAN-CLOUD.md`, Phase C5): does the editor's Player, unchanged, work inside an iPhone's web view? It plays the sample episode exactly as the editor would, measures itself, and shows a report. Nothing here ships. Read `CLAUDE.md` (Status, Conventions, Lessons) and this file; nothing else from earlier sessions is needed.

**Target device:** the user's iPhone 12 on iOS 26.6.1 (iOS 26 supports the iPhone 11 and later). **This Mac (checked Nov 5):** Xcode 26.6, Node 24.12, iOS 26 simulators, 35 GiB free, no CocoaPods.

## What the trial must answer

Each answer is a PASS or FAIL line in the report, worded like the browser checks (`scripts/browser/*-checks.mjs`).

1. **Which decoding path runs.** `<Episode>` uses `@remotion/media` `<Video>` and `<Audio>`, built on Mediabunny and WebCodecs. When it can't decode, `<Video>` falls back to `<OffthreadVideo>` (a plain `<video>` element in the Player) and `<Audio>` to `<Html5Audio>`. Report `typeof VideoDecoder`, `typeof AudioDecoder`, and which path drew the frames (a `<canvas>` or a `<video>` inside `.__remotion-player`). Either path is an answer; a fallback changes what C5 has to test.
2. **Inline playback.** The video plays in the page, never full screen.
3. **Frame-exact holds.** Each hold shows one frozen image for its whole length, and that image is the source frame `buildTimeline()` says (`packages/composition/src/timeline.ts`). Same idea as phase2-checks 5 ("1 distinct image") and its frame comparison.
4. **Sound after a tap.** After one tap on Play, every cue in `soundCues()` (`packages/composition/src/sounds.ts`) starts, and within 2 frames of its frame (the Mac measures 0.5-0.6 frames; see sound-checks). Also after a pause and resume, and after a seek.
5. **Smooth enough.** Dropped frames over the episode (Player frame jumps of more than 1, and animation-frame gaps over 2 frame lengths), as a count and a share.
6. **The game review and the shipped font** draw (the creator look has a 5 s review after the last frame; the composition ships Arimo).

## Ground rules

- **Throwaway:** everything lives in `spikes/capacitor-trial/`. ESLint ignores `spikes/`; no tests. Keep it small.
- **Never commit media.** The sample clip (`fixtures/sample/source.mp4`) is rights-free and already in the repo, but the copy the app bundles is a build output. The chess sounds (`media/sounds/`) are the user's files and must never be committed. A `.gitignore` here covers `public/media/`, `public/sounds/`, `dist/`, `ios/App/App/public/` and Xcode's build folders.
- **Dependencies:** Capacitor is approved (`PLAN-CLOUD.md`, decision 4). Pin exact versions (`save-exact`): `@capacitor/core`, `@capacitor/cli`, `@capacitor/ios`, all 8.6.0 on Nov 5 (run `npm view @capacitor/core version` again first). Nothing else new: Vite, React and Remotion are already in the repo at pinned versions; reuse them. Ask before adding anything else (working rule 7).
- **Docs first (working rule 2):** before writing Capacitor config or native settings, read the current docs: capacitorjs.com/docs/ios, /docs/config, /docs/getting-started/environment-setup. Before touching Player props, read remotion.dev/docs/player and remotion.dev/docs/media/video. Don't write from memory.
- **Don't change the product.** No edits to `packages/composition`, `schema`, `theme` or `editor-core` for the trial. If the trial needs a change there to work, that is a finding: record it, don't make it.

## Build

1. **Workspace.** Add `spikes/capacitor-trial` to `pnpm-workspace.yaml` (temporarily; note it in the commit) so it can depend on `@als/composition`, `@als/schema`, `@als/theme` and `@als/editor-core` with `workspace:*`. Give it no `typecheck` script, so `pnpm -r typecheck` skips it. `vitest.config.ts` only includes `packages/` and `apps/`, so its files aren't picked up as tests.
2. **Web app** (Vite + React, the versions `apps/web` uses):
   - `src/main.tsx` renders one `<Player>` (`@remotion/player`, `component={Episode}`) at the phone's width, a large **Tap to play** button (the user gesture), Pause and Restart buttons, and the report below.
   - **Props:** load `fixtures/sample/project.json` (it is on the `default` look). Move it onto the project look the way the editor does: `adoptProjectLook()` from `@als/editor-core`, then `normalize()` with `getTheme(PROJECT_THEME_ID)` so unlocked holds take the creator timing. Build props with `episodeProps()` (`packages/schema/src/episode.ts`), passing `src` = the bundled clip, `fileUrl`, the theme, and the sound bank. Timeline length: `buildTimeline(moments, fps, durationSec, gameReviewSec(theme))` (1320 frames at 30 fps for the sample, as phase2-checks uses).
   - **Media:** a `prepare.mjs` script (run by `pnpm prepare:trial`) copies `fixtures/sample/source.mp4` to `public/media/source.mp4`, copies `media/sounds/*` (honouring `SOUNDS_DIR`) to `public/sounds/`, and writes `public/sounds/bank.json` with each file's length from `ffprobe` (as `SoundLibrary` does in `apps/server/src/media/sounds.ts`). The app loads them by relative URL, so they come from the app bundle (`capacitor://localhost/...`): same origin, no network, no CORS.
   - **Fonts:** come with `@als/composition` (Arimo); nothing to do. Check the report line for the font.
3. **Measurements** (run in the page, written to the report and to `console.log` as one JSON):
   - **Environment:** user agent, `devicePixelRatio`, `typeof VideoDecoder/AudioDecoder/AudioContext`, the decoding path, and `canPlayType('video/mp4; codecs="avc1.640028"')`.
   - **Frames:** on every animation frame while playing, record the Player's frame (`playerRef.getCurrentFrame()`) and a pixel hash of the video layer: draw the player's `<canvas>` or `<video>` into a 32×18 offscreen canvas (same origin, so readable) and hash the bytes. Per hold: distinct hashes (expect 1). For the freeze frame: before playing, seek to the last play frame before each hold, hash it, and compare with the hold's hash. Hide the card layer while hashing, or hash a region the card doesn't cover (the sample's cards sit top-left on the default look; on the creator look check `moment.card`).
   - **Sounds:** before the Player mounts, wrap `AudioBufferSourceNode.prototype.start` (and `HTMLMediaElement.prototype.play`, in case audio falls back) to log each start with the Player's frame at that moment, as `scripts/browser/sound-checks.mjs` does. Compare against `soundCues()` for the same props: every expected cue started, worst offset in frames.
   - **Smoothness:** count frame jumps of more than 1 and animation-frame gaps of more than 2 × (1000 / fps) ms.
   - **Report:** PASS/FAIL lines plus the numbers; a **Copy report** button (Clipboard API); and, if `REPORT_URL` was set at build time, a `POST` of the JSON to it (see step 5).
4. **Check it on the Mac first:** `vite build` and `vite preview`, then open it in desktop Chrome and in macOS Safari (WebKit, closest to the phone). Safari tells you early whether the WebCodecs path works in WebKit. Fix anything that fails here before going near Xcode.
5. **A report receiver (optional, saves the user copying text):** `receive.mjs`, a 20-line Node HTTP server on port 8790 that writes each POSTed report to `spikes/capacitor-trial/reports/<time>.json` (gitignored). The simulator reaches it at `http://localhost:8790`; the phone at `http://<Mac LAN IP>:8790` when both are on the same Wi-Fi. Plain http to a LAN address needs `NSAppTransportSecurity` → `NSAllowsLocalNetworking` = true in `ios/App/App/Info.plist`, and iOS asks the user to allow local network access on first launch. If it gets fiddly, drop it and use Copy report.
6. **iOS shell:**
   - `capacitor.config.ts`: `appId` `com.noahroy.alstrial` (confirm with the user; a free Personal Team needs a bundle ID nobody else has registered), `appName` `ALS Trial`, `webDir` `dist`. Leave `server.url` unset: the app must load its own bundle.
   - `npx cap add ios` (Swift Package Manager is Capacitor 8's default; CocoaPods isn't needed), then `npx cap sync ios` after each web build.
   - Read the generated project and Capacitor's iOS source (`node_modules/@capacitor/ios/Capacitor/Capacitor/`) to confirm the web view allows inline playback (`allowsInlineMediaPlayback`) and doesn't require a gesture for media (`mediaTypesRequiringUserActionForPlayback`). If it doesn't, record what was needed and set it in the generated project.
   - Development builds are inspectable from Safari (`ios.webContentsDebuggingEnabled` defaults to true for development builds), so the console and JSON can also be read from the Mac's Safari, Develop menu.
7. **Simulator pass (no user needed):** boot an iPhone simulator (`xcrun simctl list devices available`), run `npx cap run ios --target <simulator id>`, tap through with `xcrun simctl` or Safari's inspector, and save the report. Screenshot with `xcrun simctl io booted screenshot <file>` and look at it. The simulator uses the Mac's WebKit and audio, so its sound and smoothness results don't count; the decoding path, inline playback, layout and holds do.
8. **Device pass (needs the user; see below):** once the user has signed in to Xcode and plugged in the phone, open the project (`npx cap open ios`), have the user pick their Personal Team under Signing & Capabilities the first time, then run on the device (Xcode, or `npx cap run ios --target <device id>` from `xcrun xctrace list devices`). The first run on a phone new to this Mac spends a few minutes preparing it for development. Then the user runs the trial (below) and you collect the report.
9. **Record and clean up:**
   - Write the results under Phase C5 in `PLAN-CLOUD.md` (date, device, iOS, decoding path, each PASS/FAIL with numbers, and what each means for C5), and update the trial line in `CLAUDE.md`'s Status.
   - Commit the spike's code (no media, no `ios/App/App/public/`, no reports) to `main` with a message that says what the trial found, then push.
   - Leave `pnpm check` passing: run it after the workspace change.

## What the user does, and when to ask

Ask for each item when you reach it, not all at once (the user said: ad hoc). Use the question tool when an answer is needed to continue.

- **Before the device pass (5 minutes):** sign in to Xcode with their Apple ID (Xcode → Settings → Accounts → + → Apple ID; a free Personal Team is enough). Confirm the bundle ID `com.noahroy.alstrial` is fine.
- **On the phone, once:** plug it in with its cable, unlock it and tap **Trust** for this Mac; turn on **Developer Mode** (Settings → Privacy & Security → Developer Mode; the phone restarts and asks to confirm); after the first install, trust the developer (Settings → General → VPN & Device Management). Optional, for reading the console from the Mac: Settings → Apps → Safari → Advanced → **Web Inspector** on.
- **Before the run:** turn the ringer on (iOS can mute web audio when the phone is on silent; record which way it was), volume up, Low Power Mode off, and other apps closed. The phone stays unlocked and on the same Wi-Fi as the Mac if the report receiver is used.
- **The run (about 10 minutes):** tap Play and watch the whole episode once. Say whether the video stayed in the page, whether the cards froze cleanly, and whether the sounds (the move sound as each badge pops, typing under the text, the game start and end sounds) played in time. Then Pause and resume once, and Restart once. Then tap Copy report and paste it into the chat (or the receiver catches it).
- **Optional, ask first:** a second run with BB1's 720p proxy (`projects/bb1-ea55/proxy.mp4`, 2:28, copyrighted, so only on their own phone and never committed) to test a full-length clip's memory and smoothness.

## What the results mean for C5

- **WebCodecs path works, holds exact, sound in time:** C5 builds `apps/mobile` on the Player as it is.
- **Video falls back to `<video>`:** holds rely on seeking a plain video element; if they are not frame-exact, C5 needs the extracted-still fallback for holds (PLAN.md's Phase 2 spike made it unnecessary on desktop).
- **No sound until something else happens, or sound only with the ringer on:** C5 has to unlock audio on the first tap (resume the `AudioContext` inside the tap) and may need to set the app's audio session to playback in native code.
- **Choppy:** try the 720p proxy at a lower Player scale, then a smaller proxy for mobile; record the frame-drop numbers either way.

## Known limits

- A free Personal Team's signing lasts 7 days; after that the app stops opening until it is run from Xcode again. Free teams also have small limits on devices and new bundle IDs, so don't churn bundle IDs.
- Android is not part of this trial; C5's spike still needs it.
- The trial plays a local bundle: it says nothing about signed URLs, uploads or the backend (C5 covers those against the deployed API).

## Running it again (built Nov 5; results under Phase C5 in `PLAN-CLOUD.md`)

From `spikes/capacitor-trial/`, with the phone plugged in and unlocked:

```sh
pnpm prepare:trial                       # clip (audio stripped; TRIAL_KEEP_AUDIO=1 keeps it), project, sounds -> public/
REPORT_URL=http://$(ipconfig getifaddr en0):8790 npx vite build
npx cap sync ios
node receive.mjs &                       # reports land in reports/
cd ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -destination id=<device id from `xcrun xctrace list devices`> -derivedDataPath build -allowProvisioningUpdates build
xcrun devicectl device install app --device <device id> build/Build/Products/Debug-iphoneos/App.app
xcrun devicectl device process launch --device <device id> com.noahroy.alstrial
```

The team (7FWNGJ8UGV) is set in `ios/App/App.xcodeproj`; `Info.plist` allows local networking for the receiver. `TRIAL_CLIP` and `TRIAL_PROJECT` point `prepare.mjs` at another clip and project (BB1's proxy only on the user's own phone, never committed). `mac-check.mjs` drives the same run in headless Chrome against `pnpm preview`; it was written but not run.
