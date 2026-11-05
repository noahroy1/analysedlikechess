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

5. **Order (Nov 3):** this comes before Phase 6 and any further feature iterations. The backend counterpart of the current logic (C0-C4) comes first, then the mobile app (C5), because the app depends on it.
6. **Assets (Nov 3):** build with the sounds and icons we have, and replace the improvised ones later.

7. **Spend (Nov 3):** build the cap logic as the frame for later work: per-user monthly caps, checked before every paid call, with the value in one place. Start at $2 a month. The user expects to tighten it well below that once spend becomes the bottleneck.
8. **Sign-in (Nov 3):** OAuth (Google and Apple) is built at the same time as the app's own sign-in method, not added later. So C3 builds email codes and OAuth together, and C5 adds the native mobile flows for both.
9. **One backend (Nov 4, confirmed):** the cloud backend serves both front-ends. The desktop editor stays the development client, and in development talks to the same backend running locally (Wrangler plus local Supabase) or to staging. The mobile app uses the deployed backend. The Node server is retired at the end of C3. One repo.
10. **Region (Nov 3):** the user is in Sydney, so latency is measured from there.

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
| Fixed cost at our scale | The free plan pauses idle projects, so production needs Pro ($25 a month, no pausing; confirmed Nov 4 in Supabase's billing FAQ). | Pennies, inside Workers Paid, which Containers and Workflows need anyway. | **Cloudflare**. Accepted: it is a fixed cost, not a metric the product depends on. |

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
| Accounts | none | **Supabase Auth.** The Worker verifies the JWT against the project's JWKS (asymmetric ES256 keys, confirmed on the Sydney project Nov 4). |
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

## C0 findings (Nov 3)

Sources are the Cloudflare and Supabase docs pages named below, read Nov 3, 2026.

- **Workers Paid is required** (developers.cloudflare.com: containers/pricing, workflows/reference/limits, workers/platform/limits):
  - Containers list no Free allowance ("N/A").
  - On Free, a Workflow step gets 10 ms of CPU, and a Worker request gets 10 ms of CPU and 50 subrequests.
  - On Paid, a request gets 30 s of CPU by default (up to 5 min) and 10,000 subrequests.
  - Memory is 128 MB per isolate on both plans.
- **Containers** (instance types: vCPU / memory / disk):

  | Type | vCPU | Memory | Disk |
  | --- | --- | --- | --- |
  | lite | 1/16 | 256 MiB | 2 GB |
  | basic | 1/4 | 1 GiB | 4 GB |
  | standard-1 | 1/2 | 4 GiB | 8 GB |
  | standard-2 | 1 | 6 GiB | 12 GB |
  | standard-3 | 2 | 8 GiB | 16 GB |
  | standard-4 | 4 | 12 GiB | 20 GB |

  - **Paid rates:** $0.000020 per vCPU-second (375 vCPU-minutes a month included), $0.0000025 per GiB-second (25 GiB-hours included) and $0.00000007 per GB-second of disk (200 GB-hours included).
  - **Estimate, to be measured:** a BB1 render on standard-4 at today's 2 minutes would be 480 vCPU-s plus 1440 GiB-s, about $0.013. The included minutes would cover about 45 such renders a month.
  - **Source size:** the largest disk is 20 GB, which caps source size.
- **Workflows on Paid:**
  - 10,000 steps (up to 25,000).
  - A step returns at most 1 MiB, or a stream that counts toward state.
  - 30 s of CPU per step (up to 5 min), with unlimited wall time.
  - Sleeps of up to 365 days.
  - 1 GB of state per instance.
  - Completed instances are kept 30 days.
  - Sleeping instances don't count toward concurrency.

  So stage outputs over 1 MiB go to R2, and OpenAI polling is a sleep step per poll.
- **Hyperdrive** (hyperdrive/platform/pricing, the Supabase guide, supported-databases-and-features):
  - It is on both plans (Free: 100,000 queries a day).
  - Use Supabase's direct connection, not its pooler, with `pg` 8.16.3 or later (Postgres.js also works). Avoid supabase-js in the Worker.
  - Unsupported: per-session state, `LISTEN`/`NOTIFY` and SQL-level `PREPARE`.
  - Transaction-local `set_config(…, true)` for RLS claims isn't named either way. Test it in the latency spike.
- **The first Supabase project is in Frankfurt** (its database's IPv6 address is in AWS `eu-central-1`). A TCP connect from Sydney took 349-379 ms, against 18-32 ms to AWS Sydney. One round trip already fails the 150 ms gate, so the project is recreated in Sydney (`ap-southeast-2`). Its auth already signs with ES256 (JWKS at `/auth/v1/.well-known/jwks.json`). Supabase's edge caches the key set for 10 minutes and clients for up to 10 more, so the Worker caches keys for 10 minutes and refetches on an unknown `kid`.
- **Realtime Broadcast** (supabase.com/docs/guides/realtime/broadcast):
  - **Sending:** the server sends with `POST /realtime/v1/api/broadcast/<topic>/events/<event>?private=true` (with an `apikey` header), or in batches with `POST /realtime/v1/api/broadcast` and a `messages` array.
  - **Authorization:** private channels are authorised by RLS on `realtime.messages`. Ours: `realtime.topic() = 'user:' || auth.uid()`.
  - **Clients:** they call `supabase.realtime.setAuth()` and subscribe with `{ config: { private: true } }`.
- **Frames and portraits stay in the container.** The alternatives didn't fit:
  - Media Transformations (stream/transform-videos) needs a Cloudflare zone, meaning our own domain, with transformations enabled. It needs a source URL that answers HEAD and Range, input under 100 MB and 10 minutes, and takes times as strings like `5s`. Frame-exact grabs aren't documented.
  - The Images binding takes up to 20 MB of input and documents no crop on its binding page.

  So regions and portraits call the container. The paid spike measures the container's cold start, which competes with Gemini's 2 s.
- **Workflow spike (passed):** 30 polls ran, each followed by a 30 s `step.sleep`, with a redeploy 5 minutes in. Every sleep lasted 30.0 s, and the run completed.
  - **A run keeps the code it started on:** every poll after the redeploy, and the result, reported the old build.
  - **Effect on analysis:** a prompt or code change reaches only new runs, so a run in flight never mixes two prompts. Fixing a stuck run means terminating and restarting it, so the stage cache matters.

- **Container render spike (Nov 4, BB1 v87 with the creator look: 5350 frames, 3:43 out):**
  - **Setup:**
    - The container program fetched the clip, portraits and sounds from R2 through a Worker, served them on localhost with Range support, rendered with `renders.ts`' exact settings, and uploaded the MP4 back.
    - The image is `node:24-bookworm-slim` with Remotion's Chrome libraries and the browser baked in, and the Remotion bundle built on the Mac.
  - **Speed on standard-4 (4 vCPU, 12 GiB):**
    - Rendering took 339-356 s (333 s with `concurrency: 4`), against 117.5 s on the M4 Mac (10 cores). The cloud is about 3× slower.
    - Fetching inputs took 2-3 s (191 MB) and uploading took 2.4-2.9 s (77 MB).
  - **Cost:** about $0.039 a render, from 346 s × (4 vCPU + 12 GiB + 20 GB). Workers Paid's included usage covers about 16 such renders a month, limited by vCPU.
    - Idle instances bill until `sleepAfter` runs out, so the real service stops the container when a job ends.
  - **Faster renders are possible:** if 6 minutes is too slow, render frame ranges on several instances and join them, as Remotion Lambda does. The total cost stays about the same. This is a C2 decision.
  - **Match:**
    - Without fonts, every frame differed (median 22.6 dB), all of it in text. The image has no Arial, so subtitles, names and cards used a wider fallback font. The picture itself was within about 1 level.
    - With `fonts-liberation` (Liberation Sans has Arial's metrics, and Debian's fontconfig maps Arial to it), the median is 32.2 dB and the minimum 27.8 dB on every one of the 5350 frames. Layout and line breaks are identical, and only the letter shapes differ slightly.
    - **Shipped font (the user's call, Nov 4):** the composition now ships Arimo (`packages/composition/src/fonts/`, SIL OFL), and the creator look asks for it before Arial. Rendered with it, the Mac and a local Linux container (same image) match at a median of 34.9 dB and a minimum of 30.4 dB over all 5350 frames (Liberation alone gave 32.2 and 27.8). The cards show the same letters in the same places; what remains is how macOS and Linux smooth text edges. The image keeps `fonts-liberation` as the fallback.
    - **The default look still uses the system font stack** (San Francisco on a Mac, a Linux sans in a container), so its renders will differ from the Player until it ships a font too. `TODO(open-decision)`.
  - **Cold start:**
    - The first start after a deploy took 26 s, and a new instance on a cached image took 21.8 s. A warm request takes 10-40 ms.
    - So a frame grab or portrait crop after idle would wait about 20 s. The API wakes the media container when the editor opens a project, keeps it warm with `sleepAfter` of about 10 minutes while the editor is open, and uses a small instance type for frame work.
  - **Deploy notes:**
    - `max_instances: 1` makes a second instance fail with 500 while the first is awake.
    - A config-only redeploy reported `APPLICATION_NOT_FOUND` during rollout, though instances kept serving.
    - Wrangler builds the linux/amd64 image with Docker and pushes it, and needs `docker` on the PATH (`/Applications/Docker.app/Contents/Resources/bin`).
- **Gemini upload spike (Nov 4):**
  - **One request:** a Worker streamed BB1's 16.5 MB proxy from R2 to Gemini's resumable upload in one request. It went up in 4.6 s, was ACTIVE after 7.4 s, and was deleted.
  - **Large files:** the 191 MB original failed that way ("Network connection lost"). Uploaded in 8 MiB chunks the way the SDK does it (`upload` with `X-Goog-Upload-Offset`, checking `x-goog-upload-status: active`, with `upload, finalize` last), each chunk read from R2 as a byte range, it went up in 39.6 s and was ACTIVE after 25.8 s. The proxy took 6.4 s and 7.3 s.
  - **Effect:** the Worker never holds more than one chunk, so the real describer uses `fetch` and chunks, not the SDK.
- **Database spike (Nov 4, Sydney project, Postgres 17.11, through Hyperdrive):**
  - **Isolation:** with `set_config('role', 'authenticated', true)` and the claims set inside each transaction, user A saw only A's row and updated 0 of B's, and B saw only B's. After the transaction, and on a fresh client from the pool, the role was back to `postgres` and the claims were empty. Transaction-local settings work through Hyperdrive and don't leak.
  - **Save timing:** 50 saves after 10 warm-up saves, each with a 20 KB document, measured from this Mac in Sydney with a fresh TCP and TLS connection per request:

    | Save | Client p50 / p95 | Without the connect | Transaction in the Worker p50 / p95 | Worker's own connect |
    | --- | --- | --- | --- | --- |
    | Five statements (select, version-checked update, history insert, trim) | 127 / 148 ms | 109 / 134 ms | 42 / 64 ms | 2-7 ms |
    | One statement (CTE: update, insert, trim) | 107 / 135 ms | 91 / 117 ms | 26 / 49 ms | 2-7 ms |

    Both pass the 150 ms gate. A browser reuses its connection, so real saves sit nearer the middle column. The real save is written as one statement.
  - **Connection string:** the password contains `@`. `pg` parsed the raw string, but Hyperdrive is given it URL-encoded (`%40`).
  - **Error 1042:** the first requests to a just-deployed Worker returned it, and it went away within seconds.
- **Secrets from `.env`:** `GEMINI_API_KEY`'s line carries an inline `# comment`. Node's env-file parser drops it, so copying values into `wrangler secret` takes the first word only.

## Phases

**Phase C0: Docs and spikes**

Read the current docs for:
- Workers, Workflows, Containers, R2, Hyperdrive, Media Transformations and Images
- Supabase Auth (JWKS, Capacitor PKCE), RLS through a pooled connection, and Realtime Broadcast (REST send, private channels)

Confirm every "(confirm in C0)" in this file. Record limits and prices in this file with their sources.

- [x] BB1 renders in a Container. Time and cost are recorded, and the MP4 matches the Node render (`render-checks`' PSNR method, at least 27 dB). Passed Nov 4: every frame is at least 27.8 dB from the Mac render, with Liberation fonts in the image (details in the findings).
- [x] Autosave (one transaction with RLS claims set) through Hyperdrive to Supabase measures under 150 ms p95 from the user's location. Passed Nov 4: 135 ms p95 as one statement and 148 ms as five, each with a fresh connection from Sydney (details in the findings).
- [x] A Workflow survives a 15-minute `step.sleep` poll loop and resumes after a deploy. Passed Nov 3 on Workers Free: 30 polls, 30 s sleeps, with a redeploy at 5 min.
- [x] A frame and a 256 px portrait crop come out of the proxy without a container, or the warm-container fallback is costed. Settled Nov 4: Media Transformations doesn't fit, so the container does it (cold start and warm-up below).
- [x] The Gemini file upload works from an R2 stream on Workers (else its REST upload is called with `fetch`). Passed Nov 4 with `fetch` and 8 MiB chunks.

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

- [x] `pnpm check` and every browser check pass, with no change in behaviour. Done Nov 4: 329 tests; every browser check, with render-checks on the default and creator-look samples and a copy of BB1 at the same PSNR as before C1. The only visible change is Download in place of Show in Finder, as planned.
- [x] A test repeats every mutating call with the same key and gets the same response with one effect. Done Nov 4: `apps/server/src/contract.test.ts`.

**C1 notes (Nov 4):**
- **Upload:** `POST /projects` returns `{ projectId, upload: { uploadId, partSize, partCount } }`, not the project: a project needs the probed source, so the document is created at complete. Parts are 8 MiB; each part's size is checked; parts answers with the parts already stored (`uploaded`), so a resumed upload skips them (C3: S3 ListParts on R2, or a table). An upload that fails to probe is deleted; one with missing parts keeps what was stored.
- **Media grants** sign a project's file prefix (`projects/<id>/`) rather than one path, so one grant serves the Player, thumbnails and portraits; the serve path needs no database lookup. Sounds have their own grant; upload parts sign one part each.
- **Renders:** the same version and size while one runs returns it (200); another size is 409 `job_running` with the running job.
- **Errors:** `over_cap` is 402; `not_ready` (analysis before ingest) and `job_running` are 409; `missing_keys` 400; `media_url_invalid` 403; `idempotency_key_reused` 422.
- **Spend:** checked before every paid call, including mid-analysis before each paid stage; logged per call with model, usage and cost; UTC months. Renders log container seconds at $0 until C4 prices them.
- **Live updates:** one `job` event shape (the `Job` schema) for SSE now and Realtime later; clients read `GET /jobs` on every (re)connect instead of the server sending a snapshot.

**Phase C2: Media service** (next; the starting state and open choices are in `CLAUDE.md`, "Next action")

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
- **CORS:** allow the web origin plus Capacitor's (`capacitor://localhost` on iOS, `https://localhost` on Android: Capacitor's defaults `server.hostname` "localhost", `iosScheme` "capacitor" and `androidScheme` "https", confirmed Nov 4).
- **Migration:** a script moves `projects/<id>/` folders into R2 and Postgres under Noah's account (BB1, the Private Property benchmark and its comparison runs) and leaves the local folders untouched.
- **Prices:** `prices.ts` gains container seconds.

- [ ] BB1 opens in the deployed editor and renders, and `render-checks` passes against it.
- [ ] The real cost per clip (providers, container seconds, R2) is measured and recorded here.

**Phase C5: Mobile**

- **Spike first:** the Remotion Player in iOS WKWebView and Android WebView. Check inline playback, frame-exact holds and Web Audio after a user gesture.
- **iPhone trial (done Nov 5; plan `spikes/capacitor-trial/PLAN.md`, code in `spikes/capacitor-trial/`):** a throwaway Capacitor 8.6.0 shell that bundles the sample project (moved onto the creator look as the editor does, 1320 frames at 30 fps, 3 holds, game review) and the user's sound files, plays `<Episode>` in the unchanged Player, measures itself and posts its report to the Mac (`receive.mjs`; reports in `spikes/capacitor-trial/reports/`, gitignored). Device: the user's iPhone 12 on iOS 26.6.1 (the web view reports "iPhone OS 18_7": iOS 26 freezes the user agent's version), ringer on. Two runs, each a full play, Restart then pause and resume, and a jump to move 2. The phone auto-locked twice in run 2. The user watched both: the video stayed in the page, every card froze cleanly, and the sounds played in time. The Mac and simulator passes were skipped (the user's call: the phone run answers the same questions).
  - **Decoding: WebCodecs.** `VideoDecoder` and `AudioDecoder` exist, `isConfigSupported` says yes to the sample's H.264 High 3.1, and every frame was drawn on `@remotion/media`'s `<canvas>`; the `<video>` fallback never ran. No console warnings or errors.
  - **Inline: PASS.** No fullscreen events. Capacitor's web view already sets `allowsInlineMediaPlayback = true` and `mediaTypesRequiringUserActionForPlayback = []` (`CAPBridgeViewController.swift`), so nothing native was needed.
  - **Holds frame-exact: PASS.** In every hold, more than 99% of samples (1115 of 1119, 1696 of 1707, 1537 of 1552) matched, pixel for pixel (difference 0.00), the hold's source frame as the next segment draws it, both paused and playing. The previous frame differs by 2.2-6.5, so the comparison can tell neighbouring frames apart. The rest read as an empty layer (mean 0) for 0.1-0.4 s exactly 1 s before each hold ends, which is when the next segment premounts (`premountFor={fps}`). That's most likely the trial's sampler picking up the next segment's canvas before its first frame is drawn, while it is still transparent: the user saw no flash. If C5 wants proof, record the screen across a hold's last second. **The extracted-still fallback is not needed on iOS.**
  - **Sounds: PASS on the ear and on timing.** Every cue in `soundCues()` started, worst 0.6 frames off (the Mac measures 0.5-0.6), after the first tap, after pause and resume, and after a seek (Restart, Jump). The Player's AudioContext starts `suspended` and runs from the tap; Remotion also plays a silent data-URI MP3 through its 5 shared `<audio>` tags on each play to unlock audio. Sounds due in the first second after a play are scheduled while the context is still resuming (run 2: game-start after the tap, three typing cues after the resume), and the user heard them in time, so a context that is still resuming is not a failure; the trial's stricter "running context" line reports them as FAIL. A screen lock moves the context to `interrupted` and it comes back by itself. No native audio-session code was needed with the ringer on; **with the ringer off is untested** (iOS can mute web audio then), so C5 should try it once.
  - **Smooth: PASS.** Run 1: 4 jumps skipping 4 of 2829 frames (0.1%), 1 of 5670 animation frames late, 99% of real time. Run 2: the only 2 jumps (198 frames) are the two auto-locks, 3-4 s each; otherwise none, at 100% of real time. Each hold sample also reads the canvas back (32x18), so real playback is at least this smooth.
  - **Review and font: PASS.** The game review drew from frame 1185 and Arimo loaded.
  - **The trial's own report wording:** run 2 shows FAIL on "one image per hold", the three sound lines and smoothness for the reasons above (empty premount canvas; cues scheduled while the context resumes; auto-lock). The numbers behind each are in the reports. The clip's own audio was stripped for run 2 (`prepare.mjs`, as sound-checks does); run 1 played it.
  - **For C5:** build `apps/mobile` on the Player as it is: WebCodecs, the holds, Web Audio after a tap and inline playback all work in Capacitor's WKWebView on an iPhone 12. Still to check: ringer off; a full-length clip (BB1's 720p proxy, optional, never committed); a dev build signed by a free team stops opening 7 days after install.
  - **Android** is not part of this trial; C5's spike still needs it.
- **Then build** `apps/mobile` to the scope above. Sign-in is Supabase PKCE with deep links.

- [ ] On an iPhone and an Android phone: sign in, upload a clip from the camera roll, watch the drafts with holds and sounds, approve and edit one card, render, and share the MP4.
- [ ] An upload interrupted by backgrounding the app resumes from its last part.

## Risks

- **Render time and cost in Containers.** C0 settles this. The fallback is Remotion Lambda (AWS), which would split the backend across two clouds.
- **Large sources** may exceed a container's ephemeral disk. Cap uploads by duration (the 10-minute assumption) and size.
- **Interactive latency** for regions and portraits, if Media Transformations can't extract frames from our proxies.
- **Copyrighted clips.** For the first time, users' footage (and `media/` demo footage, at migration) is stored by us. R2 stays private and URLs are signed, but other users need terms of use and a way to take content down.
- **The sound bank and icons** are the current files, served to every user (the user's call, Nov 3). Replace them before a public release.
- **Spend.** The app pays the providers, so a runaway user or a retry loop costs real money. Spend caps and idempotency keys are the guard, and C1 tests both.
- **Mobile uploads** from a WebView stop when iOS suspends the app. Resumable parts limit the loss. A native background-upload plugin would need its own approval.
