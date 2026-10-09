# Analysed Like Chess Studio

Single-user local web app: upload a movie scene clip, draft chess-style move annotations with cloud AI, edit them over live playback, render an MP4 with freeze-frames burned in. `PLAN.md` is the full build plan; read the section for the current phase before starting work.

## Commands

- `pnpm dev`: web (Vite, http://localhost:5173) and server (Hono, http://127.0.0.1:8787) together. Vite proxies `/api` to the server.
- `pnpm check`: lint, typecheck and tests. Run before every commit.
- `pnpm test` / `pnpm lint` / `pnpm typecheck`: individually.
- `scripts/make-sample-clip.sh`: regenerates `fixtures/sample/source.mp4` (needs system ffmpeg).

## Layout

- `apps/web`: editor UI (Vite, React, Tailwind).
- `apps/server`: Hono API, jobs, ffmpeg, AI adapters, render. Runs TypeScript directly on Node (type stripping), so use only erasable syntax and `.ts` import extensions.
- `packages/schema`: Zod schemas and the types derived from them; the only source of types.
- `packages/composition`: Remotion `<Episode>`, `<MoveCard>`, `timeMap()`. Lint enforces purity.
- `packages/theme`: classification tokens, badges, theme presets.
- `fixtures/`: test data, including the sample project and recorded provider responses.
- `projects/`: runtime project folders, gitignored.

## Conventions

- All times are source-clip seconds; frames are derived, never stored.
- Hard invariants (moment spacing, ordering, references) live in `ProjectSchema`. Soft rules (text caps, `bestMove` on best/brilliant) are `momentWarnings()`, so the editor warns without blocking saves.
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
