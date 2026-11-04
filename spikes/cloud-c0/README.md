# C0 spikes (Nov 3-4, 2026)

Throwaway code from phase C0 of `PLAN-CLOUD.md`, kept as reference for C2 and C3. Results are in that file's "C0 findings". Nothing here is built, linted or tested, and every resource these created on Cloudflare was deleted.

- `workflow/`: a Workflow polling with `step.sleep`, redeployed mid-run.
- `db/`: Hyperdrive to Supabase: RLS through transaction-local `set_config`, and timed saves (one statement vs five).
- `render/`:
  - `image/`: the container (`node:24-bookworm-slim`, Chrome's libraries, `fonts-liberation`, the browser baked in) and `server.mjs`, which fetches inputs, serves them with Range on localhost, renders with `renders.ts`' settings and uploads the MP4.
  - `worker/`: the Worker that starts it and proxies R2.
  - `make-inputs.ts`: run from `apps/server`; builds the bundle and BB1's props.
- `gemini/`: streams an R2 object to Gemini's Files API in 8 MiB chunks.

Each folder had its own `package.json` with `wrangler` 4.151.2 (plus `pg` 8.23.1 and `@cloudflare/containers` 0.3.7 where used), and its entry was `src/index.ts`. Secrets went in with `wrangler secret put` (`SPIKE_TOKEN`, `GEMINI_API_KEY`).
