# Analysed Like Chess Studio — Cloud Plan

Nov 3, 2026 · @Noah

This plan moves the backend off the local Node server onto Cloudflare, with Supabase for every database concern. It splits the front-end in two: the desktop web editor stays as the development client, and a Capacitor mobile app uses the same backend as its own. It follows v1 ([PLAN.md](PLAN.md)). Phases C0-C5 below run one at a time under the same working rules as the v1 phases.

## Goals

- **Multi-user from the start.** Accounts, per-user projects, per-user spend. This replaces v1's "single-user, loopback only".
- **One backend, any client.** The API assumes nothing about the browser. It has no relative `/api` behind a Vite proxy, no "Show in Finder", no local paths and no reliance on a stream staying open. The desktop editor and the mobile app are two clients of the same contract.
- **Idempotent.** Every call is safe to repeat, because mobile networks drop and retry. The rules are under "API contract".
- **Nothing in the format changes.** `packages/schema`, `composition` and `theme` move unchanged. The Player and the renderer still draw the same `<Episode>`, and every browser check still passes.

**Not in scope:** billing and payments, sharing projects between users, push notifications, uploading to YouTube, and a native (non-web) stage.

## Decisions (Nov 3)

1. **Several users now.** The user's call: designing for multiple users before C1 is cheaper than adding it later.
2. **Supabase over Cloudflare for databases,** as long as no relevant metric suffers. The comparison is below. Supabase holds the data, auth and live events. Cloudflare holds compute and media.
3. **Capacitor** for the mobile shell, for the most reuse of the DOM-only Remotion Player and `<MoveCard>`.
4. **Dependencies approved** (working rule 7): `wrangler`, `@cloudflare/workers-types`, `@cloudflare/containers`, the Workers Vitest pool, Docker for the container image, and Capacitor. The Supabase pieces this plan adds (`@supabase/supabase-js` in the clients, a Postgres driver in the Worker, and the Supabase CLI for local dev) were not on that list. Confirm them before C1 uses them.

**Still open:**
- the order against Phase 6 (pitch build)
- the sound bank's licence for other users (see Risks)
- the per-user spend cap's default

## Why Supabase for the data

| Metric | Supabase (Postgres, Auth, Realtime) | Cloudflare (Durable Objects, D1) | Verdict |
| --- | --- | --- | --- |
| Correctness under concurrent writes | `UPDATE … WHERE version = $n` in a transaction gives the 409 for free. Unique indexes enforce one job per project per kind. | A Durable Object serialises writes per project. D1 has transactions too. | Even |
| Multi-user auth and authorisation | Supabase Auth issues JWTs, and Row Level Security puts ownership in the database itself. Capacitor sign-in is documented (PKCE plus deep links). | Bring your own auth (Access suits staff, not app users) and enforce ownership in code. | **Supabase** |
| Latency from the Worker | Postgres sits in one region. Hyperdrive pools connections at the edge, so a request costs one round trip to that region. | A Durable Object also lives in one place (near its first caller), and D1 has one primary. | Even. C0 measures it. The hot paths are open (1-2 queries) and autosave (one transaction, debounced). Proposals take seconds of LLM time, so the database adds nothing visible. |
| Live progress to clients | Realtime Broadcast on private channels, authorised by RLS. The server sends through a REST endpoint, and supabase-js reconnects on its own, including after a mobile app resumes. | A hub Durable Object with hibernating WebSockets, plus our own reconnect and auth. | **Supabase** (less code of ours) |
| Inspection, migrations, backups | SQL migrations in `supabase/migrations/`, the dashboard, and daily backups on paid plans. | Wrangler migrations. Durable Object storage is opaque without our own tooling. | **Supabase** |
| Local dev and tests | `supabase start` runs Postgres, Auth and Realtime in Docker. | Miniflare simulates Durable Objects and D1 in-process, with no Docker. | Cloudflare is lighter. The C1 interfaces keep unit tests in memory, so only integration checks need Docker. |
| Portability | Plain Postgres. | Proprietary. | **Supabase** |
| Fixed cost at our scale | The free plan pauses idle projects (confirm in C0), so production needs Pro (about $25 a month). | Pennies, inside Workers Paid, which Containers and Workflows need anyway. | **Cloudflare**. Accepted: it is a fixed cost, not a metric the product depends on. |

**Stays on Cloudflare, and why:**
- **Media in R2.** Video playback is all egress, and R2 charges none. These are files, not database data.
- **Orchestration in Workflows,** for durable steps and `step.sleep` across 13-minute OpenAI flex calls. Supabase Queues has no step or sleep model, so it would need a poller of our own.
- **ffmpeg and Remotion in Containers.**

**C0 gate:** if autosave through Hyperdrive measures worse than 150 ms p95 from the user's location, stop and revisit this table before C1.

## Architecture

| Part | Today | Cloud |
| --- | --- | --- |
| API | Hono on Node (`apps/server`) | **`apps/api`:** Hono on a Worker (`nodejs_compat`), served under `/api/v1` |
| Project document, history, manifests, caches, render list, usage logs | JSON files per project folder, with in-process write locks | **Supabase Postgres.** Tables below. The Worker reaches it through Hyperdrive. |
| Accounts | none | **Supabase Auth.** The Worker verifies the JWT against the project's JWKS (asymmetric signing keys; confirm in C0). |
| Media: source, proxy, audio, thumbnails, portraits, MP4s, stage outputs | Files on disk | **R2** at `projects/<id>/…` (ownership lives in Postgres, not in the key) |
| Chess sounds | `media/sounds/` | **R2** at `sounds/`, one bank for every user. Lengths are probed at upload and kept in a `sounds` table. |
| Jobs | `JobQueue` + EventEmitter | **Workflows:** one per ingest, analysis run and render. Steps match today's stages. |
| ffmpeg, Remotion, Chrome | Child processes | **`apps/media`:** today's Node media and render code in a Container |
| Live progress | `/api/events` SSE | **Realtime Broadcast** on a private `user:<uid>` channel, plus a status endpoint for the snapshot |
| Secrets | `apps/server/.env` | `wrangler secret`. Provider keys stay server-side and app-wide (users never bring their own). |

### Tables

The Zod schemas stay the only source of types (working rule 3).
- **Columns** hold only what is queried or constrained. Everything else is `jsonb`, parsed with the existing schema on every read and write.
- **No types are generated from the database.**
- **Every table has RLS** with an ownership policy.

| Table | Holds | Replaces |
| --- | --- | --- |
| `projects` | `id`, `owner_id` (→ `auth.users`), `version`, `created_at`, `updated_at`, `doc jsonb` (the whole `Project`) | `project.json` |
| `project_versions` | `project_id`, `version`, `doc`, `saved_at`. Trimmed to 20 in the same transaction as the save. | `history/v*.json` |
| `stage_cache` | `project_id`, `kind` (`ingest` / `analysis` / `regions`), `stage`, `key`, `output` (`jsonb` when small, else an R2 key) | `ingest.json`, `analysis/manifest.json` + outputs, `regions-cache.json` |
| `jobs` | `id`, `project_id`, `kind` (`ingest` / `analysis` / `render`), `workflow_id`, `status`, `request`, timestamps. A unique partial index on (`project_id`, `kind`) while pending or running. | `JobQueue.has()` |
| `renders` | `id`, `project_id`, `version`, `preset`, `status`, `error`, `r2_key`, `bytes`, timestamps | `renders/renders.json` and the snapshots (the snapshot moves to R2) |
| `usage` | `user_id`, `project_id`, `call`, `model`, tokens, `cost_usd`, `container_sec`, `at` | `*-usage.json` and the cost fields on stages |
| `idempotency_keys` | `user_id`, `key`, `request_hash`, `status`, `response`, `created_at`. Kept 24 h. | — |
| `profiles` | `user_id`, `role`, `monthly_cap_usd` | — |
| `sounds` | `id`, `ext`, `duration_sec` | `SoundLibrary`'s ffprobe |

**RLS applies to the Worker too.** Each user request runs in a transaction that sets `role authenticated` and the JWT's claims (`set_config('request.jwt.claims', …, true)`), so a bug in a query can't cross users. Workflows run with no user present. They use a service role and always take the owner from the `jobs` row. C0 confirms that `SET LOCAL` works through Hyperdrive's pooling.

### Media service (`apps/media`)

This is the Node code that already works: `media/*.ts`, `ingest/ingest.ts`, `render/*`, and regions' `grabFrame`. It moves almost unchanged behind a small HTTP API: `/ingest/<step>`, `/frame`, `/portrait`, `/probe`, `/render`.
- **Inputs and outputs:** it reads inputs from R2 and writes outputs back through presigned URLs, and posts progress to the Worker.
- **Rendering:** it downloads the source, portraits and sounds to its disk and serves them to Remotion on localhost. That is faster and more deterministic than reading over the network, and it keeps `disableWebSecurity` local.
- **Bundle:** the Remotion bundle is built into the image. In dev, the local process keeps today's fingerprint rebuild.
- **Dev versus production:** the Worker reaches it through `MediaRunner`. In dev that is a plain local Node process (`MEDIA_URL`, no Docker). In production it is the Container binding.
- **Interactive calls** (regions' frame grab and portrait crops) shouldn't wait for a container to start. C0 tests Media Transformations (frame extraction) plus the Images binding (crop). The fallback is one warm container.

### Media URLs

A `<video>` element can't send an `Authorization` header. So every media URL the API hands out is signed: `?exp=…&sig=…`, an HMAC over the path, user and expiry.
- **Who serves them:** the Worker serves them from the R2 binding, with Range support. The renderer gets the same kind of URL.
- **Expiry:** URLs last 6 h. The client fetches fresh ones when playback fails with a 403.

## API contract

These rules hold for every route, so a client written once keeps working.

- **Versioned.** Routes live under `/api/v1`. Within v1, changes only add things. Clients send `X-Client-Version`, and a client too old to work gets 426 with a message. Store builds update slower than the desktop.
- **Typed in one place.** Request and response schemas live in `packages/schema`. `packages/client` is the only code that calls the API.
- **Errors** look like `{ error, code }`, with stable `code`s (`version_conflict`, `job_running`, `over_cap`, `not_found`, `client_too_old`, …) so the mobile app can act on them without parsing text.
- **Idempotency.** Every POST, PUT and DELETE takes an `Idempotency-Key`.
  - A repeat with the same key and body replays the stored response.
  - The same key with a different body is a 422.
  - A repeat that arrives while the first call is still running waits for it.
  - Keys are scoped per user and kept 24 h.
- **Optimistic writes.** PUT keeps `version`, and a stale save gets 409 with the current version (unchanged). Restoring from history works the same way.
- **Starting a job returns the job.** `analyze`, `ingest` and `renders` return the running job when one exists (200 with its id), not a 409. A second render request for the same version and preset returns that render.
- **Deterministic names.** Portraits are already content-hashed, so a repeated crop writes the same file.
- **Snapshot, then live.** `GET /api/v1/jobs` returns the user's live jobs. Clients call it on connect and after every reconnect or app resume. Broadcast covers the time between (broadcast messages are not stored).
- **Spend caps.** Every paid call (analysis, Regenerate, Re-evaluate, regions, renders by container seconds) checks the user's month-to-date spend against the cap first, and over the cap returns `over_cap`.

### Routes

| Today | v1 cloud |
| --- | --- |
| `POST /projects` with the file as the body | `POST /projects` with the name, context and size. It returns the project and an R2 multipart upload. Then `POST /projects/:id/upload/parts` (presigned part URLs, safe to ask again for resumes) and `POST /projects/:id/upload/complete` (probe, then ingest; a repeat returns the project). |
| `GET /projects`, `GET/PUT/DELETE /projects/:id`, history, restore | The same, scoped to the owner |
| `GET /projects/:id/files/*` | The same paths, signed (see Media URLs). `GET /projects/:id/media` returns the signed URL map. |
| `POST /renders/:render/reveal` | **Removed.** `GET /projects/:id/renders/:render/download` returns a signed URL with `Content-Disposition: attachment`. |
| `GET /events` (SSE) | **Removed.** Realtime Broadcast plus `GET /jobs` |
| `GET /analysis/config` | The same, per deployment. `GET /me` adds the profile, month-to-date spend and cap. |
| `ANALYST_HANDOFF_DIR` | **Dev only:** `GET /dev/handoff` lists pending requests and `POST /dev/handoff/:call` answers one. The Worker has no folder to watch. |

## Front-ends

- **`packages/client` (new):** the API client, moved out of `apps/web/src/lib/api.ts`. It handles:
  - the base URL
  - the session token, attached through supabase-js
  - idempotency keys (one per user intent, reused across retries)
  - multipart upload with resume
  - Realtime subscription plus the jobs snapshot
  - refreshing signed URLs
- **`packages/editor-core` (new):** `editor/store.ts`, `editor/doc.ts`, undo and autosave. They are pure already, so both clients share them.
- **`apps/web`:** the desktop editor, kept as the development client. `VITE_API_ORIGIN` points it at local dev, staging or production. It gains a sign-in screen; local dev signs in a seeded user automatically. "Show in Finder" becomes Download.
- **`apps/mobile` (C5):** a Vite React app in Capacitor shells for iOS and Android. It has its own phone layout and shares `client`, `editor-core`, `composition`, `schema` and `theme`. Scope is the projects list, upload from the camera roll, reviewing drafts over the Player, light edits (text, rating, approve or delete), Render and Share. Deep editing stays on desktop.

## Local dev and tests

- **`pnpm dev`** runs:
  - Vite
  - `wrangler dev` (Workflows and R2 simulated locally)
  - `supabase start` (Docker)
  - `apps/media` as a Node process
- **Seed scripts** become API clients.
- **`pnpm check`:**
  - Unit tests run against in-memory implementations of the C1 interfaces.
  - API tests run in the Workers Vitest pool.
  - The render test stays a Node test in `apps/media`, with no Docker.
  - Integration checks against local Supabase run in the browser-check step, not in `pnpm check`.
- **Replay** fixtures are bundled into the Worker as JSON. `ANALYSIS_RECORD_DIR` becomes an R2 prefix in dev.
- **Browser checks** take an `--origin` and a dev user's token, and otherwise run as today.

## Phases

**Phase C0: Docs and spikes**

Read the current docs for:
- Workers, Workflows, Containers, R2, Hyperdrive, Media Transformations and Images
- Supabase Auth (JWKS, Capacitor PKCE), RLS through a pooled connection, and Realtime Broadcast (REST send, private channels)

Confirm every "(confirm in C0)" in this file. Record limits and prices in this file with their sources.

- [ ] BB1 renders in a Container. Time and cost are recorded, and the MP4 matches the Node render (`render-checks`' PSNR method, at least 27 dB).
- [ ] Autosave (one transaction with RLS claims set) through Hyperdrive to Supabase measures under 150 ms p95 from the user's location.
- [ ] A Workflow survives a 15-minute `step.sleep` poll loop and resumes after a deploy.
- [ ] A frame and a 256 px portrait crop come out of the proxy without a container, or the warm-container fallback is costed.
- [ ] The Gemini file upload works from an R2 stream on Workers (else its REST upload is called with `fetch`).

**Phase C1: Interfaces and contract, still on Node**

- **Interfaces:** `ProjectRepo`, `BlobStore`, `JobRunner`, `MediaRunner`, `EventBus` and `UsageLog`, with filesystem implementations. Analysis and the routes stop importing `node:fs`.
- **Packages:** extract `packages/client` and `packages/editor-core`.
- **API:**
  - the `/api/v1` prefix
  - error codes
  - idempotency keys (in memory for now)
  - job starts that return the running job
  - the two-step upload
  - signed media URLs
  - Download in place of reveal

- [ ] `pnpm check` and every browser check pass, with no change in behaviour.
- [ ] A test repeats every mutating call with the same key and gets the same response with one effect.

**Phase C2: Media service**

Move ffmpeg and Remotion into `apps/media` behind its HTTP API, and package its Container image. The Node server calls it through `MediaRunner`.

- [ ] The render test passes in `apps/media`, and `render-checks` passes through the Node server calling it.
- [ ] The image builds and renders the sample in local Docker.

**Phase C3: Supabase and the Worker**

- **Database:** Supabase migrations for the tables and RLS policies, and Supabase implementations of `ProjectRepo` and `UsageLog`.
- **Worker:** `apps/api` on Workers with R2 as the `BlobStore`, Workflows as the `JobRunner`, Realtime as the `EventBus`, and the Container binding. Auth runs on every route.
- **Dev:** `pnpm dev` switches over, and the replay and handoff routes move with it.
- **Cleanup:** delete `apps/server` once every check passes.

- [ ] Every browser check passes against `wrangler dev` with local Supabase.
- [ ] A second user sees none of the first user's projects, media URLs, jobs or broadcasts, checked both through the API and directly against RLS.
- [ ] Killing `wrangler dev` mid-analysis and restarting it resumes the Workflow from its last finished step.

**Phase C4: Migration and deploy**

- **Environments:** staging and production Cloudflare environments and Supabase projects, with secrets set by `wrangler secret`.
- **CORS:** allow the web origin plus Capacitor's (`capacitor://localhost` on iOS, `https://localhost` on Android; confirm in C0).
- **Migration:** a script moves `projects/<id>/` folders into R2 and Postgres under Noah's account (BB1, the Private Property benchmark and its comparison runs) and leaves the local folders untouched.
- **Prices:** `prices.ts` gains container seconds.

- [ ] BB1 opens in the deployed editor and renders, and `render-checks` passes against it.
- [ ] The real cost per clip (providers, container seconds, R2) is measured and recorded here.

**Phase C5: Mobile**

- **Spike first:** the Remotion Player in iOS WKWebView and Android WebView. Check inline playback, frame-exact holds and Web Audio after a user gesture.
- **Then build** `apps/mobile` to the scope above. Sign-in is Supabase PKCE with deep links.

- [ ] On an iPhone and an Android phone: sign in, upload a clip from the camera roll, watch the drafts with holds and sounds, approve and edit one card, render, and share the MP4.
- [ ] An upload interrupted by backgrounding the app resumes from its last part.

## Risks

- **Render time and cost in Containers.** C0 settles this. The fallback is Remotion Lambda (AWS), which would split the backend across two clouds.
- **Large sources** may exceed a container's ephemeral disk. Cap uploads by duration (the 10-minute assumption) and size.
- **Interactive latency** for regions and portraits, if Media Transformations can't extract frames from our proxies.
- **Copyrighted clips.** For the first time, users' footage (and `media/` demo footage, at migration) is stored by us. R2 stays private and URLs are signed, but other users need terms of use and a way to take content down.
- **The sound bank** is one set of files served to every user. Check its licence before anyone other than the creator uses it.
- **Spend.** The app pays the providers, so a runaway user or a retry loop costs real money. Spend caps and idempotency keys are the guard, and C1 tests both.
- **Mobile uploads** from a WebView stop when iOS suspends the app. Resumable parts limit the loss. A native background-upload plugin would need its own approval.
