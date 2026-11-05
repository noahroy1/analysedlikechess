-- Phase C3 (PLAN-CLOUD.md, "Tables"): the project data that lived in project folders.
--
-- The Zod schemas stay the only source of types: columns hold only what is queried or
-- constrained, everything else is jsonb parsed with the existing schema on every read
-- and write. Nothing is generated from this file.
--
-- The tables live in the `app` schema, which the Data API (PostgREST) does not expose:
-- clients use Supabase only for sign-in and live events, and reach data through the
-- Worker. The Worker runs each user request as `authenticated` with the user's claims
-- set for the transaction, so the policies below hold for it too. Workflows run as the
-- connection's own role (the table owner, so no RLS) and take the owner from `jobs`.

create schema app;
grant usage on schema app to authenticated, service_role;

-- Ownership. A project id is reserved (with its owner) before the project document
-- exists: an upload in progress has an id and an `uploads` row but no `projects` row.
-- Every other table hangs off this one and is deleted with it.
create table app.project_ids (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,80}$'),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index project_ids_owner on app.project_ids (owner_id);

-- Whether the caller owns a project. Security definer, so policies on the other tables
-- don't re-run project_ids' own policy for every row.
create function app.owns_project(pid text) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from app.project_ids where id = pid and owner_id = (select auth.uid())) $$;
revoke all on function app.owns_project(text) from public;
grant execute on function app.owns_project(text) to authenticated;

-- The editor document (`Project`), at `version`.
create table app.projects (
  id text primary key references app.project_ids (id) on delete cascade,
  version integer not null check (version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  doc jsonb not null
);

-- Saved versions, newest 20 kept (trimmed in the save's own statement). `saved_at` is
-- when that version was written.
create table app.project_versions (
  project_id text not null references app.project_ids (id) on delete cascade,
  version integer not null,
  saved_at timestamptz not null,
  doc jsonb not null,
  primary key (project_id, version)
);

-- Ingest and analysis stages and the per-frame regions answers, by input key.
create table app.stage_cache (
  project_id text not null references app.project_ids (id) on delete cascade,
  kind text not null check (kind in ('ingest', 'analysis', 'regions')),
  stage text not null,
  key text not null,
  output jsonb,
  updated_at timestamptz not null default now(),
  primary key (project_id, kind, stage)
);

-- A resumable upload's record (`UploadRecord`) and the parts stored so far.
create table app.uploads (
  project_id text primary key references app.project_ids (id) on delete cascade,
  record jsonb not null,
  created_at timestamptz not null default now()
);

-- Ingest, analysis and render jobs: one live job per project and kind.
create table app.jobs (
  id text primary key,
  project_id text not null references app.project_ids (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('ingest', 'analysis', 'render')),
  workflow_id text,
  status text not null check (status in ('pending', 'running', 'done', 'failed', 'cancelled')),
  request jsonb,
  -- The job's live state (`JobState`), what `GET /jobs` and broadcasts carry.
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index jobs_one_live on app.jobs (project_id, kind) where status in ('pending', 'running');
create index jobs_owner_live on app.jobs (owner_id) where status in ('pending', 'running');

-- Renders (`RenderJob`, in `job`); the snapshot and the MP4 are in R2.
create table app.renders (
  project_id text not null references app.project_ids (id) on delete cascade,
  id text not null,
  -- Order in the list (oldest first), as the list is edited as a whole.
  position integer not null,
  version integer not null,
  status text not null,
  job jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, id)
);

-- Spend, one row per paid call. Not tied to the project: deleting a project keeps
-- what it cost, so the month's total can't be reset by deleting projects.
create table app.usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null,
  call text not null,
  model text,
  usage jsonb,
  cost_usd numeric(12, 6) not null check (cost_usd >= 0),
  container_sec numeric(12, 3) check (container_sec >= 0),
  at timestamptz not null default now()
);
create index usage_user_at on app.usage (user_id, at);
create index usage_project_call on app.usage (project_id, call);

-- Idempotency keys, per user, kept 24 h (swept on claim).
create table app.idempotency_keys (
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null,
  request_hash text not null,
  status text not null check (status in ('running', 'done')),
  response_status integer,
  response_headers jsonb,
  response_body bytea,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- Per-user settings only an admin changes. `monthly_cap_usd` null is the default cap
-- (DEFAULT_MONTHLY_CAP_USD in packages/schema).
create table app.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'user' check (role in ('user', 'admin')),
  monthly_cap_usd numeric(10, 2) check (monthly_cap_usd >= 0)
);

create function app.create_profile() returns trigger
language plpgsql security definer set search_path = ''
as $$ begin insert into app.profiles (user_id) values (new.id) on conflict do nothing; return new; end $$;
create trigger create_profile after insert on auth.users for each row execute function app.create_profile();

-- The chess sound bank, one for every user; files are `sounds/<id>.<ext>` in R2.
create table app.sounds (
  id text primary key,
  ext text not null,
  duration_sec numeric(8, 3) not null check (duration_sec > 0)
);

-- Row level security: every table, owner only.

alter table app.project_ids enable row level security;
alter table app.projects enable row level security;
alter table app.project_versions enable row level security;
alter table app.stage_cache enable row level security;
alter table app.uploads enable row level security;
alter table app.jobs enable row level security;
alter table app.renders enable row level security;
alter table app.usage enable row level security;
alter table app.idempotency_keys enable row level security;
alter table app.profiles enable row level security;
alter table app.sounds enable row level security;

create policy own on app.project_ids for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

create policy own on app.projects for all to authenticated
  using (app.owns_project(id)) with check (app.owns_project(id));
create policy own on app.project_versions for all to authenticated
  using (app.owns_project(project_id)) with check (app.owns_project(project_id));
create policy own on app.stage_cache for all to authenticated
  using (app.owns_project(project_id)) with check (app.owns_project(project_id));
create policy own on app.uploads for all to authenticated
  using (app.owns_project(project_id)) with check (app.owns_project(project_id));
create policy own on app.renders for all to authenticated
  using (app.owns_project(project_id)) with check (app.owns_project(project_id));
create policy own on app.jobs for all to authenticated
  using (owner_id = (select auth.uid()) and app.owns_project(project_id))
  with check (owner_id = (select auth.uid()) and app.owns_project(project_id));

-- Users read their spend and add to it (editor calls), never change or remove it.
create policy own_read on app.usage for select to authenticated using (user_id = (select auth.uid()));
create policy own_add on app.usage for insert to authenticated with check (user_id = (select auth.uid()));

create policy own on app.idempotency_keys for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- A user reads their own profile; caps and roles change only outside RLS.
create policy own_read on app.profiles for select to authenticated using (user_id = (select auth.uid()));

create policy everyone_reads on app.sounds for select to authenticated using (true);

grant select, insert, update, delete on
  app.project_ids, app.projects, app.project_versions, app.stage_cache, app.uploads,
  app.jobs, app.renders, app.idempotency_keys
  to authenticated;
grant select, insert on app.usage to authenticated;
grant select on app.profiles, app.sounds to authenticated;

-- Live job updates: a private broadcast channel per user, `user:<uid>`. Users only
-- receive; the Worker sends through the REST API with the secret key.
create policy "own user channel" on realtime.messages for select to authenticated
  using (
    (select realtime.topic()) = 'user:' || (select auth.uid())::text
    and realtime.messages.extension in ('broadcast')
  );
